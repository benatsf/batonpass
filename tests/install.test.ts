import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ensureHome } from '../src/config.ts';
import { applyPlan, hookStatus, installPaths, planInstall, planUninstall, renderDiff, SKILL_SOURCE, type InstallPaths, type Launcher } from '../src/install.ts';

/** A launcher whose targets exist, so doctor reports it healthy. */
const LAUNCHER: Launcher = { node: process.execPath, script: SKILL_SOURCE };
const NOW = new Date('2026-09-26T18:00:00.000Z');
const SKILL = readFileSync(SKILL_SOURCE, 'utf8');
const both = { claude: true, codex: true };

function home(): InstallPaths {
  const root = mkdtempSync(join(tmpdir(), 'baton-install-'));
  const baton = join(root, '.baton');
  ensureHome(baton);
  return installPaths({ HOME: root }, baton);
}
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
const write = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const install = (paths: InstallPaths, launcher = LAUNCHER) => applyPlan(paths, planInstall(paths, both, launcher, SKILL, NOW), NOW);

test('a dry run plans both tools and writes nothing', () => {
  const paths = home();
  const plan = planInstall(paths, both, LAUNCHER, SKILL, NOW);
  assert.deepEqual(plan.changes.map((c) => c.path).sort(), [paths.claudeSettings, paths.claudeSkill, paths.codexHooks, paths.codexSkill, paths.launcher].sort());
  const diff = renderDiff(plan.changes);
  assert.ok(diff.split('\n').some((l) => l.startsWith('+') && l.includes(`"command": "${paths.launcher} hook session-start --tool claude"`)));
  assert.ok(diff.includes(`--- /dev/null\n+++ ${paths.codexHooks}`));
  assert.equal(existsSync(paths.claudeSettings), false);
  assert.equal(existsSync(paths.manifest), false);
});

test('installs the exact hook entries for each tool and both skills', () => {
  const paths = home();
  install(paths);
  assert.deepEqual(read(paths.claudeSettings), {
    hooks: {
      SessionStart: [{ matcher: 'startup|resume|clear|compact', hooks: [{ type: 'command', command: `${paths.launcher} hook session-start --tool claude`, timeout: 5 }] }],
      Stop: [{ hooks: [{ type: 'command', command: `${paths.launcher} hook stop --tool claude`, timeout: 30 }] }],
      PreCompact: [{ hooks: [{ type: 'command', command: `${paths.launcher} hook pre-compact --tool claude`, timeout: 10 }] }],
    },
  });
  assert.deepEqual(read(paths.codexHooks), {
    description: 'Hooks installed by batonpass (baton uninstall removes them)',
    hooks: {
      SessionStart: [{ matcher: 'startup|resume|clear|compact', hooks: [{ type: 'command', command: `${paths.launcher} hook session-start --tool codex`, timeout: 5, additionalContextLimit: 2500, statusMessage: 'Loading batonpass context' }] }],
      Stop: [{ hooks: [{ type: 'command', command: `${paths.launcher} hook stop --tool codex`, timeout: 30 }] }],
      PreCompact: [{ hooks: [{ type: 'command', command: `${paths.launcher} hook pre-compact --tool codex`, timeout: 10 }] }],
    },
  });
  assert.equal(readFileSync(paths.claudeSkill, 'utf8'), SKILL);
  assert.equal(readFileSync(paths.codexSkill, 'utf8'), SKILL);
  const manifest = read(paths.manifest) as { commands: string[]; created: string[] };
  assert.equal(manifest.commands.length, 6);
  assert.ok(manifest.created.includes(paths.codexHooks));
});

test('merges with existing settings, keeps other hooks, and is idempotent', () => {
  const paths = home();
  const original = { permissions: { allow: ['Bash(ls)'] }, hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'superpowers-start' }] }] } };
  write(paths.claudeSettings, JSON.stringify(original, null, 2));
  install(paths);
  const merged = read(paths.claudeSettings) as { permissions: unknown; hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> } };
  assert.deepEqual(merged.permissions, original.permissions);
  assert.equal(merged.hooks.SessionStart[0]!.hooks[0]!.command, 'superpowers-start');
  assert.equal(merged.hooks.SessionStart.length, 2);
  assert.deepEqual(planInstall(paths, both, LAUNCHER, SKILL, NOW).changes, []);
});

