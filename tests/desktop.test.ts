import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureIO, main } from '../src/cli.ts';
import { ensureHome } from '../src/config.ts';
import { agentPlist, AGENT_LABEL, applySync, desktopPaths, planSync, portable, type DesktopPaths } from '../src/desktop.ts';

type Pair = { account: string; org: string };
const A: Pair = { account: 'aaaaaaaa-0000-4000-8000-000000000001', org: 'aaaaaaaa-0000-4000-8000-0000000000a1' };
const B: Pair = { account: 'bbbbbbbb-0000-4000-8000-000000000002', org: 'bbbbbbbb-0000-4000-8000-0000000000b2' };
const C: Pair = { account: 'cccccccc-0000-4000-8000-000000000003', org: 'cccccccc-0000-4000-8000-0000000000c3' };
const NOW = new Date('2026-10-07T20:00:00').getTime();
const MIN = 60_000;

function fixture(root = realpathSync(mkdtempSync(join(tmpdir(), 'baton-desktop-')))) {
  const home = join(root, '.baton');
  ensureHome(home);
  const paths = desktopPaths({ HOME: root }, home, join(root, '.claude', 'projects'));
  return { root, home, paths };
}

const dir = (paths: DesktopPaths, p: Pair) => join(paths.store, p.account, p.org);

function folder(paths: DesktopPaths, p: Pair): string {
  mkdirSync(dir(paths, p), { recursive: true });
  return dir(paths, p);
}

function record(paths: DesktopPaths, p: Pair, rec: Record<string, unknown>, mtime: number): string {
  const file = join(folder(paths, p), `${rec.sessionId}.json`);
  writeFileSync(file, JSON.stringify(rec));
  utimesSync(file, new Date(mtime), new Date(mtime));
  return file;
}

function transcript(paths: DesktopPaths, cli: string, mtime = NOW - 60 * MIN): void {
  const project = join(paths.projects, '-Users-me-web');
  mkdirSync(project, { recursive: true });
  const file = join(project, `${cli}.jsonl`);
  writeFileSync(file, '{}\n');
  utimesSync(file, new Date(mtime), new Date(mtime));
}

