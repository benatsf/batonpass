import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { captureIO, main, type CliIO } from '../src/cli.ts';
import { createContext } from '../src/context.ts';
import { writeSession } from '../src/script.ts';
import { makeEnv } from './support/env.ts';

const ghToken = 'gh' + 'p_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';

function setup(extraEnv: Record<string, string> = {}, withHistory = true) {
  const env = makeEnv();
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  if (withHistory) {
    writeSession(env.root, { tool: 'codex', id: '01a047e4-a867-7e41-ba95-85ce29ade72a', cwd: env.repo, title: 'Billing', turns: [{ at: at(30), user: 'Refactor checkout.', reply: 'Checkout now uses the shared helper.' }] });
    writeSession(env.root, { tool: 'claude', id: '65c508aa-8a97-4dd7-b6e2-42e903a7ea5c', cwd: env.repo, title: 'Edge cleanup', turns: [{ at: at(20), user: 'Retire the unused functions.', reply: 'Seven functions now return 410.' }] });
  }
  const io = captureIO({ cwd: env.repo, env: { HOME: env.root, BATON_HOME: env.home, PATH: process.env.PATH, ...extraEnv } });
  const make = (e: NodeJS.ProcessEnv) => createContext(e, { facts: () => null });
  const run = (argv: string[], over: Partial<CliIO> = {}) => main(argv, { ...io, ...over }, make);
  const out = () => io.stdout.join('');
  const reset = () => { io.stdout.length = 0; io.stderr.length = 0; };
  return { env, io, run, out, reset };
}

test('ingest then show prints the brief for the current project', async () => {
  const t = setup();
  assert.equal(await t.run(['ingest']), 0);
  assert.match(t.out(), /Read 2 transcript file\(s\): \d+ new events\.\nRefreshed 1 snapshot\(s\)\./);
  t.reset();
  assert.equal(await t.run(['show']), 0);
  assert.match(t.out(), /^<baton-context project="github\.com\/acme\/web" seq="1"/);
  assert.ok(t.out().includes('Seven functions now return 410.'));
});

test('show --full, --json and a missing snapshot', async () => {
  const empty = setup({}, false);
  assert.equal(await empty.run(['show']), 1);
  assert.match(empty.io.stderr.join(''), /No snapshot yet for github\.com\/acme\/web/);
  const t = setup();
  await t.run(['ingest']);
  t.reset();
  await t.run(['show', '--full']);
  assert.ok(t.out().includes('## Sessions'));
  t.reset();
  await t.run(['show', '--json']);
  assert.equal(JSON.parse(t.out()).seq, 1);
});

test('search finds redacted history and reports no match plainly', async () => {
  const t = setup();
  await t.run(['ingest']);
  t.reset();
  assert.equal(await t.run(['search', 'unused', 'functions']), 0);
  assert.match(t.out(), /^\[Claude Code · .+ · user · session 65c508aa\] Retire the unused functions\./);
  t.reset();
  await t.run(['search', 'zebra']);
  assert.equal(t.out(), 'No matches for "zebra" in github.com/acme/web.\n');
});

test('note pins redacted text into the next brief', async () => {
  const t = setup();
  await t.run(['ingest']);
  t.reset();
  assert.equal(await t.run(['note', 'Never', 'force-push', 'main.', `Token ${ghToken}`]), 0);
  assert.match(t.out(), /^Pinned to github\.com\/acme\/web \(snapshot #2\)\./);
  t.reset();
  await t.run(['show']);
  assert.ok(t.out().includes('Never force-push main. Token [REDACTED:github_token]'));
  assert.ok(!t.out().includes(ghToken));
});

test('resume starts the other tool with the brief as its first prompt', async () => {
  const t = setup();
  const calls: Array<{ cmd: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }> = [];
  const spawn = async (cmd: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => { calls.push({ cmd, args, ...options }); return 0; };
  assert.equal(await t.run(['resume', 'claude'], { spawn }), 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.cmd, 'claude');
  assert.match(calls[0]!.args[0]!, /^<baton-context [\s\S]*<\/baton-context>\n\nContinue the work on this project/);
  assert.equal(calls[0]!.cwd, t.env.repo);
  assert.equal(calls[0]!.env.BATON_SKIP_INJECT, '1');
});

test('resume refuses inside an agent started by baton', async () => {
  const t = setup({ BATON_HOOK: '1' });
  let spawned = false;
  assert.equal(await t.run(['resume', 'codex'], { spawn: async () => { spawned = true; return 0; } }), 1);
  assert.equal(spawned, false);
});

test('status lists projects with sessions per tool', async () => {
  const t = setup();
  await t.run(['ingest']);
  t.reset();
  assert.equal(await t.run(['status']), 0);
  assert.match(t.out(), /^github\.com\/acme\/web\n  sessions: Codex 1, Claude Code 1 · last activity .+ · snapshot #1, \d+ s old\n/);
  assert.match(t.out(), /Jev: off · spent today 0 input tokens/);
});

test('doctor reports its checks', async () => {
  const t = setup();
  await t.run(['ingest']);
  t.reset();
  assert.equal(await t.run(['doctor']), 0);
  assert.match(t.out(), /^✓ Node \d+\.\d+\.\d+ \(needs 24 or later\)$/m);
  assert.match(t.out(), /^✓ Ledger integrity: ok$/m);
  assert.match(t.out(), /^✓ Codex transcripts found: 1$/m);
  assert.match(t.out(), /^– Jev: off \(select\.strategy = recent-dialogue, no network calls\)$/m);
  assert.match(t.out(), /^– Hooks not installed: run `baton install`$/m);
});

test('install --dry-run shows the diff and writes nothing', async () => {
  const t = setup();
  assert.equal(await t.run(['install', '--dry-run']), 0);
  assert.match(t.out(), /^\+\+\+ .*\/\.claude\/settings\.json$/m);
  assert.match(t.out(), /hook session-start --tool codex/);
  assert.match(t.out(), /Dry run: nothing was written\.\n$/);
  assert.equal(existsSync(join(t.env.root, '.claude', 'settings.json')), false);
});

test('hook reads stdin, prints JSON, and never exits non-zero', async () => {
  const t = setup();
  await t.run(['ingest']);
  t.reset();
  const stdin = async () => JSON.stringify({ cwd: t.env.repo, source: 'startup' });
  assert.equal(await t.run(['hook', 'session-start', '--tool', 'codex'], { readStdin: stdin }), 0);
  assert.equal(JSON.parse(t.out()).hookSpecificOutput.hookEventName, 'SessionStart');
  t.reset();
  assert.equal(await t.run(['hook']), 0);
  assert.equal(await t.run(['hook', 'stop', '--bogus']), 0);
  assert.equal(t.out(), '');
});

test('an unknown option exits 2 with the parser message', async () => {
  const t = setup();
  assert.equal(await t.run(['show', '--bogus']), 2);
  assert.match(t.io.stderr.join(''), /Unknown option '--bogus'/);
});
