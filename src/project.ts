import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { ProjectRef } from './types.ts';

export type GitRunner = (args: string[], cwd: string) => string | null;

export const defaultGit: GitRunner = (args, cwd) => {
  try {
    const out = execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.trim() || null;
  } catch {
    return null;
  }
};

export function normalizeRemote(url: string): string | null {
  const u = url.trim().replace(/\.git$/, '').replace(/\/+$/, '');
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(u);
  if (scheme) return `${scheme[1]!.toLowerCase()}/${scheme[2]}`;
  const scp = /^(?:[^@\s]+@)?([^:/\s]+):([^\s]+)$/.exec(u);
  if (scp && scp[2]!.includes('/')) return `${scp[1]!.toLowerCase()}/${scp[2]}`;
  return null;
}

export function createResolver(aliases: Record<string, string>, git: GitRunner = defaultGit): (cwd: string) => ProjectRef {
  const cache = new Map<string, ProjectRef>();
  const aliasKeys = Object.keys(aliases).sort((a, b) => b.length - a.length);

  function resolveUncached(cwd: string): ProjectRef {
    for (const key of aliasKeys) {
      if (cwd === key || cwd.startsWith(`${key}/`)) return { id: aliases[key]!, root: existsSync(key) ? key : null, kind: 'alias' };
    }
    if (!existsSync(cwd)) return { id: `path:${cwd}`, root: null, kind: 'path' };
    const top = git(['rev-parse', '--show-toplevel'], cwd);
    if (!top) return { id: `path:${cwd}`, root: cwd, kind: 'path' };
    const remote = git(['config', '--get', 'remote.origin.url'], top);
    const id = remote ? normalizeRemote(remote) : null;
    return id ? { id, root: top, kind: 'remote' } : { id: `path:${top}`, root: top, kind: 'path' };
  }

  return (cwd: string) => {
    const hit = cache.get(cwd);
    if (hit) return hit;
    const ref = resolveUncached(cwd);
    cache.set(cwd, ref);
    return ref;
  };
}
