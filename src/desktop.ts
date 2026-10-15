import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, constants, cpSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
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
  /** `{ "flatSidebar": true }` while sessions are shown flat (`baton desktop flat on`). */
  options: string;
  /** Sessions batonpass detached from their parent, so `flat off` can attach them again. */
  detached: string;
  /** Claude Code's `<pid>.json` files for running sessions. */
  liveSessions: string;
  /** How far each log file was read, so a sync reads only the lines Claude added since. */
  logMarks: string;
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
  /** With Claude quit, no folder is held in memory and every one can be changed. */
  running: boolean;
}

export type Action =
  | { kind: 'create' | 'update' | 'detach' | 'attach'; folder: Folder; sessionId: string; title: string; record: Record<string, unknown>; mtimeMs: number; expectMtimeMs?: number; detaches?: boolean }
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
  /** Sessions batonpass no longer needs to remember as detached (flat sidebar turned off and undone). */
  reattached: string[];
}

export interface SyncResult {
  created: number;
  updated: number;
  quarantined: number;
  detached: number;
  attached: number;
  raced: number;
}

export interface SyncOptions {
  /** Show every session at the top level instead of nested under the session it came from. */
  flat: boolean;
  /** Sessions batonpass detached earlier. */
  detached: Set<string>;
  running: boolean;
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
  'interruptedAwaitingPerson', 'lastTurnCutShort', 'pendingSystemReminder',
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
    options: join(batonHome, 'desktop-sync', 'options.json'),
    detached: join(batonHome, 'desktop-sync', 'detached.json'),
    liveSessions: join(home, '.claude', 'sessions'),
    logMarks: join(batonHome, 'desktop-sync', 'log-marks.json'),
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

const NEEDLE = Buffer.from('Initialization succeeded');
/** Bytes before a mark that must be unchanged for the mark to apply: guards against a log rewritten in place. */
const MARK_TAIL = 256;

/** Where a log file was read up to (just after a newline) and the loads found before that point. */
interface LogMark {
  ino: number;
  offset: number;
  tail: string;
  inits: Init[];
}

function readRange(path: string, from: number, to: number): Buffer | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY);
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(Math.max(0, to - from));
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, from + got);
      if (!n) break;
      got += n;
    }
    return buf.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

function scanInits(buf: Buffer, into: Init[]): void {
  for (let start = buf.indexOf(NEEDLE); start !== -1; start = buf.indexOf(NEEDLE, start + 1)) {
    const from = buf.lastIndexOf(0x0a, start) + 1;
    const to = buf.indexOf(0x0a, start);
    const match = INIT.exec(buf.toString('utf8', from, to === -1 ? buf.length : to));
    if (match) into.push({ at: new Date(`${match[1]}T${match[2]}`).getTime(), account: match[3]!, org: match[4]! });
  }
}

function readMarks(file: string): LogMark[] {
  try {
    const marks = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return Array.isArray(marks) ? (marks as LogMark[]) : [];
  } catch {
    return [];
  }
}

function writeMarks(file: string, marks: LogMark[]): void {
  try {
    mkdirSync(join(file, '..'), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(marks));
    renameSync(tmp, file);
  } catch {
    // Only an optimisation: the next run reads the logs in full.
  }
}

/**
 * Claude's sidebar loads, from its main log. With `marksFile`, each file is read only from where
 * the previous run stopped; marks follow a file by inode, so they survive Claude's log rotation.
 */
