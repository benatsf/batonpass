import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../src/ledger.ts';
import type { BatonEvent } from '../src/types.ts';

const dbPath = () => join(mkdtempSync(join(tmpdir(), 'baton-ledger-')), 'baton.db');
const ev = (over: Partial<BatonEvent> = {}): BatonEvent => ({
  tool: 'codex', sessionId: 's1', ts: '2026-09-26T10:00:00.000Z', cwd: '/w', kind: 'user', text: 'hello world', meta: {}, ...over,
});

test('creates a private database and de-duplicates events', () => {
  const path = dbPath();
  const ledger = new Ledger(path);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(ledger.insertEvent('p', ev()), true);
  assert.equal(ledger.insertEvent('p', ev()), false);
  assert.equal(ledger.events('p').length, 1);
  ledger.close();
});

test('tracks sessions with counters, title, usage and last cwd', () => {
  const ledger = new Ledger(dbPath());
  const a = ev();
  const b = ev({ ts: '2026-09-26T11:00:00.000Z', kind: 'compaction', text: '', cwd: '/w/sub' });
  for (const e of [a, b]) if (ledger.insertEvent('p', e)) ledger.upsertSession('p', e, '/src/a.jsonl');
  ledger.setSessionTitle('codex', 's1', 'Billing');
  ledger.setSessionUsage('codex', 's1', { total: 5 }, 'gpt-6-sol');
  assert.deepEqual(
    ledger.sessions('p')[0],
    { tool: 'codex', sessionId: 's1', projectId: 'p', title: 'Billing', firstTs: a.ts, lastTs: b.ts, cwd: '/w/sub', model: 'gpt-6-sol', sourcePath: '/src/a.jsonl', usage: { total: 5 }, turns: 1, compactions: 1 },
  );
  assert.deepEqual(ledger.projects().map((p) => p.id), ['p']);
});

test('stores and returns source cursors with parse state', () => {
  const ledger = new Ledger(dbPath());
  const cursor = { path: '/a.jsonl', inode: 7, offset: 120, size: 300, mtimeMs: 1.5, skipping: false };
  ledger.putSource('codex', cursor, { sessionId: 's1', cwd: '/w' });
  assert.deepEqual(ledger.getSource('/a.jsonl'), { tool: 'codex', cursor, state: { sessionId: 's1', cwd: '/w' } });
  assert.equal(ledger.getSource('/missing'), null);
});

test('searches redacted text with AND first, then OR', () => {
  const ledger = new Ledger(dbPath());
  ledger.insertEvent('p', ev({ text: 'Stripe webhook secret rotated' }));
  ledger.insertEvent('p', ev({ ts: '2026-09-26T10:01:00.000Z', text: 'Vercel deploy succeeded' }));
  ledger.insertEvent('q', ev({ ts: '2026-09-26T10:02:00.000Z', text: 'webhook in another project' }));
  assert.deepEqual(ledger.search('p', 'webhook rotated').map((e) => e.text), ['Stripe webhook secret rotated']);
  assert.equal(ledger.search('p', 'webhook deploy').length, 2);
  assert.equal(ledger.search('p', '"; DROP TABLE events; --').length, 0);
});

test('commits snapshots with increasing sequence numbers and returns the latest', () => {
  const ledger = new Ledger(dbPath());
  const body = (brief: string) => (seq: number) => ({ createdAt: '2026-09-26T10:00:00.000Z', covers: [], brief: `${brief} seq=${seq}`, full: 'f', stats: { n: 1 } });
  assert.equal(ledger.commitSnapshot('p', body('b1')), 1);
  assert.equal(ledger.commitSnapshot('p', body('b2')), 2);
  assert.equal(ledger.latestSnapshot('p')?.brief, 'b2 seq=2');
  assert.equal(ledger.latestSnapshot('p')?.seq, 2);
  assert.throws(() => ledger.commitSnapshot('p', () => { throw new Error('render failed'); }), /render failed/);
  assert.equal(ledger.latestSnapshot('p')?.seq, 2);
  assert.equal(ledger.latestSnapshot('other'), null);
});

test('keeps scores, notes, Jev spend and redaction counts', () => {
  const ledger = new Ledger(dbPath());
  ledger.putScore('p', 'turn:1', 'jev-latest', 'keep_v1', 0.9, '2026-09-26T10:00:00Z');
  assert.equal(ledger.getScore('p', 'turn:1', 'jev-latest', 'keep_v1'), 0.9);
  assert.equal(ledger.getScore('p', 'turn:1', 'jev-latest', 'rule_v1'), null);
  ledger.addNote('p', 'Never touch billing', '2026-09-26T10:00:00Z');
  assert.deepEqual(ledger.notes('p'), [{ ts: '2026-09-26T10:00:00Z', text: 'Never touch billing' }]);
  ledger.addJevSpend('2026-09-26', 100);
  ledger.addJevSpend('2026-09-26', 50);
  assert.equal(ledger.jevSpend('2026-09-26'), 150);
  ledger.addRedactions({ jwt: 2 });
  ledger.addRedactions({ jwt: 1, bearer: 1 });
  assert.deepEqual(ledger.redactionCounts(), { bearer: 1, jwt: 3 });
});

test('prunes old events and surplus snapshots', () => {
  const ledger = new Ledger(dbPath());
  ledger.insertEvent('p', ev({ ts: '2026-01-01T00:00:00.000Z', text: 'old' }));
  ledger.insertEvent('p', ev({ ts: '2026-09-25T00:00:00.000Z', text: 'new' }));
  for (let i = 0; i < 5; i++) ledger.commitSnapshot('p', () => ({ createdAt: 'x', covers: [], brief: `b${i}`, full: '', stats: {} }));
  ledger.prune(new Date('2026-09-26T00:00:00Z'), 90, 2);
  assert.deepEqual(ledger.events('p').map((e) => e.text), ['new']);
  assert.equal(ledger.search('p', 'old').length, 0);
  assert.equal(ledger.latestSnapshot('p')?.seq, 5);
});

test('concurrent writers produce unique, gap-free snapshot sequence numbers', async () => {
  const path = dbPath();
  new Ledger(path).close();
  const run = () => new Promise<number>((resolve) => {
    const child = spawn(process.execPath, [join(import.meta.dirname, 'support', 'commit-snapshots.ts'), path, '25'], { stdio: 'ignore' });
    child.on('exit', (code) => resolve(code ?? 1));
  });
  const codes = await Promise.all([run(), run(), run(), run()]);
  assert.deepEqual(codes, [0, 0, 0, 0]);
  const ledger = new Ledger(path);
  const seqs = (ledger.db.prepare('SELECT seq FROM snapshots ORDER BY seq').all() as Array<{ seq: number }>).map((r) => r.seq);
  assert.deepEqual(seqs, Array.from({ length: 100 }, (_, i) => i + 1));
});
