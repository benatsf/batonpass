import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { createContext } from '../src/context.ts';
import { runHook } from '../src/hooks.ts';
import { writeSession, type ScriptSession } from '../src/script.ts';
import { makeEnv } from './support/env.ts';

const CODEX = '01a047e4-a867-7e41-ba95-85ce29ade72a';
const CLAUDE = '65c508aa-8a97-4dd7-b6e2-42e903a7ea5c';

function setup(extraEnv: Record<string, string> = {}) {
  const env = makeEnv();
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const codex: ScriptSession = { tool: 'codex', id: CODEX, cwd: env.repo, title: 'Billing', turns: [{ at: at(30), user: 'Refactor checkout.', reply: 'Checkout now uses the shared helper.' }] };
  const claude: ScriptSession = { tool: 'claude', id: CLAUDE, cwd: env.repo, title: 'Edge cleanup', turns: [{ at: at(20), user: 'Never deploy on Fridays. Retire the unused functions.', reply: 'Seven functions now return 410.' }] };
  const codexPath = writeSession(env.root, codex);
  const claudePath = writeSession(env.root, claude);
  const processEnv = { HOME: env.root, BATON_HOME: env.home, PATH: process.env.PATH, ...extraEnv };
  const make = () => createContext(processEnv, { facts: () => null });
  const input = (over: Record<string, unknown>) => JSON.stringify({ cwd: env.repo, ...over });
  return { env, codexPath, claudePath, make, input };
}

test('session-start returns nothing before the first snapshot', async () => {
  const { make, input } = setup();
  assert.equal(await runHook('SessionStart', 'claude', input({ hook_event_name: 'SessionStart', source: 'startup' }), make), '');
});

test('Codex to Claude Code: a Codex Stop feeds the next Claude Code SessionStart', async () => {
  const { make, input, codexPath } = setup();
  assert.equal(await runHook('Stop', 'codex', input({ session_id: CODEX, transcript_path: codexPath }), make), '');
  const out = await runHook('SessionStart', 'claude', input({ session_id: 'new', source: 'startup' }), make);
  const parsed = JSON.parse(out) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(parsed.hookSpecificOutput.additionalContext, /^<baton-context project="github\.com\/acme\/web" seq="1"/);
  assert.ok(parsed.hookSpecificOutput.additionalContext.includes('Checkout now uses the shared helper.'));
  assert.deepEqual(Object.keys(parsed), ['hookSpecificOutput']);
});

test('Claude Code to Codex: a Claude Code Stop feeds the next Codex SessionStart', async () => {
  const { make, input, claudePath } = setup();
  await runHook('stop', 'claude', input({ session_id: CLAUDE, transcript_path: claudePath }), make);
  const out = await runHook('session-start', 'codex', input({ session_id: 'new', source: 'startup' }), make);
  const context = JSON.parse(out).hookSpecificOutput.additionalContext as string;
  assert.ok(context.includes('Never deploy on Fridays.'));
  assert.ok(context.includes('Seven functions now return 410.'));
});

test('BATON_SKIP_INJECT suppresses injection and BATON_HOOK disables all work', async () => {
  const skip = setup({ BATON_SKIP_INJECT: '1' });
  await runHook('Stop', 'codex', skip.input({ transcript_path: skip.codexPath }), skip.make);
  assert.equal(await runHook('SessionStart', 'claude', skip.input({}), skip.make), '');
  const inert = setup({ BATON_HOOK: '1' });
  await runHook('Stop', 'codex', inert.input({ transcript_path: inert.codexPath }), inert.make);
  assert.equal(inert.env.deps.ledger.events(inert.env.projectId).length, 0);
});

test('prepends a staleness warning when transcripts moved on', async () => {
  const { make, input, codexPath } = setup();
  await runHook('Stop', 'codex', input({ transcript_path: codexPath }), make);
  const later = new Date(Date.now() + 30 * 60_000);
  utimesSync(codexPath, later, later);
  const context = JSON.parse(await runHook('SessionStart', 'claude', input({}), make)).hookSpecificOutput.additionalContext as string;
  assert.match(context.split('\n')[1]!, /^Warning: this snapshot is 30 min older/);
});

test('pre-compact ingests a Codex session found by id, without rendering', async () => {
  const { env, make, input } = setup();
  assert.equal(await runHook('PreCompact', 'codex', input({ session_id: CODEX, trigger: 'auto' }), make), '');
  assert.ok(env.deps.ledger.events(env.projectId).length > 0);
  assert.equal(env.deps.ledger.latestSnapshot(env.projectId), null);
});

test('errors and bad input produce empty output and one content-free log line', async () => {
  const { env, make } = setup();
  assert.equal(await runHook('SessionStart', 'claude', '{not json', make), '');
  assert.equal(await runHook('Nonsense', 'claude', '{}', make), '');
  const failing = () => createContext({ HOME: env.root, BATON_HOME: env.home }, { resolve: () => { throw new TypeError('boom'); } });
  assert.equal(await runHook('SessionStart', 'claude', JSON.stringify({ cwd: env.repo }), failing), '');
  const log = readFileSync(join(env.home, 'logs', 'baton.log'), 'utf8');
  assert.match(log, /hook-error .*"error":"TypeError"/);
  assert.ok(!log.includes(env.repo));
});

test('session-start stays fast (p95 under 300 ms in process)', async () => {
  const { make, input, codexPath } = setup();
  await runHook('Stop', 'codex', input({ transcript_path: codexPath }), make);
  const times: number[] = [];
  for (let i = 0; i < 20; i++) {
    const start = performance.now();
    await runHook('SessionStart', 'claude', input({}), make);
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  assert.ok(times[18]! < 300, `p95 ${times[18]} ms`);
});

test('Stop also ingests transcripts of the project it has not seen yet', async () => {
  const { make, input, claudePath } = setup();
  await runHook('Stop', 'claude', input({ session_id: CLAUDE, transcript_path: claudePath }), make);
  const context = JSON.parse(await runHook('SessionStart', 'codex', input({}), make)).hookSpecificOutput.additionalContext as string;
  assert.ok(context.includes('Checkout now uses the shared helper.'), 'the Codex session whose own Stop never ran');
});