export function readInits(logs: string[], marksFile?: string): Init[] {
  const known = marksFile ? readMarks(marksFile) : [];
  const marks: LogMark[] = [];
  const inits: Init[] = [];
  for (const path of logs) {
    let size: number;
    let ino: number;
    try {
      ({ size, ino } = statSync(path));
    } catch {
      continue;
    }
    const mark = known.find((m) => m.ino === ino && m.offset <= size);
    const tail = mark ? readRange(path, Math.max(0, mark.offset - MARK_TAIL), mark.offset)?.toString('latin1') : undefined;
    const start = mark && tail === mark.tail ? mark.offset : 0;
    const found = start ? [...mark!.inits] : [];
    const buf = readRange(path, start, size);
    if (!buf) continue;
    // Complete lines are remembered; a line still being written is read again next time.
    const end = buf.lastIndexOf(0x0a) + 1;
    scanInits(buf.subarray(0, end), found);
    const offset = start + end;
    marks.push({ ino, offset, tail: readRange(path, Math.max(0, offset - MARK_TAIL), offset)?.toString('latin1') ?? '', inits: found });
    inits.push(...found);
    scanInits(buf.subarray(end), inits);
  }
  if (marksFile) writeMarks(marksFile, marks);
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
export function discover(paths: DesktopPaths, now: number, running = true): Layout {
  const inits = readInits(paths.logs, paths.logMarks);
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
  return { folders, active, settling: Boolean(last && now - last.at < SETTLE_MS), running };
}

/** Every real account/org folder, whether or not Claude has loaded it. */
export function allFolders(paths: DesktopPaths): Folder[] {
  return realDirs(paths.store).flatMap((account) =>
    realDirs(join(paths.store, account)).map((org) => ({ account, org, path: join(paths.store, account, org) })),
  );
}

export interface Copy {
  folder: Folder;
  file: string;
  mtimeMs: number;
  record: Record<string, unknown>;
}

export function readCopies(folder: Folder): Copy[] {
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
export function tombstones(folder: Folder): Map<string, number> {
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

export const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);
/**
 * The folder Claude has loaded is only added to. When the log does not say which one it is, none is
 * changed. With Claude quit, nothing is loaded.
 */
const loaded = (layout: Layout, f: Folder) =>
  layout.running && (layout.active ? layout.active.account === f.account && layout.active.org === f.org : true);

/** The session this one was started from or forked from, which Claude desktop 2.37+ nests it under. */
function parentOf(record: Record<string, unknown>): string | null {
  const spawned = record.spawnedFrom as { sessionId?: unknown } | undefined;
  const parent = typeof spawned?.sessionId === 'string' ? spawned.sessionId : record.forkedFromSessionId;
  return typeof parent === 'string' && parent !== record.sessionId ? parent : null;
}

/**
 * `lineageDetached` is Claude's own flag for a session cut loose from its parent (it sets it when a
 * parent is deleted): the session then shows at the top level. Flat mode sets it on every child;
 * turning flat mode off removes it again from the sessions batonpass detached.
 */
function shaped(record: Record<string, unknown>, options: SyncOptions): Record<string, unknown> {
  if (options.flat) return parentOf(record) && record.lineageDetached !== true ? { ...record, lineageDetached: true } : record;
  if (record.lineageDetached === true && options.detached.has(String(record.sessionId))) {
    const { lineageDetached: _, ...rest } = record;
    return rest;
  }
  return record;
}
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function ineligible(record: Record<string, unknown>, known: Map<string, number>): string | null {
  const cli = record.cliSessionId;
  if (typeof cli !== 'string' || !cli) return 'no transcript id';
  if (!known.has(cli)) return 'transcript missing';
  if (record.sshConfig || record.wslConfig || record.movedToCloud) return 'not a local session';
  return null;
}

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
};

const readDetached = (paths: DesktopPaths) => new Set(strings((readJson(paths.detached) as { sessions?: unknown } | null)?.sessions));

export function readOptions(paths: DesktopPaths): SyncOptions {
  const options = readJson(paths.options) as { flatSidebar?: unknown } | null;
  return { flat: options?.flatSidebar === true, detached: readDetached(paths), running: claudeRunning() };
}

export function claudeRunning(): boolean {
  const ps = spawnSync('ps', ['-axo', 'comm'], { encoding: 'utf8' });
  // If ps fails, assume Claude runs: that only makes the sync more careful.
  return ps.status !== 0 || ps.stdout.split('\n').some((line) => line.trim().endsWith('/Claude.app/Contents/MacOS/Claude'));
}

export function planSync(paths: DesktopPaths, now: number, options: SyncOptions = readOptions(paths)): SyncPlan {
  const layout = discover(paths, now, options.running);
  const plan: SyncPlan = { layout, sessions: 0, actions: [], skipped: [], reattached: [] };
  if (layout.settling) return plan;
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

    const cli = typeof newest.record.cliSessionId === 'string' ? known.get(newest.record.cliSessionId) : undefined;
    const busy = cli !== undefined && now - cli < BUSY_MS;
    const planned = new Set<string>();
    const reason = ineligible(newest.record, known);
    if (reason) plan.skipped.push({ sessionId, title, reason });
    const worktree = newest.record.worktreePath;
    const worktreeGone = typeof worktree === 'string' && worktree !== '' && !existsSync(worktree);
    const base = portable(newest.record);
    const shared = shaped(base, options);
    // Only flags batonpass sets are remembered: Claude detaches a session itself when its parent is deleted.
    const sharedDetaches = options.flat && shared !== base;
    for (const folder of reason ? [] : layout.folders) {
      if (folder.path === newest.folder.path) continue;
      const existing = copies.find((c) => c.folder.path === folder.path);
      if (!existing) {
        if (busy || worktreeGone) continue;
        plan.actions.push({ kind: 'create', folder, sessionId, title, record: shared, mtimeMs: newest.mtimeMs, detaches: sharedDetaches });
        continue;
      }
      if (existing.mtimeMs >= newest.mtimeMs || loaded(layout, folder)) continue;
      if (now - existing.mtimeMs < RECENT_SAVE_MS) continue;
      const own = Object.fromEntries(Object.entries(existing.record).filter(([key]) => isAccountField(key)));
      const merged = shaped({ ...shared, ...own }, options);
      if (sameJson(merged, existing.record)) continue;
      planned.add(folder.path);
      const detaches = sharedDetaches || (options.flat && merged.lineageDetached === true && existing.record.lineageDetached !== true);
      plan.actions.push({ kind: 'update', folder, sessionId, title, record: merged, mtimeMs: newest.mtimeMs, expectMtimeMs: existing.mtimeMs, detaches });
    }
    if (!reason && busy) plan.skipped.push({ sessionId, title, reason: 'in use; copied once idle for a minute' });
    else if (!reason && worktreeGone) plan.skipped.push({ sessionId, title, reason: 'worktree no longer exists' });

    // Flat sidebar: detach (or, after `flat off`, re-attach) each copy in place, keeping its time. This
    // one flag is also set in the folder Claude has loaded: Claude reads the folder only when it starts
    // or switches account, so the change shows at the next restart, and an idle record is not saved
    // again from memory. If Claude does save it, its version wins and a later run sets the flag again.
    let stillDetached = false;
    for (const copy of copies) {
      const want = shaped(copy.record, options);
      if (want === copy.record) continue;
      if (planned.has(copy.folder.path) || busy || now - copy.mtimeMs < RECENT_SAVE_MS) {
        stillDetached ||= !options.flat;
        continue;
      }
      const kind = options.flat ? 'detach' : 'attach';
      plan.actions.push({ kind, folder: copy.folder, sessionId, title, record: want, mtimeMs: copy.mtimeMs, expectMtimeMs: copy.mtimeMs });
    }
    if (!options.flat && options.detached.has(sessionId) && !stillDetached) plan.reattached.push(sessionId);
  }
  return plan;
}

