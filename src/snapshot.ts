import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { BatonConfig } from './config.ts';
import { collectFacts } from './facts.ts';
import { ingest, type IngestDeps, type IngestReport } from './ingest.ts';
import type { CoverEntry, SessionRow } from './ledger.ts';
import { tryLock } from './lock.ts';
import { renderBrief, renderFull, sessionName, type PinnedItems } from './render.ts';
import { buildTurns, type SelectedTurn, type Turn } from './select/dialogue.ts';
import { selectRecent } from './select/recent.ts';
import type { RepoFacts, StoredEvent } from './types.ts';

export interface DialogueSelection {
  brief: SelectedTurn[];
  full: SelectedTurn[];
  rules: Array<{ ts: string; text: string }>;
  stats: Record<string, unknown>;
}

export interface SelectorInput {
  projectId: string;
  turns: Turn[];
  pinnedText: string;
  config: BatonConfig;
  now: Date;
}

export type Selector = (input: SelectorInput) => Promise<DialogueSelection>;

export const recentSelector: Selector = async ({ turns, config }) => ({
  brief: selectRecent(turns, config.render.briefDialogueTokens, config.render.timeZone),
  full: selectRecent(turns, config.render.fullDialogueTokens, config.render.timeZone),
  rules: [],
  stats: { strategy: 'recent-dialogue', jev: 'skipped:disabled' },
});

export interface RefreshDeps extends IngestDeps {
  select?: Selector;
  facts?: (root: string) => RepoFacts | null;
}

export interface RefreshOptions {
  projectId: string;
  root?: string | null;
  /** Transcripts to ingest first; `false` when the caller already ingested. */
  ingest?: { onlyPaths?: string[] } | false;
  /** How long a refresh that finds the lock taken keeps retrying before leaving it to the holder. */
  lockWaitMs?: number;
}

export interface RefreshResult {
  status: 'committed' | 'locked' | 'empty';
  seq: number | null;
  ingest: IngestReport | null;
}

const DAY_MS = 86_400_000;
const RECENT_SESSIONS = 4;
const DIALOGUE_KINDS = new Set(['user', 'assistant', 'final']);

export function lockPath(home: string, projectId: string): string {
  return join(home, 'locks', `${createHash('sha256').update(projectId).digest('hex').slice(0, 16)}.lock`);
}

function pinnedItems(events: StoredEvent[], sessions: SessionRow[], notes: Array<{ ts: string; text: string }>, now: Date): PinnedItems {
  const names = new Map(sessions.slice(0, RECENT_SESSIONS).map((s) => [`${s.tool}:${s.sessionId}`, sessionName(s)]));
  const goals = new Map<string, string>();
  const prs = new Map<string, { ts: string; text: string; url: string | null }>();
  for (const e of events) {
    const key = `${e.tool}:${e.sessionId}`;
    if (e.kind === 'goal' && names.has(key)) goals.set(key, e.text);
    if (e.kind === 'pr' && now.getTime() - Date.parse(e.ts) <= 14 * DAY_MS) {
      prs.set(e.text, { ts: e.ts, text: e.text, url: typeof e.meta.url === 'string' ? e.meta.url : null });
    }
  }
  return {
    notes,
    goals: [...goals].map(([key, text]) => ({ session: names.get(key)!, text })),
    prs: [...prs.values()],
    rules: [],
  };
}

export async function refresh(deps: RefreshDeps, options: RefreshOptions): Promise<RefreshResult> {
  const path = lockPath(deps.config.home, options.projectId);
  const pending = `${path}.pending`;
  let lock = tryLock(path);
  if (!lock) {
    // Leave a marker so the holder refreshes once more before releasing: this turn's
    // transcript may have grown after the holder read it.
    try {
      mkdirSync(dirname(pending), { recursive: true, mode: 0o700 });
      writeFileSync(pending, '');
    } catch {
      // Without the marker the next refresh still catches up; staleness is reported meanwhile.
    }
    const deadline = Date.now() + (options.lockWaitMs ?? 2000);
    while (!lock && Date.now() < deadline) {
      await sleep(200);
      lock = tryLock(path);
    }
    if (!lock) return { status: 'locked', seq: null, ingest: null };
    rmSync(pending, { force: true });
  }
  try {
    let result = await refreshOnce(deps, options);
    for (let round = 0; round < 3 && existsSync(pending); round++) {
      rmSync(pending, { force: true });
      result = await refreshOnce(deps, { ...options, ingest: {} });
    }
    return result;
  } finally {
    lock.release();
  }
}

async function refreshOnce(deps: RefreshDeps, options: RefreshOptions): Promise<RefreshResult> {
  const report = options.ingest === false ? null : ingest(deps, options.ingest ?? {});
  const { ledger, config } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const events = ledger.events(options.projectId);
  const sessions = ledger.sessions(options.projectId);
  const notes = ledger.notes(options.projectId);
  if (!events.length && !notes.length) return { status: 'empty', seq: null, ingest: report };

  const turns = buildTurns(events.filter((e) => DIALOGUE_KINDS.has(e.kind)));
  const pinned = pinnedItems(events, sessions, notes, now);
  const selection = await (deps.select ?? recentSelector)({
    projectId: options.projectId,
    turns,
    pinnedText: [...pinned.notes.map((n) => n.text), ...pinned.goals.map((g) => g.text)].join('\n'),
    config,
    now,
  });
  pinned.rules = selection.rules;

  const root = options.root ?? (sessions[0]?.cwd ? deps.resolve(sessions[0].cwd).root : null);
  let facts: RepoFacts | null = null;
  if (root) {
    try {
      facts = (deps.facts ?? collectFacts)(root);
    } catch {
      facts = null;
    }
  }

  const toolCalls = [...new Set(events.filter((e) => e.kind === 'tool_call').map((e) => e.text).reverse())].slice(0, 30);
  const included = new Set(selection.full.map((t) => `${t.tool}:${t.sessionId}`));
  const covers: CoverEntry[] = sessions
    .filter((s, i) => i < RECENT_SESSIONS || included.has(`${s.tool}:${s.sessionId}`))
    .map((s) => ({
      tool: s.tool,
      sessionId: s.sessionId,
      title: s.title,
      lastTs: s.lastTs,
      sourcePath: s.sourcePath,
      offset: s.sourcePath ? (ledger.getSource(s.sourcePath)?.cursor.offset ?? null) : null,
    }));
  const stats = {
    ...selection.stats,
    turns: turns.length,
    briefTurns: selection.brief.length,
    fullTurns: selection.full.length,
    abridged: selection.full.filter((t) => t.abridged).length,
  };
  const createdAt = now.toISOString();
  const base = { projectId: options.projectId, generatedAt: createdAt, timeZone: config.render.timeZone, sessions, pinned, facts, toolCalls, stats };
  const seq = ledger.commitSnapshot(options.projectId, (next) => ({
    createdAt,
    covers,
    stats,
    brief: renderBrief({ ...base, seq: next, turns: selection.brief, budgetTokens: config.render.briefTokens }),
    full: renderFull({ ...base, seq: next, turns: selection.full, budgetTokens: config.render.fullTokens }),
  }));
  ledger.prune(now, config.retention.days, config.retention.snapshots);
  return { status: 'committed', seq, ingest: report };
}
