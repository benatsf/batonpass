import { basename } from 'node:path';
import { staleSeconds, type Context } from './context.ts';
import { ingest } from './ingest.ts';
import { DELIVERY_MAX_CHARS, MESSAGE_FRAME_CHARS, renderMessages } from './messages.ts';
import { withStaleWarning } from './render.ts';
import { refresh } from './snapshot.ts';
import { BROWSER_TOOL_PREFIX, openPages, renderTabs } from './tabs.ts';

export type HookTool = 'codex' | 'claude';

export interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  source?: string;
  /** Stop: the agent is already continuing because a Stop hook blocked it. */
  stop_hook_active?: boolean;
  /** Both tools set this on events that fire inside a subagent. */
  agent_id?: string;
}

export type HookEvent = 'session-start' | 'user-prompt-submit' | 'post-tool-use' | 'stop' | 'pre-compact';

export interface HookOptions {
  /**
   * Stop does two things: the refresh (slow, run detached by the CLI) and message delivery
   * (fast, its output goes back to the tool). Default both.
   */
  stop?: 'refresh' | 'deliver' | 'both';
}

const EVENTS: Record<string, HookEvent> = {
  'session-start': 'session-start',
  sessionstart: 'session-start',
  'user-prompt-submit': 'user-prompt-submit',
  userpromptsubmit: 'user-prompt-submit',
  'post-tool-use': 'post-tool-use',
  posttooluse: 'post-tool-use',
  stop: 'stop',
  'pre-compact': 'pre-compact',
  precompact: 'pre-compact',
};

export function normalizeEvent(event: string): HookEvent | null {
  return EVENTS[event.toLowerCase()] ?? null;
}

function parseInput(stdin: string): HookInput {
  const value = JSON.parse(stdin || '{}') as unknown;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('hook input is not an object');
  return value as HookInput;
}

/** Browser pages older than this are not offered back to a resumed session. */
const TAB_LOOKBACK_MS = 14 * 86_400_000;

/** The pages a resumed Claude Code session had open in Claude desktop's browser, which closed them. */
function browserTabs(ctx: Context, projectId: string, input: HookInput): string {
  // A turn cut short by an account switch never reached Stop: read what it added, if this file is known.
  if (input.transcript_path && ctx.ledger.getSource(input.transcript_path)) {
    try {
      ingest(ctx, { onlyPaths: [input.transcript_path] });
    } catch {
      // The pages recorded so far are still worth offering.
    }
  }
  const since = new Date((ctx.now ?? (() => new Date()))().getTime() - TAB_LOOKBACK_MS).toISOString();
  const pages = openPages(ctx.ledger.toolCalls(projectId, 'claude', input.session_id!, BROWSER_TOOL_PREFIX, since));
  return pages.length ? renderTabs(pages) : '';
}

function sessionStart(ctx: Context, tool: HookTool, input: HookInput): string {
  if (ctx.env.BATON_SKIP_INJECT === '1' || !input.cwd) return '';
  const project = ctx.resolve(input.cwd);
  const parts: string[] = [];
  const snapshot = ctx.ledger.latestSnapshot(project.id);
  if (snapshot) {
    const lag = staleSeconds(ctx, project.id, snapshot.createdAt);
    parts.push(lag > ctx.config.render.staleAfterSeconds ? withStaleWarning(snapshot.brief, lag) : snapshot.brief);
  }
  if (tool === 'claude' && input.source === 'resume' && input.session_id) {
    const tabs = browserTabs(ctx, project.id, input);
    if (tabs) parts.push(tabs);
  }
  if (!parts.length) return '';
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: parts.join('\n\n') } });
}

/** Hooks time out after 5 s: give up on a busy ledger well before, and deliver at the next boundary. */
const CLAIM_BUSY_TIMEOUT_MS = 1500;

/** Claims this tool's pending messages for the project and frames them; each message is claimed once. */
function takeMessages(ctx: Context, tool: HookTool, event: HookEvent, input: HookInput): string | null {
  if (!input.cwd) return null;
  const now = (ctx.now ?? (() => new Date()))();
  const since = new Date(now.getTime() - ctx.config.messages.maxAgeHours * 3_600_000).toISOString();
  // Most hook runs find nothing for this tool: answer that from one indexed query, before running git.
  if (!ctx.ledger.hasPendingMessages(tool, since)) return null;
  const project = ctx.resolve(input.cwd);
  ctx.ledger.db.exec(`PRAGMA busy_timeout = ${CLAIM_BUSY_TIMEOUT_MS}`);
  // Claim and render in one transaction: if rendering fails, the claim rolls back and the message stays pending.
  const delivered = ctx.ledger.transaction(() => {
    const messages = ctx.ledger.claimMessages(project.id, tool, `${tool}:${event}`, now.toISOString(), {
      since,
      maxChars: DELIVERY_MAX_CHARS,
      perMessage: MESSAGE_FRAME_CHARS,
    });
    return messages.length ? { count: messages.length, text: renderMessages(messages, tool, ctx.config.render.timeZone) } : null;
  });
  if (!delivered) return null;
  try {
    ctx.log('deliver', { tool, event, messages: delivered.count });
  } catch {
    // The messages are claimed: they must reach the output even if the log cannot be written.
  }
  return delivered.text;
}

const STOP_NOTE = 'This arrived as you were finishing your turn. Take it into account if it bears on what the user asked, then finish.';

function deliver(ctx: Context, tool: HookTool, event: HookEvent, input: HookInput): string {
  // A subagent would read the message instead of the agent the user is talking to.
  if (input.agent_id) return '';
  // At most one forced continuation per turn, so two agents can never keep each other running.
  if (event === 'stop' && input.stop_hook_active) return '';
  const text = takeMessages(ctx, tool, event, input);
  if (!text) return '';
  if (event === 'stop') return JSON.stringify({ decision: 'block', reason: `${text}\n${STOP_NOTE}` });
  const hookEventName = event === 'user-prompt-submit' ? 'UserPromptSubmit' : 'PostToolUse';
  return JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: text } });
}

async function stop(ctx: Context, input: HookInput): Promise<void> {
  if (!input.cwd) return;
  const project = ctx.resolve(input.cwd);
  // Ingest every changed transcript, not only this project's known ones: a session whose own
  // Stop never ran (hooks not yet trusted, app closed) is still picked up. Unchanged files cost a stat.
  const result = await refresh(ctx, { projectId: project.id, root: project.root, ingest: {} });
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

export async function runHook(event: string, tool: HookTool, stdin: string, makeContext: () => Context, options: HookOptions = {}): Promise<string> {
  let ctx: Context | null = null;
  try {
    const name = normalizeEvent(event);
    const input = parseInput(stdin);
    if (!name) return '';
    ctx = makeContext();
    if (ctx.env.BATON_HOOK === '1') return '';
    if (name === 'session-start') return sessionStart(ctx, tool, input);
    if (name === 'pre-compact') {
      preCompact(ctx, tool, input);
      return '';
    }
    if (name === 'stop') {
      const phase = options.stop ?? 'both';
      if (phase !== 'deliver') await stop(ctx, input);
      if (phase === 'refresh') return '';
    }
    return deliver(ctx, tool, name, input);
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
