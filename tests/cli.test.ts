import test from 'node:test';
import assert from 'node:assert/strict';
import { main, VERSION, captureIO } from '../src/cli.ts';

test('prints the version', async () => {
  const io = captureIO();
  assert.equal(await main(['--version'], io), 0);
  assert.equal(io.stdout.join(''), `${VERSION}\n`);
});

test('prints help and fails on an unknown command', async () => {
  const io = captureIO();
  assert.equal(await main(['nope'], io), 2);
  assert.match(io.stderr.join(''), /Unknown command: nope/);
  assert.match(io.stderr.join(''), /Usage: baton <command>/);
});
