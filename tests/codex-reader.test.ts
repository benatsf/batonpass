import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexReader } from '../src/readers/codex.ts';
import { writeSession, type ScriptSession } from '../src/script.ts';
import type { BatonEvent } from '../src/types.ts';

const ID = '01a047e4-a867-7e41-ba95-85ce29ade72a';
const session: ScriptSession = {
  tool: 'codex',
  id: ID,
  cwd: '/work/web',
  title: 'Billing refactor',
  goal: 'Ship the billing refactor',
  compactAfterTurn: 1,
  turns: [
    { at: '2026-09-26T10:00:00.000Z', user: 'Refactor the checkout function.', reply: 'Checkout now uses the shared helper.', tools: [{ name: 'exec', input: 'npm test', output: 'SECRET TOOL OUTPUT 42 passing' }] },
    { at: '2026-09-26T11:00:00.000Z', user: 'Deploy it to staging.', reply: 'Deployed to staging.', wrapWithFiles: true },
  ],
};

function readAll(root: string): BatonEvent[] {
  const reader = createCodexReader(join(root, '.codex'));
  const events: BatonEvent[] = [];
  for (const file of reader.discover()) {
    const state = reader.initialState(file);
    for (const text of readFileSync(file.path, 'utf8').split('\n')) if (text) events.push(...reader.parse(text, state));
  }
  return events;
}

test('discovers rollouts and derives the session id from the file name', () => {
  const root = mkdtempSync(join(tmpdir(), 'baton-codex-'));
  const path = writeSession(root, session);
  const reader = createCodexReader(join(root, '.codex'));
  const files = reader.discover();
  assert.deepEqual(files.map((f) => f.path), [path]);
  const state = reader.initialState(files[0]!);
  assert.equal(state.sessionId, ID);
  assert.equal(state.cwd, '/work/web');
  assert.equal(reader.sessionTitles?.().get(ID), 'Billing refactor');
});

test('emits user prompts, finals, tool calls, goals and compactions, never tool output', () => {
  const root = mkdtempSync(join(tmpdir(), 'baton-codex-'));
  writeSession(root, session);
  const events = readAll(root);
  const kinds = events.map((e) => `${e.kind}:${e.text}`);
  assert.deepEqual(kinds.filter((k) => k.startsWith('user:')), ['user:Refactor the checkout function.', 'user:Deploy it to staging.']);
  assert.deepEqual(kinds.filter((k) => k.startsWith('final:')), ['final:Checkout now uses the shared helper.', 'final:Deployed to staging.']);
  assert.ok(kinds.includes('tool_call:exec npm test'));
  assert.ok(kinds.includes('goal:Ship the billing refactor'));
  assert.equal(events.filter((e) => e.kind === 'compaction').length, 1);
  assert.equal(events.filter((e) => e.kind === 'usage').length, 2);
  assert.ok(!JSON.stringify(events).includes('SECRET TOOL OUTPUT'));
  assert.ok(events.every((e) => e.sessionId === ID && e.cwd === '/work/web' && e.tool === 'codex'));
});

test('skips sub-agent sessions entirely', () => {
  const root = mkdtempSync(join(tmpdir(), 'baton-codex-'));
  writeSession(root, { ...session, subagent: true });
  assert.deepEqual(readAll(root), []);
});

test('ignores injected baton context and malformed lines', () => {
  const reader = createCodexReader('/nonexistent');
  const state = { sessionId: ID, cwd: '/work/web' };
  const injected = JSON.stringify({ timestamp: '2026-09-26T10:00:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<baton-context project="x">…</baton-context>' }] } });
  assert.deepEqual(reader.parse(injected, state), []);
  assert.throws(() => reader.parse('{not json', state));
});

test('a Stop hook continuation is not a user prompt', () => {
  const reader = createCodexReader('/nonexistent');
  const state = { sessionId: ID, cwd: '/work/web' };
  const text = '<hook_prompt hook_run_id="stop:0:/home/me/.codex/hooks.json">&lt;baton-messages to=&quot;codex&quot;&gt;…</hook_prompt>';
  const line = JSON.stringify({ timestamp: '2026-09-26T12:00:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
  assert.deepEqual(reader.parse(line, state), []);
});

test('reports a working-directory change', () => {
  const reader = createCodexReader('/nonexistent');
  const state = { sessionId: ID, cwd: '/work/web' };
  const events = reader.parse(JSON.stringify({ timestamp: '2026-09-26T12:00:00.000Z', type: 'turn_context', payload: { cwd: '/work/web/apps/api' } }), state);
  assert.deepEqual(events.map((e) => [e.kind, e.text]), [['cwd_change', '/work/web/apps/api']]);
  assert.equal(state.cwd, '/work/web/apps/api');
});

test('an image-only prompt still starts a turn', () => {
  const reader = createCodexReader('/nonexistent');
  const state = { sessionId: ID, cwd: '/work/web' };
  const line = JSON.stringify({ timestamp: '2026-09-26T12:00:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] } });
  assert.deepEqual(reader.parse(line, state).map((e) => [e.kind, e.text]), [['user', '[image]']]);
});
