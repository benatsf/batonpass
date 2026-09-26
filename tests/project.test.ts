import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createResolver, normalizeRemote } from '../src/project.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });

function repo(remote: string | null): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'baton-repo-')));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, '-c', 'user.email=t@e.st', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  if (remote) git(dir, 'remote', 'add', 'origin', remote);
  return dir;
}

test('normalizes common remote forms and strips credentials', () => {
  assert.equal(normalizeRemote('https://github.com/Acme/web.git'), 'github.com/Acme/web');
  assert.equal(normalizeRemote('git@github.com:Acme/web.git'), 'github.com/Acme/web');
  assert.equal(normalizeRemote('ssh://git@GitHub.com:22/Acme/web'), 'github.com/Acme/web');
  assert.equal(normalizeRemote('https://x-access-token:abc123@github.com/Acme/web'), 'github.com/Acme/web');
  assert.equal(normalizeRemote('not a url'), null);
});

test('resolves a subdirectory and a worktree of the same repository to one project', () => {
  const dir = repo('git@github.com:acme/web.git');
  mkdirSync(join(dir, 'apps', 'api'), { recursive: true });
  const worktree = join(realpathSync(tmpdir()), `baton-wt-${process.pid}-${Date.now()}`);
  git(dir, 'worktree', 'add', '-q', worktree);
  const resolve = createResolver({});
  assert.deepEqual(resolve(join(dir, 'apps', 'api')), { id: 'github.com/acme/web', root: dir, kind: 'remote' });
  assert.equal(resolve(worktree).id, 'github.com/acme/web');
});

test('an alias wins over git and matches by longest prefix', () => {
  const dir = repo('https://github.com/acme/monorepo');
  mkdirSync(join(dir, 'apps', 'web'), { recursive: true });
  const resolve = createResolver({ [dir]: 'github.com/acme/monorepo-root', [join(dir, 'apps', 'web')]: 'github.com/acme/web' });
  assert.equal(resolve(join(dir, 'apps', 'web', 'src')).id, 'github.com/acme/web');
  assert.equal(resolve(join(dir, 'apps', 'web')).kind, 'alias');
  assert.equal(resolve(dir).id, 'github.com/acme/monorepo-root');
});

test('falls back to a path id outside git or without a remote', () => {
  const plain = realpathSync(mkdtempSync(join(tmpdir(), 'baton-plain-')));
  const resolve = createResolver({});
  assert.deepEqual(resolve(plain), { id: `path:${plain}`, root: plain, kind: 'path' });
  const local = repo(null);
  assert.deepEqual(resolve(local), { id: `path:${local}`, root: local, kind: 'path' });
});

test('handles a cwd that no longer exists', () => {
  const resolve = createResolver({});
  assert.deepEqual(resolve('/no/such/dir/anywhere'), { id: 'path:/no/such/dir/anywhere', root: null, kind: 'path' });
});

test('caches results per cwd', () => {
  let calls = 0;
  const resolve = createResolver({}, (args) => {
    calls++;
    return args[0] === 'rev-parse' ? '/r' : 'https://github.com/a/b';
  });
  resolve(tmpdir());
  resolve(tmpdir());
  assert.equal(calls, 2);
});