const stamp = (ms: number) => {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

/** Claude's main.log: each entry is a sidebar load for an account/org pair. */
function log(paths: DesktopPaths, loads: Array<[number, Pair]>): void {
  const file = paths.logs.at(-1)!;
  mkdirSync(join(file, '..'), { recursive: true });
  const lines = loads.map(([at, p]) => `${stamp(at)} [info] [LocalSessionManager] Initialization succeeded — accountId=${p.account}, orgId=${p.org}, existingSessions=0`);
  writeFileSync(file, `${stamp(NOW - 300 * MIN)} [info] unrelated line\n${lines.join('\n')}\n`);
}

const session = (n: number, extra: Record<string, unknown> = {}) => ({
  sessionId: `local_0000000${n}-0000-4000-8000-000000000000`,
  cliSessionId: `1111111${n}-0000-4000-8000-000000000000`,
  title: `Session ${n}`,
  cwd: '/Users/me/web',
  ...extra,
});

const stem = (rec: { sessionId: string }) => rec.sessionId.replace(/^local_/, '');
const read = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;

/** A signed in at 19:00 (now loaded); B was loaded before that. */
function twoAccounts(paths: DesktopPaths): void {
  folder(paths, A);
  folder(paths, B);
  log(paths, [[NOW - 120 * MIN, B], [NOW - 60 * MIN, A]]);
}

test('copies a session into the other account without the fields owned by its account', () => {
  const { paths } = fixture();
  twoAccounts(paths);
  const rec = session(1, {
    bridgeSessionIds: ['cse_a'],
    remoteMcpServersConfig: [{ uuid: 'x' }],
    enabledMcpTools: { 'x:tool': true },
    remoteControlAutoEligible: true,
    scheduledTaskId: 'task',
    isArchived: false,
    model: 'claude-opus-5-5',
  });
  const source = record(paths, A, rec, NOW - 30 * MIN);
  transcript(paths, rec.cliSessionId);

  const plan = planSync(paths, NOW);
  assert.deepEqual(plan.actions.map((a) => [a.kind, a.folder.account]), [['create', B.account]]);
  assert.deepEqual(applySync(paths, plan, new Date(NOW)), { created: 1, updated: 0, quarantined: 0, raced: 0 });

  const copy = join(dir(paths, B), `${rec.sessionId}.json`);
  assert.deepEqual(read(copy), { sessionId: rec.sessionId, cliSessionId: rec.cliSessionId, title: 'Session 1', cwd: '/Users/me/web', isArchived: false, model: 'claude-opus-5-5' });
  assert.equal(statSync(copy).mode & 0o777, 0o600);
  assert.equal(statSync(copy).mtimeMs, statSync(source).mtimeMs);
  assert.deepEqual(readdirSync(dir(paths, B)), [`${rec.sessionId}.json`]);
  // Nothing left to do on the next run.
  assert.deepEqual(planSync(paths, NOW + MIN).actions, []);
});

test('only adds to the folder Claude has loaded, never rewrites it', () => {
  const { paths } = fixture();
  folder(paths, A);
  folder(paths, B);
  log(paths, [[NOW - 120 * MIN, A], [NOW - 60 * MIN, B]]);
  const one = session(1);
  const two = session(2);
  record(paths, A, { ...one, title: 'Renamed in A' }, NOW - 20 * MIN);
  const loaded = record(paths, B, one, NOW - 90 * MIN);
  record(paths, A, two, NOW - 30 * MIN);
  transcript(paths, one.cliSessionId);
  transcript(paths, two.cliSessionId);

  const plan = planSync(paths, NOW);
  assert.deepEqual(plan.actions.map((a) => [a.kind, a.folder.account, a.sessionId]), [['create', B.account, two.sessionId]]);
  applySync(paths, plan, new Date(NOW));
  assert.equal(read(loaded).title, 'Session 1');
});

test('brings an older copy up to date and keeps that account\'s own fields', () => {
  const { paths } = fixture();
  twoAccounts(paths);
  const rec = session(1);
  record(paths, A, { ...rec, title: 'New title', isArchived: true, bridgeSessionIds: ['cse_a'] }, NOW - 15 * MIN);
  const older = record(paths, B, { ...rec, isArchived: false, bridgeSessionIds: ['cse_b'] }, NOW - 50 * MIN);
  transcript(paths, rec.cliSessionId);

  const plan = planSync(paths, NOW);
  assert.deepEqual(plan.actions.map((a) => a.kind), ['update']);
  applySync(paths, plan, new Date(NOW));
  assert.deepEqual(read(older), { ...rec, title: 'New title', isArchived: true, bridgeSessionIds: ['cse_b'] });
});

test('leaves a copy alone while its own account saved it in the last ten minutes', () => {
  const { paths } = fixture();
  twoAccounts(paths);
  const rec = session(1);
  record(paths, A, { ...rec, title: 'Newer' }, NOW - 2 * MIN);
  record(paths, B, rec, NOW - 5 * MIN);
  transcript(paths, rec.cliSessionId);
  assert.deepEqual(planSync(paths, NOW).actions, []);
});

test('skips sessions it cannot or should not copy', () => {
  const { paths } = fixture();
  twoAccounts(paths);
  record(paths, A, session(1, { cliSessionId: undefined }), NOW - 30 * MIN);
  record(paths, A, session(2), NOW - 30 * MIN);
  const busy = session(3);
  record(paths, A, busy, NOW - 30 * MIN);
  transcript(paths, busy.cliSessionId, NOW - 10_000);
  const worktree = session(4, { worktreePath: '/nowhere/.claude/worktrees/gone' });
  record(paths, A, worktree, NOW - 30 * MIN);
  transcript(paths, worktree.cliSessionId);
  const remote = session(5, { sshConfig: { host: 'box' } });
  record(paths, A, remote, NOW - 30 * MIN);
  transcript(paths, remote.cliSessionId);

  const plan = planSync(paths, NOW);
  assert.deepEqual(plan.actions, []);
  assert.deepEqual(plan.skipped.map((s) => [s.title, s.reason]).sort(), [
    ['Session 1', 'no transcript id'],
    ['Session 2', 'transcript missing'],
    ['Session 3', 'in use; copied once idle for a minute'],
    ['Session 4', 'worktree no longer exists'],
    ['Session 5', 'not a local session'],
  ]);
});

test('a session deleted in one account is hidden in the others, and the copy is kept in quarantine', () => {
  const { paths, home } = fixture();
  twoAccounts(paths);
  const rec = session(1);
  const copy = record(paths, B, rec, NOW - 50 * MIN);
  transcript(paths, rec.cliSessionId);
  const deletedAt = NOW - 20 * MIN;
  // Claude names tombstones after the record stem (no local_ prefix) and the transcript id.
  writeFileSync(join(dir(paths, A), `deleted_${stem(rec)}`), String(deletedAt));

  const plan = planSync(paths, NOW);
  assert.deepEqual(plan.actions.map((a) => [a.kind, a.folder.account]), [['quarantine', B.account]]);
  assert.deepEqual(applySync(paths, plan, new Date(NOW)), { created: 0, updated: 0, quarantined: 1, raced: 0 });
  assert.equal(existsSync(copy), false);
  assert.equal(readFileSync(join(dir(paths, B), `deleted_${stem(rec)}`), 'utf8'), String(deletedAt));
  assert.equal(readFileSync(join(dir(paths, B), `deleted_${rec.cliSessionId}`), 'utf8'), String(deletedAt));
  const kept = join(home, 'desktop-sync', 'quarantine', new Date(NOW).toISOString().replace(/[:.]/g, '-'), B.account, B.org, `${rec.sessionId}.json`);
  assert.deepEqual(read(kept), rec);
});

test('a session reopened after a deletion is copied again', () => {
  const { paths } = fixture();
  twoAccounts(paths);
  const rec = session(1);
  record(paths, A, rec, NOW - 20 * MIN);
  transcript(paths, rec.cliSessionId);
  writeFileSync(join(dir(paths, B), `deleted_${stem(rec)}`), String(NOW - 40 * MIN));
  assert.deepEqual(planSync(paths, NOW).actions.map((a) => [a.kind, a.folder.account]), [['create', B.account]]);
});

test('a deletion known only by its transcript id hides the session too', () => {
  const { paths } = fixture();
  twoAccounts(paths);
  const rec = session(1);
  record(paths, B, rec, NOW - 50 * MIN);
  transcript(paths, rec.cliSessionId);
  writeFileSync(join(dir(paths, A), `deleted_${rec.cliSessionId}`), String(NOW - 20 * MIN));
  assert.deepEqual(planSync(paths, NOW).actions.map((a) => a.kind), ['quarantine']);
});

test('without a log saying which account is loaded, it only adds files', () => {
  const { paths } = fixture();
  folder(paths, A);
  const rec = session(1);
  const two = session(2);
  record(paths, A, { ...rec, title: 'Newer' }, NOW - 15 * MIN);
  record(paths, B, rec, NOW - 50 * MIN);
  record(paths, A, two, NOW - 30 * MIN);
  transcript(paths, rec.cliSessionId);
  transcript(paths, two.cliSessionId);
  const plan = planSync(paths, NOW);
  assert.equal(plan.layout.active, null);
  assert.deepEqual(plan.actions.map((a) => [a.kind, a.folder.account, a.sessionId]), [['create', B.account, two.sessionId]]);
});

test('ignores a folder Claude only passed through during a switch, and empty folders it never loaded', () => {
  const { paths } = fixture();
  folder(paths, A);
  folder(paths, B);
  folder(paths, C);
  folder(paths, { account: B.account, org: A.org });
  log(paths, [[NOW - 60 * MIN, { account: B.account, org: A.org }], [NOW - 60 * MIN + 1000, A]]);
  record(paths, B, session(1), NOW - 30 * MIN);
  const plan = planSync(paths, NOW);
  assert.deepEqual(plan.layout.folders.map((f) => f.account).sort(), [A.account, B.account]);
  assert.equal(plan.layout.active?.account, A.account);
});

test('does nothing while Claude is switching accounts', () => {
  const { paths } = fixture();
  folder(paths, A);
  folder(paths, B);
  log(paths, [[NOW - 60 * MIN, B], [NOW - 3000, A]]);
  const rec = session(1);
  record(paths, B, rec, NOW - 30 * MIN);
  transcript(paths, rec.cliSessionId);
  const plan = planSync(paths, NOW);
  assert.equal(plan.layout.settling, true);
  assert.deepEqual(plan.actions, []);
});

test('never follows a symlinked account folder', () => {
  const { paths, root } = fixture();
  twoAccounts(paths);
  const elsewhere = join(root, 'elsewhere');
  mkdirSync(elsewhere);
  mkdirSync(join(paths.store, C.account));
  symlinkSync(elsewhere, join(paths.store, C.account, C.org));
  const rec = session(1);
  record(paths, A, rec, NOW - 30 * MIN);
  transcript(paths, rec.cliSessionId);
  writeFileSync(join(elsewhere, `${session(2).sessionId}.json`), JSON.stringify(session(2)));
  const plan = planSync(paths, NOW);
  assert.deepEqual(plan.layout.folders.map((f) => f.account).sort(), [A.account, B.account]);
  applySync(paths, plan, new Date(NOW));
  assert.deepEqual(readdirSync(elsewhere), [`${session(2).sessionId}.json`]);
});

test('keeps Claude\'s version when it rewrites a record between planning and writing', () => {
  const { paths } = fixture();
  twoAccounts(paths);
  const rec = session(1);
  record(paths, A, { ...rec, title: 'From A' }, NOW - 15 * MIN);
  const target = record(paths, B, rec, NOW - 50 * MIN);
  transcript(paths, rec.cliSessionId);
  const plan = planSync(paths, NOW);
  writeFileSync(target, JSON.stringify({ ...rec, title: 'Claude wrote this' }));
  assert.deepEqual(applySync(paths, plan, new Date(NOW)), { created: 0, updated: 0, quarantined: 0, raced: 1 });
  assert.equal(read(target).title, 'Claude wrote this');
  assert.deepEqual(readdirSync(dir(paths, B)), [`${rec.sessionId}.json`]);
});

test('drops account-looking fields that a later Claude version might add', () => {
  assert.deepEqual(portable({ sessionId: 's', title: 't', cloudSyncId: 'x', newMcpThing: 1, ownerAccountUuid: 'u', originCwd: '/w', spawnSeed: {} }), {
    sessionId: 's',
    title: 't',
    originCwd: '/w',
    spawnSeed: {},
  });
});

test('the LaunchAgent runs the launcher every minute with this batonpass home', { skip: process.platform !== 'darwin' }, () => {
  const { root } = fixture();
  const file = join(root, 'agent.plist');
  writeFileSync(file, agentPlist('/Users/me/.baton/bin/baton', '/Users/me/.baton', '/Users/me/.baton/logs/desktop-sync.err'));
  execFileSync('plutil', ['-lint', '-s', file]);
  const agent = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' })) as Record<string, unknown>;
  assert.equal(agent.Label, AGENT_LABEL);
  assert.deepEqual(agent.ProgramArguments, ['/Users/me/.baton/bin/baton', 'desktop', 'sync', '--quiet']);
  assert.equal(agent.StartInterval, 60);
  assert.deepEqual(agent.EnvironmentVariables, { BATON_HOME: '/Users/me/.baton' });
});

test('baton desktop enable backs up, syncs once and loads the agent, reloads it when run again; disable unloads it', { skip: process.platform !== 'darwin' }, async () => {
  const { root, home, paths } = fixture();
  const now = Date.now();
  folder(paths, A);
  folder(paths, B);
  log(paths, [[now - 120 * MIN, B], [now - 60 * MIN, A]]);
  const rec = session(1);
  record(paths, A, rec, now - 30 * MIN);
  transcript(paths, rec.cliSessionId, now - 60 * MIN);
  mkdirSync(join(home, 'bin'), { recursive: true });
  writeFileSync(join(home, 'bin', 'baton'), '#!/bin/sh\n');
  const calls: string[][] = [];
  const io = captureIO({ env: { HOME: root, BATON_HOME: home }, spawn: async (cmd, args) => (calls.push([cmd, ...args]), 0) });

  assert.equal(await main(['desktop', 'enable'], io), 0, io.stderr.join(''));
  assert.ok(existsSync(paths.agent));
  assert.ok(existsSync(join(dir(paths, B), `${rec.sessionId}.json`)));
  assert.equal(readdirSync(join(home, 'desktop-sync', 'backups')).length, 1);
  // A first enable has nothing to unload, so launchctl is not asked to (it would print an error).
  assert.deepEqual(calls, [['launchctl', 'bootstrap', `gui/${process.getuid!()}`, paths.agent]]);
  assert.match(io.stdout.join(''), /First sync: copied 1/);

  assert.equal(await main(['desktop', 'enable'], io), 0);
  assert.deepEqual(calls.slice(1), [
    ['launchctl', 'bootout', `gui/${process.getuid!()}/${AGENT_LABEL}`],
    ['launchctl', 'bootstrap', `gui/${process.getuid!()}`, paths.agent],
  ]);

  assert.equal(await main(['desktop', 'disable'], io), 0);
  assert.equal(existsSync(paths.agent), false);
  assert.deepEqual(calls.at(-1), ['launchctl', 'bootout', `gui/${process.getuid!()}/${AGENT_LABEL}`]);
});
