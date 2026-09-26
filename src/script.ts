import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ScriptTurn {
  at: string;
  user: string;
  reply: string;
  tools?: Array<{ name: string; input: string; output: string }>;
  /** Codex desktop wraps prompts that mention files; the reader must unwrap them. */
  wrapWithFiles?: boolean;
}

export interface ScriptSession {
  tool: 'codex' | 'claude';
  id: string;
  cwd: string;
  title?: string;
  goal?: string;
  pr?: { number: number; repo: string; url: string };
  compactAfterTurn?: number;
  subagent?: boolean;
  turns: ScriptTurn[];
}

const later = (iso: string, seconds: number) => new Date(Date.parse(iso) + seconds * 1000).toISOString();
const line = (value: unknown) => JSON.stringify(value);

export function codexLines(s: ScriptSession): string[] {
  const start = s.turns[0]?.at ?? '2026-01-01T00:00:00.000Z';
  const out: string[] = [
    line({
      timestamp: start,
      type: 'session_meta',
      payload: {
        id: s.id,
        session_id: s.id,
        timestamp: start,
        cwd: s.cwd,
        originator: 'codex_cli_rs',
        cli_version: '0.155.0',
        source: s.subagent ? { subagent: { name: 'worker' } } : 'cli',
        ...(s.subagent ? { parent_thread_id: 'parent-thread' } : {}),
        base_instructions: { text: 'You are Codex.' },
      },
    }),
  ];
  s.turns.forEach((turn, index) => {
    const turnId = `turn-${index + 1}`;
    const userText = turn.wrapWithFiles
      ? `# Files mentioned by the user:\n\n## shot.png: /tmp/shot.png\n\n## My request for Codex:\n${turn.user}`
      : turn.user;
    out.push(line({ timestamp: turn.at, type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } }));
    if (index === 0) {
      out.push(line({
        timestamp: turn.at,
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `<environment_context>\n  <cwd>${s.cwd}</cwd>\n</environment_context>` }] },
      }));
      out.push(line({
        timestamp: turn.at,
        type: 'response_item',
        payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'developer instructions' }] },
      }));
    }
    out.push(line({ timestamp: turn.at, type: 'turn_context', payload: { turn_id: turnId, cwd: s.cwd, model: 'gpt-6-sol' } }));
    out.push(line({ timestamp: turn.at, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: userText }] } }));
    (turn.tools ?? []).forEach((tool, t) => {
      const callId = `call-${index}-${t}`;
      out.push(line({ timestamp: later(turn.at, 5 + t), type: 'response_item', payload: { type: 'custom_tool_call', name: tool.name, input: tool.input, call_id: callId, status: 'completed' } }));
      out.push(line({ timestamp: later(turn.at, 6 + t), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: callId, output: [{ type: 'input_text', text: tool.output }] } }));
    });
    const doneAt = later(turn.at, 60);
    out.push(line({ timestamp: doneAt, type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: turn.reply }] } }));
    out.push(line({ timestamp: doneAt, type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId, last_agent_message: turn.reply } }));
    out.push(line({ timestamp: doneAt, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 1000 * (index + 1) }, last_token_usage: { total_tokens: 1000 }, model_context_window: 258400 } } }));
    if (index === 0 && s.goal) {
      out.push(line({ timestamp: doneAt, type: 'event_msg', payload: { type: 'thread_goal_updated', goal: { objective: s.goal, status: 'active' } } }));
    }
    if (s.compactAfterTurn === index + 1) {
      out.push(line({ timestamp: later(doneAt, 1), type: 'compacted', payload: { message: '', replacement_history: [], encrypted_content: 'gAAAA' } }));
    }
  });
  return out;
}

export function claudeLines(s: ScriptSession): string[] {
  const out: string[] = [];
  const base = { sessionId: s.id, cwd: s.cwd, isSidechain: false, version: '2.1.283', gitBranch: 'main', userType: 'external' };
  let uuid = 0;
  const next = () => `u-${s.id}-${++uuid}`;
  s.turns.forEach((turn, index) => {
    out.push(line({ ...base, type: 'user', uuid: next(), timestamp: turn.at, origin: { kind: 'human' }, promptSource: 'sdk', message: { role: 'user', content: turn.user } }));
    if (index === 0) {
      out.push(line({ ...base, type: 'user', uuid: next(), timestamp: turn.at, isMeta: true, message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: /skills/x' }] } }));
    }
    (turn.tools ?? []).forEach((tool, t) => {
      const id = `toolu_${index}_${t}`;
      out.push(line({ ...base, type: 'assistant', uuid: next(), timestamp: later(turn.at, 5 + t), message: { role: 'assistant', content: [{ type: 'tool_use', id, name: tool.name, input: { command: tool.input } }] } }));
      out.push(line({ ...base, type: 'user', uuid: next(), timestamp: later(turn.at, 6 + t), sourceToolAssistantUUID: 'x', toolUseResult: { stdout: tool.output }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: tool.output }] } }));
    });
    out.push(line({ ...base, type: 'assistant', uuid: next(), timestamp: later(turn.at, 30), message: { role: 'assistant', content: [{ type: 'text', text: 'Checking that now.' }] } }));
    out.push(line({ ...base, type: 'assistant', uuid: next(), timestamp: later(turn.at, 60), message: { role: 'assistant', content: [{ type: 'text', text: turn.reply }] } }));
    if (s.compactAfterTurn === index + 1) {
      out.push(line({ ...base, type: 'system', subtype: 'compact_boundary', uuid: next(), timestamp: later(turn.at, 61) }));
      out.push(line({ ...base, type: 'user', uuid: next(), timestamp: later(turn.at, 61), isCompactSummary: true, message: { role: 'user', content: 'Summary: work so far.' } }));
    }
  });
  if (s.title) out.push(line({ type: 'custom-title', customTitle: s.title, sessionId: s.id }));
  if (s.pr) out.push(line({ type: 'pr-link', prNumber: s.pr.number, prRepository: s.pr.repo, prUrl: s.pr.url, sessionId: s.id, timestamp: s.turns.at(-1)?.at }));
  out.push(line({ type: 'attachment', sessionId: s.id, attachment: { type: 'hook_success', hookEvent: 'SessionStart', content: '<baton-context project="x">old</baton-context>' } }));
  return out;
}

/** Writes the session where each tool keeps it, treating `root` as $HOME. Returns the file path. */
export function writeSession(root: string, s: ScriptSession): string {
  if (s.tool === 'codex') {
    const stamp = (s.turns[0]?.at ?? '2026-01-01T00:00:00.000Z').slice(0, 19).replace(/:/g, '-');
    const [year, month, day] = stamp.slice(0, 10).split('-');
    const dir = join(root, '.codex', 'sessions', year!, month!, day!);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `rollout-${stamp}-${s.id}.jsonl`);
    writeFileSync(path, codexLines(s).join('\n') + '\n');
    if (s.title) {
      writeFileSync(join(root, '.codex', 'session_index.jsonl'), line({ id: s.id, thread_name: s.title, updated_at: stamp }) + '\n', { flag: 'a' });
    }
    return path;
  }
  const dir = join(root, '.claude', 'projects', s.cwd.replace(/[/.]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${s.id}.jsonl`);
  writeFileSync(path, claudeLines(s).join('\n') + '\n');
  return path;
}