function assertRealDir(path: string): void {
  if (!isRealDir(path)) throw new Error(`${path} is not a plain directory`);
}

/** Write next to the target and rename into place, so Claude never reads a partial record. */
function writeRecord(action: Exclude<Action, { kind: 'quarantine' }>): boolean {
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
  const result: SyncResult = { created: 0, updated: 0, quarantined: 0, detached: 0, attached: 0, raced: 0 };
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const detached = readDetached(paths);
  for (const action of plan.actions) {
    const done = action.kind === 'quarantine' ? quarantine(action, paths.work, stamp) : writeRecord(action);
    if (!done) {
      result.raced++;
      continue;
    }
    if (action.kind === 'create') result.created++;
    else if (action.kind === 'update') result.updated++;
    else if (action.kind === 'quarantine') result.quarantined++;
    else if (action.kind === 'detach') result.detached++;
    else result.attached++;
    if (action.kind === 'detach' || (action.kind !== 'quarantine' && action.detaches)) detached.add(action.sessionId);
  }
  for (const id of plan.reattached) detached.delete(id);
  if (result.detached || result.created || result.updated || plan.reattached.length) {
    mkdirSync(paths.work, { recursive: true, mode: 0o700 });
    writeFileSync(paths.detached, `${JSON.stringify({ sessions: [...detached].sort() }, null, 2)}\n`, { mode: 0o600 });
  }
  return result;
}

export function writeOptions(paths: DesktopPaths, options: { flatSidebar: boolean }): void {
  mkdirSync(paths.work, { recursive: true, mode: 0o700 });
  writeFileSync(paths.options, `${JSON.stringify(options, null, 2)}\n`, { mode: 0o600 });
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

