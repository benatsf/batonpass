import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, ensureHome, type BatonConfig } from '../../src/config.ts';
import { Ledger } from '../../src/ledger.ts';
import { createResolver } from '../../src/project.ts';
import { createClaudeReader } from '../../src/readers/claude.ts';
import { createCodexReader } from '../../src/readers/codex.ts';
import type { IngestDeps } from '../../src/ingest.ts';

export function makeEnv() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'baton-env-')));
  const home = join(root, '.baton');
  ensureHome(home);
  const config: BatonConfig = defaultConfig(home, { HOME: root });
  config.render.timeZone = 'UTC';
  const repo = join(root, 'web');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/acme/web.git']);
  const deps: IngestDeps = {
    ledger: new Ledger(join(home, 'baton.db')),
    readers: [createCodexReader(config.sources.codexHome), createClaudeReader(config.sources.claudeProjects)],
    config,
    resolve: createResolver(config.aliases),
    now: () => new Date('2026-09-26T18:00:00.000Z'),
  };
  return { root, home, config, deps, repo, projectId: 'github.com/acme/web' };
}
