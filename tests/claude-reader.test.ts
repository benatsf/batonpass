import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudeReader } from '../src/readers/claude.ts';
import { writeSession, type ScriptSession } from '../src/script.ts';
import type { BatonEvent } from '../src/types.ts';

const session: ScriptSession = {
  tool: 'claude',
  id: '65c508aa-8a97-4dd7-b6e2-42e903a7ea5c',
  cwd: '/work/web',
  title: 'Edge cleanup',
  pr: { number: 51, repo: 'acme/web', url: 'https://github.com/acme/web/pull/51' },
  compactAfterTurn: 1,
  turns: [
    { at: '2026-09-26T12:00:00.000Z', user: 'Retire the unused functions.', reply: 'Seven functions now return 410.', tools: [{ name: 'Bash', input: 'curl -s https://x', output: 'SECRET TOOL OUTPUT' }] },
    { at: '2026-09-26T13:00:00.000Z', user: 'Merge the PR.', reply: 'PR #51 is merged.' },
  ],
};

function readAll(root: string): BatonEvent[] {
  const reader = createClaudeReader(join(root, '.claude', 'projects'));
  const events: BatonEvent[] = [];
  for (const file of reader.discover()) {
    const state = reader.initialState(file);
    for (const text of readFileSync(file.path, 'utf8').split('\n')) if (text) events.push(...reader.parse(text, state));
  }
  return events;
}

test('emits real prompts and assistant text, not meta lines, tool results or injected context', () => {
  const root = mkdtempSync(join(tmpdir(), 'baton-claude-'));
  writeSession(root, session);
  const events = readAll(root);
  assert.deepEqual(events.filter((e) => e.kind === 'user').map((e) => e.text), ['Retire the unused functions.', 'Merge the PR.']);
  assert.deepEqual(
    events.filter((e) => e.kind === 'assistant').map((e) => e.text),
    ['Checking that now.', 'Seven functions now return 410.', 'Checking that now.', 'PR #51 is merged.'],
  );
  assert.ok(events.some((e) => e.kind === 'tool_call' && e.text.startsWith('Bash ')));
  assert.ok(!JSON.stringify(events).includes('SECRET TOOL OUTPUT'));
  assert.ok(!JSON.stringify(events).includes('Base directory for this skill'));
  assert.ok(!JSON.stringify(events).includes('<baton-context'));
});

test('emits titles, PR links and compaction summaries', () => {
  const root = mkdtempSync(join(tmpdir(), 'baton-claude-'));
  writeSession(root, session);
  const events = readAll(root);
  assert.deepEqual(events.filter((e) => e.kind === 'title').map((e) => e.text), ['Edge cleanup']);
  const pr = events.find((e) => e.kind === 'pr');
  assert.equal(pr?.text, '#51 acme/web');
  assert.equal(pr?.meta.url, 'https://github.com/acme/web/pull/51');
  assert.deepEqual(events.filter((e) => e.kind === 'compaction').map((e) => e.text), ['Summary: work so far.']);
  assert.ok(events.every((e) => e.sessionId === session.id && e.tool === 'claude'));
});

test('follows relocation and per-line cwd, skips sidechains and slash-command echoes', () => {
  const reader = createClaudeReader('/nonexistent');
  const state = { sessionId: 's1', cwd: null };
  const moved = reader.parse(JSON.stringify({ type: 'relocated', relocatedCwd: '/work/api', sessionId: 's1' }), state);
  assert.deepEqual(moved.map((e) => [e.kind, e.text]), [['cwd_change', '/work/api']]);
  assert.equal(state.cwd, '/work/api');
  const side = reader.parse(JSON.stringify({ type: 'user', isSidechain: true, sessionId: 's1', cwd: '/w', timestamp: '2026-09-26T00:00:00Z', message: { content: 'sub task' } }), state);
  assert.deepEqual(side, []);
  const slash = reader.parse(JSON.stringify({ type: 'user', sessionId: 's1', cwd: '/w', timestamp: '2026-09-26T00:00:00Z', message: { content: '<command-name>/mcp</command-name>' } }), state);
  assert.deepEqual(slash, []);
});
