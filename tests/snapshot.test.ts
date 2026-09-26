import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, statSync } from 'node:fs';
import { tryLock } from '../src/lock.ts';
import { codexLines, writeSession, type ScriptSession } from '../src/script.ts';
import { lockPath, recentSelector, refresh, type Selector } from '../src/snapshot.ts';
import { makeEnv } from './support/env.ts';

const stripe = 'sk_' + 'live_' + 'aB3dE5fG7hJ9kL2mN4pQ6rS8';

function history(repo: string): ScriptSession[] {
  return [
    {
      tool: 'codex', id: '01a047e4-a867-7e41-ba95-85ce29ade72a', cwd: repo, title: 'Billing', goal: 'Ship the billing refactor',
      turns: [{ at: '2026-09-26T10:00:00.000Z', user: `Refactor checkout; the test key is ${stripe}.`, reply: 'Checkout now uses the shared helper.' }],
    },
    {
      tool: 'claude', id: '65c508aa-8a97-4dd7-b6e2-42e903a7ea5c', cwd: repo, title: 'Edge cleanup',
      pr: { number: 51, repo: 'solsebb/liink-is', url: 'https://github.com/solsebb/liink-is/pull/51' },
      turns: [{ at: '2026-09-26T12:00:00.000Z', user: 'Retire the unused functions.', reply: 'Seven functions now return 410.' }],
    },
  ];
}

function setup() {
  const env = makeEnv();
  const paths = history(env.repo).map((s) => writeSession(env.root, s));
  const deps = { ...env.deps, facts: () => null };
  return { env, deps, paths };
}

test('commits a brief covering both tools, oldest turn first, redacted', async () => {
  const { env, deps } = setup();
  const result = await refresh(deps, { projectId: env.projectId, root: env.repo });
  assert.equal(result.status, 'committed');
  assert.equal(result.seq, 1);
  const snap = env.deps.ledger.latestSnapshot(env.projectId)!;
  assert.match(snap.brief, /^<baton-context project="github\.com\/acme\/web" seq="1" generated="2026-09-26T18:00:00Z">/);
  assert.ok(snap.brief.indexOf('Checkout now uses the shared helper.') < snap.brief.indexOf('Seven functions now return 410.'));
  assert.ok(snap.brief.includes('[REDACTED:stripe_secret]'));
  assert.ok(!snap.brief.includes(stripe));
  assert.ok(snap.brief.includes('- Goal (Codex "Billing"): Ship the billing refactor'));
  assert.ok(snap.brief.includes('- PR linked (2026-09-26 12:00): #51 solsebb/liink-is https://github.com/solsebb/liink-is/pull/51'));
  assert.ok(snap.full.includes('## Sessions'));
  assert.deepEqual(snap.covers.map((c) => c.tool).sort(), ['claude', 'codex']);
  assert.ok(snap.covers.every((c) => (c.offset ?? 0) > 0));
  assert.equal(snap.stats.strategy, 'recent-dialogue');
});

test('a second refresh picks up new turns and increments seq', async () => {
  const { env, deps, paths } = setup();
  await refresh(deps, { projectId: env.projectId, root: env.repo });
  const [codex] = history(env.repo);
  appendFileSync(paths[0]!, codexLines({ ...codex!, goal: undefined, turns: [{ at: '2026-09-26T13:00:00.000Z', user: 'Deploy it.', reply: 'Deployed to staging.' }] }).slice(1).join('\n') + '\n');
  const second = await refresh(deps, { projectId: env.projectId, root: env.repo });
  assert.equal(second.seq, 2);
  assert.ok(env.deps.ledger.latestSnapshot(env.projectId)!.brief.includes('Deployed to staging.'));
});

test('a held project lock skips the refresh', async () => {
  const { env, deps } = setup();
  const held = tryLock(lockPath(env.home, env.projectId))!;
  assert.deepEqual(await refresh(deps, { projectId: env.projectId, lockWaitMs: 0 }), { status: 'locked', seq: null, ingest: null });
  assert.equal(env.deps.ledger.latestSnapshot(env.projectId), null);
  held.release();
  assert.equal((await refresh(deps, { projectId: env.projectId })).status, 'committed');
});

test('a project with no events and no notes stays empty', async () => {
  const { deps } = setup();
  const result = await refresh(deps, { projectId: 'github.com/none/x', ingest: false });
  assert.equal(result.status, 'empty');
});

test('a failing facts collector never fails the refresh', async () => {
  const { env, deps } = setup();
  const result = await refresh({ ...deps, facts: () => { throw new Error('gh exploded'); } }, { projectId: env.projectId, root: env.repo });
  assert.equal(result.status, 'committed');
  assert.ok(!env.deps.ledger.latestSnapshot(env.projectId)!.brief.includes('## Repository now'));
});

test('refreshes about 1 MB of new transcript within 1.5 s (spec 10)', async () => {
  const env = makeEnv();
  const turns = Array.from({ length: 200 }, (_, i) => ({
    at: new Date(Date.UTC(2026, 8, 26, 8, i * 2)).toISOString(),
    user: `step ${i} ${'x'.repeat(1500)}`,
    reply: `done ${i} ${'y'.repeat(1500)}`,
  }));
  const path = writeSession(env.root, { tool: 'codex', id: '0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c', cwd: env.repo, turns });
  assert.ok(statSync(path).size > 1_000_000);
  const started = performance.now();
  const result = await refresh({ ...env.deps, facts: () => null }, { projectId: env.projectId, root: env.repo });
  const ms = performance.now() - started;
  assert.equal(result.status, 'committed');
  assert.ok(ms < 1500, `took ${Math.round(ms)} ms`);
});

test('a refresh that loses the lock is picked up by the lock holder', async () => {
  const { env, deps } = setup();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let calls = 0;
  const slow: Selector = async (input) => {
    if (++calls === 1) await gate;
    return recentSelector(input);
  };
  const first = refresh({ ...deps, select: slow }, { projectId: env.projectId, root: env.repo });
  await new Promise((resolve) => setTimeout(resolve, 50));
  writeSession(env.root, { tool: 'claude', id: '9e9e9e9e-9e9e-4e9e-8e9e-9e9e9e9e9e9e', cwd: env.repo, turns: [{ at: '2026-09-26T14:00:00.000Z', user: 'One more thing.', reply: 'Late reply recorded.' }] });
  const second = await refresh(deps, { projectId: env.projectId, root: env.repo, lockWaitMs: 0 });
  assert.equal(second.status, 'locked');
  release();
  assert.equal((await first).status, 'committed');
  assert.ok(env.deps.ledger.latestSnapshot(env.projectId)!.brief.includes('Late reply recorded.'));
});
