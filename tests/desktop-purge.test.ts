import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureIO, main } from '../src/cli.ts';
import { ensureHome } from '../src/config.ts';
import { desktopPaths, type DesktopPaths } from '../src/desktop.ts';
import { applyPurge, planPurge } from '../src/desktop-purge.ts';

const NOW = new Date('2026-10-14T20:00:00').getTime();
const HOUR = 3_600_000;
const A = join('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-0000000000a1');
const B = join('bbbbbbbb-0000-4000-8000-000000000002', 'bbbbbbbb-0000-4000-8000-0000000000b2');
const cli = (n: number) => `1111111${n}-0000-4000-8000-000000000000`;

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'baton-purge-')));
  const home = join(root, '.baton');
  ensureHome(home);
  const paths = desktopPaths({ HOME: root }, home, join(root, '.claude', 'projects'));
  for (const f of [A, B]) mkdirSync(join(paths.store, f), { recursive: true });
  return { root, home, paths };
}

function transcript(paths: DesktopPaths, n: number, mtime = NOW - 2 * HOUR, extras = false): string {
  const dir = join(paths.projects, '-Users-me-web');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${cli(n)}.jsonl`);
  writeFileSync(file, '{"type":"user"}\n'.repeat(100));
  utimesSync(file, new Date(mtime), new Date(mtime));
  if (extras) {
    mkdirSync(join(dir, cli(n), 'subagents'), { recursive: true });
    writeFileSync(join(dir, cli(n), 'subagents', 'agent-1.jsonl'), '{}\n');
    writeFileSync(join(dir, cli(n), 'custom-title.json'), JSON.stringify({ customTitle: `Session ${n}` }));
    writeFileSync(join(dir, `${cli(n)}.desktop-released.json`), '{"v":1,"reason":"delete"}');
  }
  return file;
}

const tombstone = (paths: DesktopPaths, folder: string, id: string) => writeFileSync(join(paths.store, folder, `deleted_${id}`), String(NOW - HOUR));
const record = (paths: DesktopPaths, folder: string, n: number, extra: Record<string, unknown> = {}) =>
  writeFileSync(join(paths.store, folder, `local_0000000${n}-0000-4000-8000-000000000000.json`), JSON.stringify({ sessionId: `local_0000000${n}-0000-4000-8000-000000000000`, cliSessionId: cli(n), title: `Session ${n}`, ...extra }));

test('lists a deleted session no account lists any more, with its folder, markers and hidden copies', () => {
  const { paths } = fixture();
  const file = transcript(paths, 1, NOW - 2 * HOUR, true);
  tombstone(paths, A, cli(1));
  const hidden = join(paths.work, 'quarantine', 'run', B);
  mkdirSync(hidden, { recursive: true });
  writeFileSync(join(hidden, 'local_x.json'), JSON.stringify({ sessionId: 'local_x', cliSessionId: cli(1), title: 'Old work' }));
  const kept = transcript(paths, 2);

  const plan = planPurge(paths, NOW, new Set());
  assert.deepEqual(plan.items.map((i) => [i.id, i.title, i.files.length]), [[cli(1), 'Old work', 4]]);
  assert.ok(plan.bytes > 1000);
  assert.ok(existsSync(file), 'planning removes nothing');

  assert.deepEqual(applyPurge(paths, plan), { removed: 1, bytes: plan.bytes });
  for (const f of plan.items[0]!.files) assert.equal(existsSync(f), false, f);
  assert.ok(existsSync(kept), 'a transcript without a deletion marker stays');
});

test('keeps a transcript any account still lists, archived or not, even with a deletion marker', () => {
  const { paths } = fixture();
  transcript(paths, 1);
  transcript(paths, 2);
  tombstone(paths, A, cli(1));
  tombstone(paths, A, cli(2));
  record(paths, B, 1, { isArchived: true });
  record(paths, B, 3, { priorCliSessionIds: [cli(2)] });
  assert.deepEqual(planPurge(paths, NOW, new Set()).items, []);
});

test('waits for running sessions and transcripts written in the last ten minutes', () => {
  const { paths } = fixture();
  transcript(paths, 1);
  transcript(paths, 2, NOW - 60_000);
  tombstone(paths, A, cli(1));
  tombstone(paths, A, cli(2));
  const plan = planPurge(paths, NOW, new Set([cli(1)]));
  assert.deepEqual(plan.items, []);
  assert.deepEqual(plan.skipped.map((s) => s.reason).sort(), ['running', 'written in the last ten minutes']);
});

test('refuses to remove anything outside the transcripts and the quarantine', () => {
  const { paths, root } = fixture();
  const outside = join(root, 'precious.txt');
  writeFileSync(outside, 'keep');
  assert.throws(() => applyPurge(paths, { items: [{ id: 'x', title: 'x', files: [outside], bytes: 4 }], skipped: [], bytes: 4 }), /refusing to remove/);
  assert.ok(existsSync(outside));
});

test('baton desktop purge lists first and removes only with --yes', { skip: process.platform !== 'darwin' }, async () => {
  const { root, home, paths } = fixture();
  const file = transcript(paths, 1, Date.now() - 2 * HOUR);
  tombstone(paths, A, cli(1));
  const io = captureIO({ env: { HOME: root, BATON_HOME: home } });
  assert.equal(await main(['desktop', 'purge'], io), 0);
  assert.match(io.stdout.join(''), /These 1 sessions were deleted in Claude/);
  assert.ok(existsSync(file));
  assert.equal(await main(['desktop', 'purge', '--yes'], io), 0);
  assert.match(io.stdout.join(''), /Removed the conversation files of 1 deleted sessions/);
  assert.equal(existsSync(file), false);
});
