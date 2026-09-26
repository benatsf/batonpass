import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTurns, formatTurn, formatTime, abridge } from '../src/select/dialogue.ts';
import { selectRecent, turnTokens } from '../src/select/recent.ts';
import type { StoredEvent } from '../src/types.ts';

let id = 0;
const e = (sessionId: string, tool: string, ts: string, kind: StoredEvent['kind'], text: string): StoredEvent => ({
  id: ++id, projectId: 'p', tool, sessionId, ts, cwd: '/w', kind, text, meta: {},
});

test('pairs each prompt with its final reply, preferring final over interim text', () => {
  const turns = buildTurns([
    e('a', 'codex', '2026-09-26T10:00:00Z', 'user', 'Q1'),
    e('a', 'codex', '2026-09-26T10:00:30Z', 'assistant', 'thinking out loud'),
    e('a', 'codex', '2026-09-26T10:01:00Z', 'final', 'A1'),
    e('b', 'claude', '2026-09-26T09:00:00Z', 'user', 'Q0'),
    e('b', 'claude', '2026-09-26T09:00:10Z', 'assistant', 'interim'),
    e('b', 'claude', '2026-09-26T09:00:20Z', 'assistant', 'A0'),
    e('a', 'codex', '2026-09-26T11:00:00Z', 'user', 'Q2'),
  ]);
  assert.deepEqual(turns.map((t) => [t.tool, t.user, t.reply]), [
    ['claude', 'Q0', 'A0'],
    ['codex', 'Q1', 'A1'],
    ['codex', 'Q2', null],
  ]);
});

test('formats turns with tool labels and local times', () => {
  assert.equal(formatTime('2026-09-26T10:05:00Z', 'Europe/Paris'), '2026-09-26 12:05');
  const [turn] = buildTurns([e('a', 'claude', '2026-09-26T10:00:00Z', 'user', 'Q'), e('a', 'claude', '2026-09-26T10:01:00Z', 'assistant', 'A')]);
  assert.equal(formatTurn(turn!, 'UTC').text, '[Claude Code · 2026-09-26 10:00] User:\nQ\n[Claude Code · 2026-09-26 10:01] Agent:\nA');
});

test('abridge keeps head and tail', () => {
  const out = abridge('a'.repeat(60) + 'b'.repeat(40), 50);
  assert.equal(out.abridged, true);
  assert.match(out.text, /^a{30}\n\[… 50 chars omitted …\]\nb{20}$/);
});

test('keeps the newest turns within budget, oldest first in the output', () => {
  const events: StoredEvent[] = [];
  for (let i = 0; i < 20; i++) {
    events.push(e('a', 'codex', `2026-09-26T10:${String(i).padStart(2, '0')}:00Z`, 'user', `question ${i} ${'x'.repeat(200)}`));
    events.push(e('a', 'codex', `2026-09-26T10:${String(i).padStart(2, '0')}:30Z`, 'final', `answer ${i}`));
  }
  const picked = selectRecent(buildTurns(events), 300, 'UTC');
  assert.ok(picked.length > 1 && picked.length < 20);
  assert.equal(picked.at(-1)!.user.startsWith('question 19'), true);
  const total = picked.reduce((sum, t) => sum + turnTokens(t.rendered), 0);
  assert.ok(total <= 300, `used ${total}`);
  assert.deepEqual(picked.map((t) => t.ts), [...picked.map((t) => t.ts)].sort());
});

test('abridges a long turn before dropping it, and always keeps the newest turn', () => {
  const long = buildTurns([e('a', 'codex', '2026-09-26T10:00:00Z', 'user', 'y'.repeat(20000)), e('a', 'codex', '2026-09-26T10:01:00Z', 'final', 'z'.repeat(20000))]);
  const [only] = selectRecent(long, 100, 'UTC');
  assert.equal(only!.abridged, true);
  assert.equal(only!.reason, 'recent');
  assert.deepEqual(selectRecent([], 100, 'UTC'), []);
});
