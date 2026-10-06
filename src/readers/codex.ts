import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readHeadLine } from './lines.ts';
import type { BatonEvent, EventKind, ParseState, SourceFile, SourceReader } from '../types.ts';

const ROLLOUT = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[^/]*\.jsonl$/;
const WRAPPED_PREFIXES = [
  '<environment_context',
  '# AGENTS.md',
  '<user_instructions',
  '<skill',
  '<subagent',
  '<recommended_plugins',
  '<codex_internal_context',
  '<turn_aborted',
  '<baton-context',
  // A Stop hook's block reason, fed back to the model as a user message.
  '<hook_prompt',
];
const REQUEST_MARKER = /## My request(?: for Codex)?:\s*/;
const HEAD_LINE_BYTES = 4 * 1024 * 1024;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function walk(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (ROLLOUT.test(entry.name)) out.push(path);
  }
}

function unwrapUserText(raw: string): string | null {
  const text = raw.trim();
  if (!text || WRAPPED_PREFIXES.some((prefix) => text.startsWith(prefix))) return null;
  const marker = REQUEST_MARKER.exec(text);
  const request = marker ? text.slice(marker.index + marker[0].length).trim() : text;
  return request || null;
}

function contentText(content: unknown, type: string): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((item): item is Json => isObject(item) && item.type === type && typeof item.text === 'string')
    .map((item) => item.text as string)
    .join('\n');
}

/** Bounds regex work on huge inputs; ingest redacts, then shortens to 300 characters. */
const capInput = (value: string) => (value.length > 65_536 ? value.slice(0, 65_536) : value);

export function createCodexReader(codexHome: string): SourceReader {
  return {
    tool: 'codex',
    discover(): SourceFile[] {
      const paths: string[] = [];
      walk(join(codexHome, 'sessions'), paths);
      return paths
        .map((path) => {
          const st = statSync(path);
          return { path, tool: 'codex', size: st.size, mtimeMs: st.mtimeMs, inode: st.ino };
        })
        .sort((a, b) => a.mtimeMs - b.mtimeMs);
    },
    initialState(file: SourceFile): ParseState {
      const match = ROLLOUT.exec(basename(file.path));
      const state: ParseState = { sessionId: match?.[1] ?? basename(file.path, '.jsonl'), cwd: null };
      const head = readHeadLine(file.path, HEAD_LINE_BYTES);
      if (head) {
        try {
          this.parse(head, state);
        } catch {
          // A malformed head line leaves cwd unknown until the next turn_context.
        }
      }
      return state;
    },
    parse(line: string, state: ParseState): BatonEvent[] {
      const o = JSON.parse(line) as Json;
      const p = isObject(o.payload) ? o.payload : {};
      const ts = str(o.timestamp) ?? state.lastTs ?? new Date(0).toISOString();
      state.lastTs = ts;
      const event = (kind: EventKind, text: string, meta: Json = {}): BatonEvent[] =>
        state.skip ? [] : [{ tool: 'codex', sessionId: state.sessionId, ts, cwd: state.cwd, kind, text, meta }];

      switch (o.type) {
        case 'session_meta': {
          state.cwd = str(p.cwd) ?? state.cwd;
          state.skip = Boolean(p.parent_thread_id) || (isObject(p.source) && 'subagent' in p.source);
          return [];
        }
        case 'turn_context': {
          const cwd = str(p.cwd);
          state.model = str(p.model) ?? state.model;
          if (cwd && cwd !== state.cwd) {
            const hadCwd = state.cwd !== null;
            state.cwd = cwd;
            if (hadCwd) return event('cwd_change', cwd);
          }
          return [];
        }
        case 'response_item': {
          if (p.type === 'message' && p.role === 'user') {
            const raw = contentText(p.content, 'input_text');
            const text = unwrapUserText(raw);
            if (text) return event('user', text);
            // An image-only prompt still starts a turn, so its reply stays with it.
            const image = Array.isArray(p.content) && p.content.some((c) => isObject(c) && c.type === 'input_image');
            return image && !raw.trim() ? event('user', '[image]') : [];
          }
          if (p.type === 'function_call' || p.type === 'custom_tool_call') {
            const name = str(p.name) ?? 'tool';
            const input = str(p.arguments) ?? str(p.input) ?? '';
            return event('tool_call', capInput(`${name} ${input}`.trim()), { name });
          }
          return [];
        }
        case 'event_msg': {
          if (p.type === 'task_complete') {
            const text = str(p.last_agent_message)?.trim();
            return text ? event('final', text, { turnId: p.turn_id }) : [];
          }
          if (p.type === 'thread_goal_updated' && isObject(p.goal)) {
            const objective = str(p.goal.objective);
            return objective ? event('goal', objective, { status: p.goal.status }) : [];
          }
          if (p.type === 'token_count' && isObject(p.info)) {
            return event('usage', '', { total: p.info.total_token_usage, contextWindow: p.info.model_context_window, model: state.model });
          }
          return [];
        }
        case 'compacted':
          return event('compaction', '', { encrypted: true });
        default:
          return [];
      }
    },
    sessionTitles(): Map<string, string> {
      const titles = new Map<string, string>();
      const index = join(codexHome, 'session_index.jsonl');
      if (!existsSync(index)) return titles;
      for (const row of readFileSync(index, 'utf8').split('\n')) {
        try {
          const o = JSON.parse(row) as Json;
          const id = str(o.id);
          const name = str(o.thread_name);
          if (id && name) titles.set(id, name);
        } catch {
          // Skip malformed index rows.
        }
      }
      return titles;
    },
  };
}
