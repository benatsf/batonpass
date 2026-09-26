import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, batonHome, ensureHome } from '../src/config.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'baton-config-'));

test('defaults follow the spec', () => {
  const home = tmp();
  const config = loadConfig({ HOME: home, BATON_HOME: join(home, '.baton') });
  assert.equal(config.home, join(home, '.baton'));
  assert.equal(config.render.briefTokens, 2000);
  assert.equal(config.render.fullDialogueTokens, 8000);
  assert.equal(config.select.strategy, 'recent-dialogue');
  assert.equal(config.jev.dropThreshold, 0.2);
  assert.equal(config.jev.maxInputTokensPerDay, 2_000_000);
  assert.equal(config.jev.rules, false);
  assert.equal(config.backfill.maxBytes, 64 * 1024 * 1024);
  assert.equal(config.sources.codexHome, join(home, '.codex'));
  assert.equal(config.sources.claudeProjects, join(home, '.claude', 'projects'));
});

test('BATON_HOME defaults to ~/.baton and CODEX_HOME is honoured', () => {
  assert.equal(batonHome({ HOME: '/u/me' }), '/u/me/.baton');
  const config = loadConfig({ HOME: '/u/me', BATON_HOME: tmp(), CODEX_HOME: '/opt/codex' });
  assert.equal(config.sources.codexHome, '/opt/codex');
});

test('config.toml overrides known keys, expands ~ in aliases, ignores unknown or mistyped values', () => {
  const home = tmp();
  const baton = join(home, '.baton');
  ensureHome(baton);
  writeFileSync(join(baton, 'config.toml'), [
    '[select]', 'strategy = "jev-select"',
    '[render]', 'briefTokens = 1500', 'staleAfterSeconds = "soon"',
    '[jev]', 'rules = true', 'unknownKey = 3',
    '[mystery]', 'x = 1',
    '[aliases]', '"~/old/apps/web" = "github.com/acme/web"',
  ].join('\n'));
  const config = loadConfig({ HOME: home, BATON_HOME: baton });
  assert.equal(config.select.strategy, 'jev-select');
  assert.equal(config.render.briefTokens, 1500);
  assert.equal(config.render.staleAfterSeconds, 900);
  assert.equal(config.jev.rules, true);
  assert.deepEqual(config.aliases, { [join(home, 'old/apps/web')]: 'github.com/acme/web' });
});

test('ensureHome creates a private directory with a logs folder', () => {
  const dir = join(tmp(), '.baton');
  ensureHome(dir);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.ok(statSync(join(dir, 'logs')).isDirectory());
});
