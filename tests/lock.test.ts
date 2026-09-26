import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tryLock } from '../src/lock.ts';

const lockFile = () => join(mkdtempSync(join(tmpdir(), 'baton-lock-')), 'locks', 'p.lock');

test('a second lock fails while the first is held, and succeeds after release', () => {
  const path = lockFile();
  const first = tryLock(path);
  assert.ok(first);
  assert.equal(tryLock(path), null);
  first.release();
  const second = tryLock(path);
  assert.ok(second);
  second.release();
});

test('takes over a lock whose owner process is gone', () => {
  const path = lockFile();
  tryLock(path)!;
  writeFileSync(path, '4194305 2026-09-26T00:00:00.000Z\n');
  assert.ok(tryLock(path));
});

test('takes over a lock older than ten minutes', () => {
  const path = lockFile();
  tryLock(path)!;
  const old = new Date(Date.now() - 11 * 60 * 1000);
  utimesSync(path, old, old);
  assert.ok(tryLock(path));
});
