import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ensureHome } from '../src/config.ts';
import { applyPlan, hookStatus, installPaths, planInstall, planUninstall, readSkills, renderDiff, skillPath, SKILL_NAMES, SKILL_SOURCES, type InstallPaths, type Launcher } from '../src/install.ts';

/** A launcher whose targets exist, so doctor reports it healthy. */
const LAUNCHER: Launcher = { node: process.execPath, script: SKILL_SOURCES['baton-resume'] };
const NOW = new Date('2026-09-26T18:00:00.000Z');
const SKILLS = readSkills();
const skillFiles = (paths: InstallPaths) => (['claude', 'codex'] as const).flatMap((tool) => SKILL_NAMES.map((name) => skillPath(paths, tool, name)));
const both = { claude: true, codex: true };

function home(): InstallPaths {
  const root = mkdtempSync(join(tmpdir(), 'baton-install-'));
  const baton = join(root, '.baton');
  ensureHome(baton);
  return installPaths({ HOME: root }, baton);
}
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
const write = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const install = (paths: InstallPaths, launcher = LAUNCHER) => applyPlan(paths, planInstall(paths, both, launcher, SKILLS, NOW), NOW);

test('a dry run plans both tools and writes nothing', () => {
  const paths = home();
  const plan = planInstall(paths, both, LAUNCHER, SKILLS, NOW);
  assert.deepEqual(plan.changes.map((c) => c.path).sort(), [paths.claudeSettings, paths.codexHooks, paths.launcher, ...skillFiles(paths)].sort());
  const diff = renderDiff(plan.changes);
  assert.ok(diff.split('\n').some((l) => l.startsWith('+') && l.includes(`"command": "${paths.launcher} hook session-start --tool claude"`)));
  assert.ok(diff.includes(`--- /dev/null\n+++ ${paths.codexHooks}`));
  assert.equal(existsSync(paths.claudeSettings), false);
  assert.equal(existsSync(paths.manifest), false);
});

test('installs the exact hook entries for each tool and every skill', () => {
  const paths = home();
  install(paths);
  assert.deepEqual(read(paths.claudeSettings), {
    hooks: {
      SessionStart: [{ matcher: 'startup|resume|clear|compact', hooks: [{ type: 'command', command: `${paths.launcher} hook session-start --tool claude`, timeout: 5 }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: `${paths.launcher} hook user-prompt-submit --tool claude`, timeout: 5 }] }],
      PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `${paths.launcher} hook post-tool-use --tool claude`, timeout: 5 }] }],
      Stop: [{ hooks: [{ type: 'command', command: `${paths.launcher} hook stop --tool claude`, timeout: 30 }] }],
      PreCompact: [{ hooks: [{ type: 'command', command: `${paths.launcher} hook pre-compact --tool claude`, timeout: 10 }] }],
    },
  });
  assert.deepEqual(read(paths.codexHooks), {
    description: 'Hooks installed by batonpass (baton uninstall removes them)',
    hooks: {
      SessionStart: [{ matcher: 'startup|resume|clear|compact', hooks: [{ type: 'command', command: `${paths.launcher} hook session-start --tool codex`, timeout: 5, additionalContextLimit: 2500, statusMessage: 'Loading batonpass context' }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: `${paths.launcher} hook user-prompt-submit --tool codex`, timeout: 5 }] }],
      PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `${paths.launcher} hook post-tool-use --tool codex`, timeout: 5 }] }],
      Stop: [{ hooks: [{ type: 'command', command: `${paths.launcher} hook stop --tool codex`, timeout: 30 }] }],
      PreCompact: [{ hooks: [{ type: 'command', command: `${paths.launcher} hook pre-compact --tool codex`, timeout: 10 }] }],
    },
  });
  for (const tool of ['claude', 'codex'] as const) {
    for (const name of SKILL_NAMES) assert.equal(readFileSync(skillPath(paths, tool, name), 'utf8'), SKILLS[name]);
  }
  const manifest = read(paths.manifest) as { commands: string[]; created: string[] };
  assert.equal(manifest.commands.length, 10);
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
  assert.deepEqual(planInstall(paths, both, LAUNCHER, SKILLS, NOW).changes, []);
});

test('hooks call a stable launcher; reinstalling from a new location only rewrites the launcher', () => {
  const paths = home();
  install(paths);
  const settings = readFileSync(paths.claudeSettings, 'utf8');
  assert.equal(settings.split(`"${paths.launcher} hook `).length - 1, 5);
  install(paths, { node: '/opt/node24/bin/node', script: '/new/batonpass/bin/baton.js' });
  assert.equal(readFileSync(paths.claudeSettings, 'utf8'), settings);
  const launcher = readFileSync(paths.launcher, 'utf8');
  assert.ok(launcher.includes("node='/opt/node24/bin/node'"));
  assert.ok(launcher.includes("script='/new/batonpass/bin/baton.js'"));
  assert.ok(!launcher.includes(SKILL_SOURCES['baton-resume']));
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
  for (const skill of skillFiles(paths)) assert.equal(existsSync(skill), false);
  assert.equal(existsSync(paths.manifest), false);
  assert.equal(existsSync(paths.launcher), false);
  assert.ok(readdirSync(paths.backups, { recursive: true }).length > 0);
});

