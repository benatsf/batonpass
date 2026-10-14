import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { allFolders, readCopies, strings, tombstones, type DesktopPaths } from './desktop.ts';

/**
 * `baton desktop purge`: removes the conversation files of sessions deleted in Claude desktop.
 *
 * While another account still lists a session, Claude keeps its transcript when you delete it, and
 * batonpass then hides the other copies instead of deleting them. So a deleted session's files stay
 * on disk. A transcript is purged only when Claude marked it deleted (a `deleted_<id>` file) and no
 * record in any account still claims it, it is not running and it has not been written for a while.
 */

export interface PurgeItem {
  id: string;
  title: string;
  /** Transcript, its folder (subagents, tool results), Claude's markers, batonpass's hidden copies. */
  files: string[];
  bytes: number;
}

export interface PurgePlan {
  items: PurgeItem[];
  skipped: Array<{ id: string; title: string; reason: string }>;
  bytes: number;
}

/** A transcript written this recently may belong to a turn still running. */
const QUIET_MS = 10 * 60_000;
const MARKERS = ['.desktop-released.json', '.ccr-tip.json', '.precompact.json'];

function size(path: string): number {
  const st = lstatSync(path);
  if (!st.isDirectory()) return st.size;
  return readdirSync(path).reduce((sum, name) => sum + size(join(path, name)), 0);
}

/** Session ids of Claude Code processes still running, from `~/.claude/sessions/<pid>.json`. */
export function liveSessionIds(paths: DesktopPaths): Set<string> {
  const live = new Set<string>();
  let names: string[] = [];
  try {
    names = readdirSync(paths.liveSessions).filter((n) => /^\d+\.json$/.test(n));
  } catch {
    return live;
  }
  for (const name of names) {
    try {
      const d = JSON.parse(readFileSync(join(paths.liveSessions, name), 'utf8')) as { pid?: number; sessionId?: string };
      const pid = Number(d.pid ?? name.slice(0, -5));
      process.kill(pid, 0);
      if (typeof d.sessionId === 'string') live.add(d.sessionId);
    } catch {
      // Not running, or unreadable.
    }
  }
  return live;
}

/** Titles and files of the copies batonpass hid, by transcript id. */
function quarantined(paths: DesktopPaths): Map<string, { title: string; files: string[] }> {
  const out = new Map<string, { title: string; files: string[] }>();
  const walk = (dir: string): void => {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      if (lstatSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.json')) {
        try {
          const r = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
          for (const id of [r.cliSessionId, ...strings(r.priorCliSessionIds)]) {
            if (typeof id !== 'string') continue;
            const entry = out.get(id) ?? { title: typeof r.title === 'string' ? r.title : '', files: [] };
            entry.files.push(path);
            out.set(id, entry);
          }
        } catch {
          // Not a record.
        }
      }
    }
  };
  walk(join(paths.work, 'quarantine'));
  return out;
}

function customTitle(dir: string): string {
  try {
    const t = (JSON.parse(readFileSync(join(dir, 'custom-title.json'), 'utf8')) as { customTitle?: unknown }).customTitle;
    return typeof t === 'string' ? t : '';
  } catch {
    return '';
  }
}

export function planPurge(paths: DesktopPaths, now: number, live: Set<string> = liveSessionIds(paths)): PurgePlan {
  const folders = allFolders(paths);
  const claimed = new Set<string>();
  const deleted = new Set<string>();
  for (const folder of folders) {
    for (const { record } of readCopies(folder)) {
      for (const id of [record.cliSessionId, record.historyOnlyCliSessionId, ...strings(record.priorCliSessionIds)]) {
        if (typeof id === 'string') claimed.add(id);
      }
    }
    for (const id of tombstones(folder).keys()) deleted.add(id);
  }
  const hidden = quarantined(paths);
  const plan: PurgePlan = { items: [], skipped: [], bytes: 0 };
  let projectDirs: string[] = [];
  try {
    projectDirs = readdirSync(paths.projects).map((d) => join(paths.projects, d));
  } catch {
    return plan;
  }
  for (const dir of projectDirs) {
    for (const id of deleted) {
      const transcript = join(dir, `${id}.jsonl`);
      if (!existsSync(transcript)) continue;
      const sidecar = join(dir, id);
      const title = hidden.get(id)?.title || customTitle(sidecar) || id;
      if (claimed.has(id)) continue; // Still listed in some account: not deleted everywhere.
      if (live.has(id)) {
        plan.skipped.push({ id, title, reason: 'running' });
        continue;
      }
      if (now - statSync(transcript).mtimeMs < QUIET_MS) {
        plan.skipped.push({ id, title, reason: 'written in the last ten minutes' });
        continue;
      }
      const files = [transcript, ...(existsSync(sidecar) ? [sidecar] : []), ...MARKERS.map((m) => join(dir, `${id}${m}`)).filter((p) => existsSync(p)), ...(hidden.get(id)?.files ?? [])];
      const bytes = files.reduce((sum, f) => sum + size(f), 0);
      plan.items.push({ id, title, files, bytes });
      plan.bytes += bytes;
    }
  }
  plan.items.sort((a, b) => b.bytes - a.bytes);
  return plan;
}

/** Deletes the planned files, refusing anything outside the transcripts and batonpass's quarantine. */
export function applyPurge(paths: DesktopPaths, plan: PurgePlan): { removed: number; bytes: number } {
  const inside = (root: string, path: string) => {
    const rel = relative(root, path);
    return rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep);
  };
  let removed = 0;
  for (const item of plan.items) {
    for (const file of item.files) {
      if (!inside(paths.projects, file) && !inside(join(paths.work, 'quarantine'), file)) throw new Error(`refusing to remove ${file}`);
    }
    for (const file of item.files) rmSync(file, { recursive: true, force: true });
    removed++;
  }
  return { removed, bytes: plan.items.slice(0, removed).reduce((sum, i) => sum + i.bytes, 0) };
}
