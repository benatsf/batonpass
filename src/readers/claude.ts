import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { BatonEvent, EventKind, ParseState, SourceFile, SourceReader } from '../types.ts';

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const IGNORED_USER_PREFIXES = ['<baton-context', '<command-', '<local-command-', '[Request interrupted'];
/** Bounds regex work on huge inputs; ingest redacts, then shortens to 300 characters. */
const capInput = (value: string) => (value.length > 65_536 ? value.slice(0, 65_536) : value);

function blocks(content: unknown): Json[] {
  return Array.isArray(content) ? content.filter(isObject) : [];
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  return blocks(content)
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n');
}

export function createClaudeReader(projectsDir: string): SourceReader {
  return {
    tool: 'claude',
    discover(): SourceFile[] {
      if (!existsSync(projectsDir)) return [];
      const files: SourceFile[] = [];
      for (const dir of readdirSync(projectsDir, { withFileTypes: true })) {
        if (!dir.isDirectory()) continue;
        const folder = join(projectsDir, dir.name);
        for (const entry of readdirSync(folder, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
          const path = join(folder, entry.name);
          const st = statSync(path);
          files.push({ path, tool: 'claude', size: st.size, mtimeMs: st.mtimeMs, inode: st.ino });
        }
      }
      return files.sort((a, b) => a.mtimeMs - b.mtimeMs);
    },
    initialState(file: SourceFile): ParseState {
      return { sessionId: basename(file.path, '.jsonl'), cwd: null };
    },
    parse(line: string, state: ParseState): BatonEvent[] {
      const o = JSON.parse(line) as Json;
      if (o.isSidechain === true) return [];
      const sessionId = str(o.sessionId) ?? state.sessionId;
      state.sessionId = sessionId;
      if (str(o.cwd)) state.cwd = str(o.cwd)!;
      const ts = str(o.timestamp) ?? state.lastTs ?? new Date(0).toISOString();
      state.lastTs = ts;
      const event = (kind: EventKind, text: string, meta: Json = {}): BatonEvent[] => [
        { tool: 'claude', sessionId, ts, cwd: state.cwd, kind, text, meta },
      ];
      const message = isObject(o.message) ? o.message : {};

      switch (o.type) {
        case 'user': {
          if (o.isCompactSummary === true) return event('compaction', textOf(message.content).trim());
          if (o.isMeta === true || o.sourceToolUseID || o.toolUseResult !== undefined) return [];
          if (blocks(message.content).some((b) => b.type === 'tool_result')) return [];
          const text = textOf(message.content).trim();
          if (!text || IGNORED_USER_PREFIXES.some((prefix) => text.startsWith(prefix))) return [];
          return event('user', text);
        }
        case 'assistant': {
          const out: BatonEvent[] = [];
          for (const block of blocks(message.content)) {
            if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
              out.push(...event('assistant', block.text.trim()));
            } else if (block.type === 'tool_use') {
              const name = str(block.name) ?? 'tool';
              const input = isObject(block.input) ? (str(block.input.command) ?? JSON.stringify(block.input)) : '';
              out.push(...event('tool_call', capInput(`${name} ${input}`.trim()), { name }));
            }
          }
          return out;
        }
        case 'custom-title':
          return str(o.customTitle) ? event('title', str(o.customTitle)!) : [];
        case 'pr-link':
          return event('pr', `#${o.prNumber} ${str(o.prRepository) ?? ''}`.trim(), {
            number: o.prNumber,
            repository: o.prRepository,
            url: o.prUrl,
          });
        case 'relocated': {
          const cwd = str(o.relocatedCwd);
          if (!cwd) return [];
          state.cwd = cwd;
          return event('cwd_change', cwd);
        }
        case 'summary':
          return str(o.summary) ? event('compaction', str(o.summary)!) : [];
        case 'cost-state':
          return event('usage', '', { costUSD: o.totalCostUSD });
        default:
          return [];
      }
    },
  };
}