test('refuses to touch an unparsable settings file', () => {
  const paths = home();
  write(paths.claudeSettings, '{ "hooks": ');
  assert.throws(() => planInstall(paths, both, LAUNCHER, SKILLS, NOW), /Cannot parse .*settings\.json/);
  assert.equal(readFileSync(paths.claudeSettings, 'utf8'), '{ "hooks": ');
});

test('notes explain Codex hook trust and inline hooks', () => {
  const paths = home();
  write(paths.codexConfig, 'model = "gpt-6-sol"\n[[hooks.Stop]]\n');
  const notes = planInstall(paths, both, LAUNCHER, SKILLS, NOW).notes.join('\n');
  assert.match(notes, /run \/hooks/);
  assert.match(notes, /inline \[hooks\]/);
  assert.match(notes, /docs\/privacy\.md/);
});

test('inline hooks are reported in either TOML form, but not Codex\'s own trust records', () => {
  const inline = (config: string) => {
    const paths = home();
    write(paths.codexConfig, config);
    return planInstall(paths, both, LAUNCHER, SKILLS, NOW).notes.some((n) => n.includes('inline [hooks]'));
  };
  const trust = '[hooks.state."/home/me/.codex/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:00"\n';
  assert.equal(inline(`model = "gpt-6-sol"\n\n${trust}`), false);
  assert.equal(inline('[hooks]\nStop = [{ hooks = [{ type = "command", command = "notify-done" }] }]\n'), true);
  assert.equal(inline(`${trust}\n[[hooks.PostToolUse]]\nmatcher = "*"\n`), true);
  assert.equal(inline('model = '), false, 'a config Codex cannot parse either gets no note');
});

test('hook status for doctor', () => {
  const paths = home();
  assert.deepEqual(hookStatus(paths), [[null, 'Hooks not installed: run `baton install`']]);
  install(paths);
  assert.deepEqual(hookStatus(paths), [[true, 'Claude Code hooks installed (5 of 5)'], [true, 'Codex hooks installed (5 of 5)']]);
});

test('reinstalling keeps batonpass hooks where they are among the user\'s, since Codex trusts hooks by position', () => {
  const paths = home();
  install(paths);
  const doc = read(paths.codexHooks) as { hooks: Record<string, unknown[]> };
  doc.hooks.Stop!.push({ hooks: [{ type: 'command', command: 'notify-done' }] });
  doc.hooks.SessionStart!.unshift({ hooks: [{ type: 'command', command: 'load-env' }] });
  delete doc.hooks.PostToolUse;
  writeFileSync(paths.codexHooks, `${JSON.stringify(doc, null, 2)}\n`);
  install(paths);
  const after = read(paths.codexHooks) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
  const commands = (event: string) => after.hooks[event]!.map((g) => g.hooks[0]!.command.replace(`${paths.launcher} `, ''));
  assert.deepEqual(commands('Stop'), ['hook stop --tool codex', 'notify-done']);
  assert.deepEqual(commands('SessionStart'), ['load-env', 'hook session-start --tool codex']);
  assert.deepEqual(commands('PostToolUse'), ['hook post-tool-use --tool codex']);
  assert.deepEqual(planInstall(paths, both, LAUNCHER, SKILLS, NOW).changes, []);
});

test('upgrading from 0.1.0 adds the message hooks and skill, keeps the trusted ones, and doctor notices until then', () => {
  const paths = home();
  install(paths);
  // What 0.1.0 installed: no message hooks, no baton-message skill.
  for (const path of [paths.claudeSettings, paths.codexHooks]) {
    const doc = read(path) as { hooks: Record<string, unknown> };
    delete doc.hooks.UserPromptSubmit;
    delete doc.hooks.PostToolUse;
    writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
  }
  const before = read(paths.codexHooks) as { hooks: Record<string, unknown> };
  assert.deepEqual(hookStatus(paths)[1], [false, 'Codex hooks installed (3 of 5): run `baton install` to add the missing ones']);
  install(paths);
  const after = read(paths.codexHooks) as { hooks: Record<string, unknown> };
  for (const event of ['SessionStart', 'Stop', 'PreCompact']) assert.deepEqual(after.hooks[event], before.hooks[event], `${event} unchanged, so Codex keeps trusting it`);
  assert.deepEqual(hookStatus(paths), [[true, 'Claude Code hooks installed (5 of 5)'], [true, 'Codex hooks installed (5 of 5)']]);
});

test('the Claude Code plugin ships the same hooks and skills', () => {
  const root = join(import.meta.dirname, '..', 'integrations');
  const hooks = readFileSync(join(root, 'claude-plugin', 'hooks', 'hooks.json'), 'utf8');
  for (const event of ['session-start', 'user-prompt-submit', 'post-tool-use', 'stop', 'pre-compact']) assert.ok(hooks.includes(`"baton hook ${event} --tool claude"`));
  assert.ok(!hooks.includes('"async"'), 'Stop detaches its own work, and async hooks cannot deliver messages');
  for (const name of SKILL_NAMES) assert.equal(readFileSync(join(root, 'claude-plugin', 'skills', name, 'SKILL.md'), 'utf8'), SKILLS[name]);
  assert.equal((read(join(root, 'claude-plugin', '.claude-plugin', 'plugin.json')) as { name: string }).name, 'batonpass');
});
