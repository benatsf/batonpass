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

test('exits quietly when stdout is closed early, as with `baton status | head`', async () => {
  const { spawn } = await import('node:child_process');
  const script = `import { main } from ${JSON.stringify(new URL('../src/cli.ts', import.meta.url).href)}; process.exitCode = await main(['help']);`;
  const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.destroy();
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
  assert.equal(stderr, '');
  assert.equal(code, 0);
});

test('the CLI, the npm package and the Claude Code plugin report the same version', async () => {
  const { readFileSync } = await import('node:fs');
  const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as { version: string };
  assert.equal(read('../package.json').version, VERSION);
  assert.equal(read('../package-lock.json').version, VERSION);
  assert.equal(read('../integrations/claude-plugin/.claude-plugin/plugin.json').version, VERSION);
});