test('hooks call a stable launcher; reinstalling from a new location only rewrites the launcher', () => {
  const paths = home();
  install(paths);
  const settings = readFileSync(paths.claudeSettings, 'utf8');
  assert.equal(settings.split(`"${paths.launcher} hook `).length - 1, 3);
  install(paths, { node: '/opt/node24/bin/node', script: '/new/batonpass/bin/baton.js' });
  assert.equal(readFileSync(paths.claudeSettings, 'utf8'), settings);
  const launcher = readFileSync(paths.launcher, 'utf8');
  assert.ok(launcher.includes("node='/opt/node24/bin/node'"));
  assert.ok(launcher.includes("script='/new/batonpass/bin/baton.js'"));
  assert.ok(!launcher.includes(SKILL_SOURCE));
  assert.equal(statSync(paths.launcher).mode & 0o777, 0o755);
});

test('the launcher never fails a hook when Node or batonpass has moved', () => {
  const paths = home();
  install(paths, { node: '/nonexistent/bin/node', script: '/nonexistent/bin/baton.js' });
  assert.equal(execFileSync(paths.launcher, ['hook', 'stop', '--tool', 'claude'], { encoding: 'utf8' }), '');
  const status = spawnSync(paths.launcher, ['status'], { encoding: 'utf8' });
  assert.equal(status.status, 1);
  assert.match(status.stderr, /run baton install again/);
  assert.deepEqual(hookStatus(paths).at(-1), [false, 'Hook launcher points to a missing Node or batonpass: run `baton install` again']);
});

test('the launcher passes its arguments through', () => {
  const paths = home();
  const script = join(dirname(paths.manifest), 'echo.js');
  writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
  install(paths, { node: process.execPath, script });
  assert.equal(execFileSync(paths.launcher, ['hook', 'stop', '--tool', 'codex'], { encoding: 'utf8' }), '["hook","stop","--tool","codex"]');
});

test('uninstall removes exactly what was installed and keeps backups', () => {
  const paths = home();
  const original = { permissions: { allow: ['Bash(ls)'] }, hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'superpowers-start' }] }] } };
  write(paths.claudeSettings, JSON.stringify(original, null, 2));
  install(paths);
  applyPlan(paths, planUninstall(paths), NOW);
  assert.deepEqual(read(paths.claudeSettings), original);
  assert.equal(existsSync(paths.codexHooks), false);
  assert.equal(existsSync(paths.claudeSkill), false);
  assert.equal(existsSync(paths.codexSkill), false);
  assert.equal(existsSync(paths.manifest), false);
  assert.equal(existsSync(paths.launcher), false);
  assert.ok(readdirSync(paths.backups, { recursive: true }).length > 0);
});

test('refuses to touch an unparsable settings file', () => {
  const paths = home();
  write(paths.claudeSettings, '{ "hooks": ');
  assert.throws(() => planInstall(paths, both, LAUNCHER, SKILL, NOW), /Cannot parse .*settings\.json/);
  assert.equal(readFileSync(paths.claudeSettings, 'utf8'), '{ "hooks": ');
});

test('notes explain Codex hook trust and inline hooks', () => {
  const paths = home();
  write(paths.codexConfig, 'model = "gpt-6-sol"\n[[hooks.Stop]]\n');
  const notes = planInstall(paths, both, LAUNCHER, SKILL, NOW).notes.join('\n');
  assert.match(notes, /run \/hooks/);
  assert.match(notes, /inline \[hooks\]/);
  assert.match(notes, /docs\/privacy\.md/);
});

test('hook status for doctor', () => {
  const paths = home();
  assert.deepEqual(hookStatus(paths), [[null, 'Hooks not installed: run `baton install`']]);
  install(paths);
  assert.deepEqual(hookStatus(paths), [[true, 'Claude Code hooks installed (3 of 3)'], [true, 'Codex hooks installed (3 of 3)']]);
});

test('the Claude Code plugin ships the same hooks and skill', () => {
  const root = join(import.meta.dirname, '..', 'integrations');
  const hooks = readFileSync(join(root, 'claude-plugin', 'hooks', 'hooks.json'), 'utf8');
  for (const event of ['session-start', 'stop', 'pre-compact']) assert.ok(hooks.includes(`"baton hook ${event} --tool claude"`));
  assert.ok(!hooks.includes('"async"'), 'Stop detaches its own work, so no hook is async');
  assert.equal(readFileSync(join(root, 'claude-plugin', 'skills', 'baton-resume', 'SKILL.md'), 'utf8'), SKILL);
  assert.equal((read(join(root, 'claude-plugin', '.claude-plugin', 'plugin.json')) as { name: string }).name, 'batonpass');
});
