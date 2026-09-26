import { basename } from 'node:path';
import { staleSeconds, type Context } from './context.ts';
import { ingest } from './ingest.ts';
import { withStaleWarning } from './render.ts';
import { refresh } from './snapshot.ts';

export type HookTool = 'codex' | 'claude';

export interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  source?: string;
}

const EVENTS: Record<string, 'session-start' | 'stop' | 'pre-compact'> = {
  'session-start': 'session-start',
  sessionstart: 'session-start',
  stop: 'stop',
  'pre-compact': 'pre-compact',
  precompact: 'pre-compact',
};

export function normalizeEvent(event: string): 'session-start' | 'stop' | 'pre-compact' | null {
  return EVENTS[event.toLowerCase()] ?? null;
}

function parseInput(stdin: string): HookInput {
  const value = JSON.parse(stdin || '{}') as unknown;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('hook input is not an object');
  return value as HookInput;
}

function sessionStart(ctx: Context, input: HookInput): string {
  if (ctx.env.BATON_SKIP_INJECT === '1' || !input.cwd) return '';
  const project = ctx.resolve(input.cwd);
  const snapshot = ctx.ledger.latestSnapshot(project.id);
  if (!snapshot) return '';
  const lag = staleSeconds(ctx, project.id, snapshot.createdAt);
  const brief = lag > ctx.config.render.staleAfterSeconds ? withStaleWarning(snapshot.brief, lag) : snapshot.brief;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: brief } });
}

async function stop(ctx: Context, input: HookInput): Promise<void> {
  if (!input.cwd) return;
  const project = ctx.resolve(input.cwd);
  const paths = new Set(ctx.ledger.sourcePathsForProject(project.id));
  if (input.transcript_path) paths.add(input.transcript_path);
  const result = await refresh(ctx, { projectId: project.id, root: project.root, ingest: { onlyPaths: [...paths] } });
  ctx.log('stop', {
    status: result.status,
    seq: result.seq,
    files: result.ingest?.files ?? 0,
    events: result.ingest?.events ?? 0,
    skippedLong: result.ingest?.skippedLong ?? 0,
    parseErrors: result.ingest?.parseErrors ?? 0,
  });
}

function preCompact(ctx: Context, tool: HookTool, input: HookInput): void {
  let paths = input.transcript_path ? [input.transcript_path] : [];
  if (!paths.length && input.session_id) {
    const id = input.session_id;
    const reader = ctx.readers.find((r) => r.tool === tool);
    paths = reader ? reader.discover().filter((f) => basename(f.path).includes(id)).map((f) => f.path) : [];
  }
  if (!paths.length) return;
  const report = ingest(ctx, { onlyPaths: paths });
  ctx.log('pre-compact', { files: report.files, events: report.events, skippedLong: report.skippedLong, parseErrors: report.parseErrors });
}

export async function runHook(event: string, tool: HookTool, stdin: string, makeContext: () => Context): Promise<string> {
  let ctx: Context | null = null;
  try {
    const name = normalizeEvent(event);
    const input = parseInput(stdin);
    if (!name) return '';
    ctx = makeContext();
    if (ctx.env.BATON_HOOK === '1') return '';
    if (name === 'session-start') return sessionStart(ctx, input);
    if (name === 'stop') await stop(ctx, input);
    else preCompact(ctx, tool, input);
    return '';
  } catch (error) {
    try {
      ctx?.log('hook-error', { event, tool, error: error instanceof Error ? error.name : 'Unknown' });
    } catch {
      // Logging must never fail a session either.
    }
    return '';
  } finally {
    ctx?.close();
  }
}
