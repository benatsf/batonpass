import { randomBytes } from 'node:crypto';
import { closeSync, constants, cpSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Keeps Claude desktop's Code-tab session list the same in every account on this Mac.
 *
 * The app files its sidebar under `claude-code-sessions/<accountUuid>/<orgUuid>/<sessionId>.json`
 * and reads only the signed-in pair, while the transcripts those records point to are shared in
 * ~/.claude/projects. The app reads a folder only when it starts or switches account, so copies
 * written into the other folders appear at the next switch. Copies drop the fields that belong to
 * the source account (connectors, Remote Control, scheduled tasks, cloud links).
 */

export interface DesktopPaths {
  store: string;
  /** Claude's main log, oldest file first. */
  logs: string[];
  projects: string;
  agent: string;
  work: string;
}

export interface Folder {
  account: string;
  org: string;
  path: string;
}

export interface Layout {
  folders: Folder[];
  /** The folder Claude loaded last; never modified, only added to. */
  active: Folder | null;
  /** Claude switched account a moment ago: wait for it to settle. */
  settling: boolean;
}

export type Action =
  | { kind: 'create' | 'update'; folder: Folder; sessionId: string; title: string; record: Record<string, unknown>; mtimeMs: number; expectMtimeMs?: number }
  | { kind: 'quarantine'; folder: Folder; sessionId: string; title: string; file: string; expectMtimeMs: number; tombstones: string[]; stamp: number };

export interface Skip {
  sessionId: string;
  title: string;
  reason: string;
}

export interface SyncPlan {
  layout: Layout;
  sessions: number;
  actions: Action[];
  skipped: Skip[];
}

export interface SyncResult {
  created: number;
  updated: number;
  quarantined: number;
  raced: number;
}

export const AGENT_LABEL = 'batonpass.desktop-sync';
const SYNC_INTERVAL_SECONDS = 60;
/** An initialisation replaced within this time was a transient state during a switch. */
const SETTLE_MS = 10_000;
/** A transcript written this recently belongs to a running turn: copy it once it is idle. */
const BUSY_MS = 60_000;
/** A record Claude saved this recently may belong to a session still running in that account. */
const RECENT_SAVE_MS = 10 * 60_000;
const MAX_RECORD_BYTES = 10 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INIT = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\b.*\[LocalSessionManager\] Initialization succeeded — accountId=([0-9a-f-]{36}), orgId=([0-9a-f-]{36})/;

/** Fields owned by the account or org that created the session, or runtime state of its process. */
const ACCOUNT_FIELDS = new Set([
  'bridgeSessionIds', 'remoteMcpServersConfig', 'enabledMcpTools', 'withheldConnectorHosts',
  'scheduledTaskId', 'scheduledRunContinued', 'spaceId', 'movedToCloud', 'envScopeId',
  'startedFromEnvironmentId', 'cloudSpawnedTasks', 'publishedArtifacts', 'emailAddress',
  'isRunning', 'armedWorkAtQuit', 'interruptedByQuitAt', 'interruptedUnseenResume', 'pendingFirstStart',
  // When present, deleting the session also deletes its transcript.
  'importedFrom',
]);
/** Fields added by a later Claude version that look account-bound are dropped too. */
const ACCOUNT_LIKE = /account|organi[sz]ation|orgid|bridge|cloud|remote|mcp|connector|email|scheduled/i;

export function desktopPaths(env: NodeJS.ProcessEnv, batonHome: string, claudeProjects: string): DesktopPaths {
  const home = env.HOME ?? homedir();
  const logDir = join(home, 'Library', 'Logs', 'Claude');
  return {
    store: join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions'),
    logs: [join(logDir, 'main1.log'), join(logDir, 'main.log')],
    projects: claudeProjects,
    agent: join(home, 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`),
    work: join(batonHome, 'desktop-sync'),
  };
}

const isAccountField = (key: string) => ACCOUNT_FIELDS.has(key) || ACCOUNT_LIKE.test(key);

/** The record as another account should see it. */
export function portable(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !isAccountField(key)));
}

function realDirs(path: string): string[] {
  try {
    return readdirSync(path).filter((name) => UUID.test(name) && isRealDir(join(path, name)));
  } catch {
    return [];
  }
}

function isRealDir(path: string): boolean {
  try {
    const st = lstatSync(path);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

interface Init {
  at: number;
  account: string;
  org: string;
}

export function readInits(logs: string[]): Init[] {
  const inits: Init[] = [];
  for (const path of logs) {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    for (let start = text.indexOf('Initialization succeeded'); start !== -1; start = text.indexOf('Initialization succeeded', start + 1)) {
      const from = text.lastIndexOf('\n', start) + 1;
      const to = text.indexOf('\n', start);
      const match = INIT.exec(text.slice(from, to === -1 ? undefined : to));
      if (match) inits.push({ at: new Date(`${match[1]}T${match[2]}`).getTime(), account: match[3]!, org: match[4]! });
    }
  }
  return inits.sort((a, b) => a.at - b.at);
}

const recordFiles = (folder: Folder) => {
  try {
    return readdirSync(folder.path).filter((name) => name.startsWith('local_') && name.endsWith('.json'));
  } catch {
    return [];
  }
};

/**
 * Which account folders are real: those holding sessions, or that Claude loaded and kept for more
 * than a moment. A switch can briefly pair the new org with the old account; that folder is skipped.
 */
export function discover(paths: DesktopPaths, now: number): Layout {
  const inits = readInits(paths.logs);
  const settled = new Set<string>();
  inits.forEach((init, i) => {
    const next = inits[i + 1];
    if ((next ? next.at : now) - init.at >= SETTLE_MS) settled.add(`${init.account}/${init.org}`);
  });
  const folders: Folder[] = [];
  for (const account of realDirs(paths.store)) {
    for (const org of realDirs(join(paths.store, account))) {
      const folder = { account, org, path: join(paths.store, account, org) };
      if (recordFiles(folder).length || settled.has(`${account}/${org}`)) folders.push(folder);
    }
  }
  const last = inits.at(-1);
  const active = last ? (folders.find((f) => f.account === last.account && f.org === last.org) ?? null) : null;
  return { folders, active, settling: Boolean(last && now - last.at < SETTLE_MS) };
}

interface Copy {
  folder: Folder;
  file: string;
  mtimeMs: number;
  record: Record<string, unknown>;
}

function readCopies(folder: Folder): Copy[] {
  const copies: Copy[] = [];
  for (const name of recordFiles(folder)) {
    const file = join(folder.path, name);
    try {
      const st = lstatSync(file);
      if (!st.isFile() || st.size > MAX_RECORD_BYTES) continue;
      const record = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      if (typeof record !== 'object' || record === null || Array.isArray(record)) continue;
      const id = (record as Record<string, unknown>).sessionId;
      if (typeof id !== 'string' || `${id}.json` !== name) continue;
      copies.push({ folder, file, mtimeMs: st.mtimeMs, record: record as Record<string, unknown> });
    } catch {
      // Claude skips records it cannot read; so do we.
    }
  }
  return copies;
}

/** `deleted_<id>` holds the deletion time in milliseconds. */
function tombstones(folder: Folder): Map<string, number> {
  const out = new Map<string, number>();
  try {
    for (const name of readdirSync(folder.path)) {
      if (!name.startsWith('deleted_')) continue;
      const file = join(folder.path, name);
      const stamp = Number(readFileSync(file, 'utf8').trim());
      out.set(name.slice('deleted_'.length), Number.isFinite(stamp) && stamp > 0 ? stamp : statSync(file).mtimeMs);
    }
  } catch {
    // Missing folder: no tombstones.
  }
  return out;
}

function transcripts(projects: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const dir of (() => { try { return readdirSync(projects); } catch { return []; } })()) {
    try {
      for (const name of readdirSync(join(projects, dir))) {
        if (name.endsWith('.jsonl')) out.set(name.slice(0, -'.jsonl'.length), statSync(join(projects, dir, name)).mtimeMs);
      }
    } catch {
      // Not a directory.
    }
  }
  return out;
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);
/** The folder Claude has loaded is only added to. When the log does not say which one it is, none is changed. */
const loaded = (layout: Layout, f: Folder) => (layout.active ? layout.active.account === f.account && layout.active.org === f.org : true);
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function ineligible(record: Record<string, unknown>, known: Map<string, number>): string | null {
  const cli = record.cliSessionId;
  if (typeof cli !== 'string' || !cli) return 'no transcript id';
  if (!known.has(cli)) return 'transcript missing';
  if (record.sshConfig || record.wslConfig || record.movedToCloud) return 'not a local session';
  return null;
}

export function planSync(paths: DesktopPaths, now: number): SyncPlan {
  const layout = discover(paths, now);
  const plan: SyncPlan = { layout, sessions: 0, actions: [], skipped: [] };
  if (layout.settling || layout.folders.length < 2) return plan;
  const known = transcripts(paths.projects);
  const graves = new Map(layout.folders.map((f) => [f.path, tombstones(f)]));
  const groups = new Map<string, Copy[]>();
  for (const folder of layout.folders) {
    for (const copy of readCopies(folder)) {
      const id = copy.record.sessionId as string;
      groups.set(id, [...(groups.get(id) ?? []), copy]);
    }
  }
  plan.sessions = groups.size;
  for (const [sessionId, copies] of groups) {
    const newest = copies.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
    const title = typeof newest.record.title === 'string' ? newest.record.title : sessionId;
    // Claude names a deleted session's tombstones after its record stem and its transcript ids.
    const stem = sessionId.replace(/^local_/, '');
    const ids = [...new Set([stem, ...copies.flatMap((c) => [String(c.record.cliSessionId ?? ''), ...strings(c.record.priorCliSessionIds)])].filter(Boolean))];
    const deletedAt = Math.max(0, ...layout.folders.flatMap((f) => ids.map((id) => graves.get(f.path)!.get(id) ?? 0)));

    if (deletedAt >= newest.mtimeMs) {
      // Deleted in one account: hide it everywhere, keeping each copy in quarantine.
      for (const copy of copies) {
        if (loaded(layout, copy.folder)) continue;
        if (now - copy.mtimeMs < RECENT_SAVE_MS) {
          plan.skipped.push({ sessionId, title, reason: 'deleted elsewhere, but saved here recently' });
          continue;
        }
        const missing = ids.filter((id) => !graves.get(copy.folder.path)!.has(id));
        plan.actions.push({ kind: 'quarantine', folder: copy.folder, sessionId, title, file: copy.file, expectMtimeMs: copy.mtimeMs, tombstones: missing, stamp: deletedAt });
      }
      continue;
    }

    const reason = ineligible(newest.record, known);
    if (reason) {
      plan.skipped.push({ sessionId, title, reason });
      continue;
    }
    const busy = now - known.get(newest.record.cliSessionId as string)! < BUSY_MS;
    const worktree = newest.record.worktreePath;
    const worktreeGone = typeof worktree === 'string' && worktree !== '' && !existsSync(worktree);
    const shared = portable(newest.record);
    for (const folder of layout.folders) {
      if (folder.path === newest.folder.path) continue;
      const existing = copies.find((c) => c.folder.path === folder.path);
      if (!existing) {
        if (busy || worktreeGone) continue;
        plan.actions.push({ kind: 'create', folder, sessionId, title, record: shared, mtimeMs: newest.mtimeMs });
        continue;
      }
      if (existing.mtimeMs >= newest.mtimeMs || loaded(layout, folder)) continue;
      if (now - existing.mtimeMs < RECENT_SAVE_MS) continue;
      const own = Object.fromEntries(Object.entries(existing.record).filter(([key]) => isAccountField(key)));
      const merged = { ...shared, ...own };
      if (sameJson(merged, existing.record)) continue;
      plan.actions.push({ kind: 'update', folder, sessionId, title, record: merged, mtimeMs: newest.mtimeMs, expectMtimeMs: existing.mtimeMs });
    }
    if (busy) plan.skipped.push({ sessionId, title, reason: 'in use; copied once idle for a minute' });
    else if (worktreeGone) plan.skipped.push({ sessionId, title, reason: 'worktree no longer exists' });
  }
  return plan;
}

function assertRealDir(path: string): void {
  if (!isRealDir(path)) throw new Error(`${path} is not a plain directory`);
}

/** Write next to the target and rename into place, so Claude never reads a partial record. */
function writeRecord(action: Extract<Action, { kind: 'create' | 'update' }>): boolean {
  assertRealDir(action.folder.path);
  const target = join(action.folder.path, `${action.sessionId}.json`);
  const tmp = join(action.folder.path, `.baton-${randomBytes(6).toString('hex')}.partial`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, `${JSON.stringify(action.record, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
  utimesSync(tmp, new Date(), new Date(action.mtimeMs));
  const current = (() => { try { return lstatSync(target).mtimeMs; } catch { return null; } })();
  // Claude wrote the file since we looked: leave its version.
  if (current !== (action.kind === 'create' ? null : action.expectMtimeMs)) {
    rmSync(tmp, { force: true });
    return false;
  }
  renameSync(tmp, target);
  return true;
}

function quarantine(action: Extract<Action, { kind: 'quarantine' }>, work: string, stamp: string): boolean {
  assertRealDir(action.folder.path);
  if ((() => { try { return lstatSync(action.file).mtimeMs; } catch { return null; } })() !== action.expectMtimeMs) return false;
  const dest = join(work, 'quarantine', stamp, action.folder.account, action.folder.org);
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  renameSync(action.file, join(dest, `${action.sessionId}.json`));
  for (const id of action.tombstones) {
    try {
      const fd = openSync(join(action.folder.path, `deleted_${id}`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      writeSync(fd, String(action.stamp));
      closeSync(fd);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  return true;
}

export function applySync(paths: DesktopPaths, plan: SyncPlan, now: Date): SyncResult {
  const result: SyncResult = { created: 0, updated: 0, quarantined: 0, raced: 0 };
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  for (const action of plan.actions) {
    const done = action.kind === 'quarantine' ? quarantine(action, paths.work, stamp) : writeRecord(action);
    if (!done) result.raced++;
    else if (action.kind === 'create') result.created++;
    else if (action.kind === 'update') result.updated++;
    else result.quarantined++;
  }
  return result;
}

/** A full copy of the session store, taken before the first sync. */
export function backupStore(paths: DesktopPaths, now: Date): string {
  const dest = join(paths.work, 'backups', now.toISOString().replace(/[:.]/g, '-'));
  mkdirSync(join(paths.work, 'backups'), { recursive: true, mode: 0o700 });
  cpSync(paths.store, dest, { recursive: true, verbatimSymlinks: true });
  return dest;
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function agentPlist(launcher: string, batonHome: string, errorLog: string): string {
  const args = [launcher, 'desktop', 'sync', '--quiet'].map((a) => `    <string>${xml(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by \`baton desktop enable\`; \`baton desktop disable\` removes it. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>BATON_HOME</key>
    <string>${xml(batonHome)}</string>
  </dict>
  <key>StartInterval</key>
  <integer>${SYNC_INTERVAL_SECONDS}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>StandardErrorPath</key>
  <string>${xml(errorLog)}</string>
</dict>
</plist>
`;
}

