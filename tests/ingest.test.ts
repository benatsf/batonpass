import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, utimesSync } from 'node:fs';
import { ingest } from '../src/ingest.ts';
import { codexLines, writeSession, type ScriptSession } from '../src/script.ts';
import { makeEnv } from './support/env.ts';

const stripe = 'sk_' + 'live_' + 'aB3dE5fG7hJ9kL2mN4pQ6rS8';

function sessions(repo: string): ScriptSession[] {
  return [
    {
      tool: 'codex', id: '01a047e4-a867-7e41-ba95-85ce29ade72a', cwd: repo, title: 'Billing',
      turns: [{ at: '2026-09-26T10:00:00.000Z', user: `Use key ${stripe} for the test.`, reply: 'Done, key stored in secrets.', tools: [{ name: 'exec', input: 'npm test', output: 'TOOL OUTPUT MUST NOT BE STORED' }] }],
    },
    {
      tool: 'claude', id: '65c508aa-8a97-4dd7-b6e2-42e903a7ea5c', cwd: repo, title: 'Edge cleanup',
      turns: [{ at: '2026-09-26T12:00:00.000Z', user: 'Retire the unused functions.', reply: 'Seven functions now return 410.' }],
    },
  ];
}

test('ingests both tools into one project, redacted, without tool output', () => {
  const env = makeEnv();
  for (const s of sessions(env.repo)) writeSession(env.root, s);
  const report = ingest(env.deps);
  assert.equal(report.files, 2);
  assert.ok(report.events >= 4);
  assert.deepEqual([...report.projects], [env.projectId]);
  const users = env.deps.ledger.events(env.projectId, ['user']).map((e) => e.text);
  assert.deepEqual(users, ['Use key [REDACTED:stripe_secret] for the test.', 'Retire the unused functions.']);
  assert.equal(env.deps.ledger.search(env.projectId, 'TOOL OUTPUT').length, 0);
  assert.deepEqual(env.deps.ledger.sessions(env.projectId).map((s) => [s.tool, s.title]), [['claude', 'Edge cleanup'], ['codex', 'Billing']]);
  assert.equal(env.deps.ledger.redactionCounts().stripe_secret, 1);
});

test('re-ingest is a no-op and appended lines are read incrementally', () => {
  const env = makeEnv();
  const [codex] = sessions(env.repo);
  const path = writeSession(env.root, codex!);
  ingest(env.deps);
  assert.equal(ingest(env.deps).files, 0);
  const extra = codexLines({ ...codex!, turns: [{ at: '2026-09-26T13:00:00.000Z', user: 'Now deploy.', reply: 'Deployed.' }] }).slice(1);
  appendFileSync(path, extra.join('\n') + '\n');
  const report = ingest(env.deps);
  assert.equal(report.files, 1);
  assert.deepEqual(env.deps.ledger.events(env.projectId, ['user']).map((e) => e.text).at(-1), 'Now deploy.');
});

test('skips transcripts older than the backfill window and sub-agent sessions', () => {
  const env = makeEnv();
  const [codex, claude] = sessions(env.repo);
  const old = writeSession(env.root, claude!);
  const past = new Date('2026-07-01T00:00:00Z');
  utimesSync(old, past, past);
  writeSession(env.root, { ...codex!, subagent: true });
  const report = ingest(env.deps);
  assert.equal(report.events, 0);
});

test('onlyPaths limits the run to the given transcripts', () => {
  const env = makeEnv();
  const [codex, claude] = sessions(env.repo);
  writeSession(env.root, codex!);
  const claudePath = writeSession(env.root, claude!);
  const report = ingest(env.deps, { onlyPaths: [claudePath] });
  assert.equal(report.files, 1);
  assert.deepEqual(env.deps.ledger.sessions(env.projectId).map((s) => s.tool), ['claude']);
});
