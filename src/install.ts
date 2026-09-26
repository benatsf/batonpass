import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Check } from './commands.ts';

export interface InstallPaths {
  claudeSettings: string;
  codexHooks: string;
  codexConfig: string;
  claudeSkill: string;
  codexSkill: string;
  manifest: string;
  backups: string;
  /** Stable hook entry point; hooks never name a versioned Node path directly. */
  launcher: string;
}

export interface FileChange {
  path: string;
  before: string | null;
  after: string | null;
  mode?: number;
}

export interface Launcher {
  node: string;
  script: string;
}

export interface Manifest {
  version: 1;
  installedAt: string;
  tools: Array<'claude' | 'codex'>;
  commands: string[];
  files: string[];
  created: string[];
  skills: string[];
  launcher?: string;
}

export interface InstallPlan {
  changes: FileChange[];
  manifest: Manifest | null;
  notes: string[];
}

type Json = Record<string, unknown>;
type Handler = Json & { command?: unknown };
type Group = Json & { hooks?: Handler[] };
type HookMap = Record<string, Group[]>;

const CODEX_DESCRIPTION = 'Hooks installed by batonpass (baton uninstall removes them)';
const MATCHER = 'startup|resume|clear|compact';

export const SKILL_SOURCE = fileURLToPath(new URL('../integrations/skills/baton-resume/SKILL.md', import.meta.url));

export function installPaths(env: NodeJS.ProcessEnv, batonHome: string): InstallPaths {
  const home = env.HOME ?? homedir();
  const codexHome = env.CODEX_HOME ?? join(home, '.codex');
  return {
    claudeSettings: join(home, '.claude', 'settings.json'),
    codexHooks: join(codexHome, 'hooks.json'),
    codexConfig: join(codexHome, 'config.toml'),
    claudeSkill: join(home, '.claude', 'skills', 'baton-resume', 'SKILL.md'),
    codexSkill: join(codexHome, 'skills', 'baton-resume', 'SKILL.md'),
    manifest: join(batonHome, 'install.json'),
    backups: join(batonHome, 'backups'),
    launcher: join(batonHome, 'bin', 'baton'),
  };
}

const quote = (s: string) => (/^[\w./-]+$/.test(s) ? s : `"${s.replace(/(["\\$`])/g, '\\$1')}"`);

export function defaultLauncher(): Launcher {
  return { node: process.execPath, script: realpathSync(fileURLToPath(new URL('../bin/baton.js', import.meta.url))) };
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** A POSIX shell launcher: runs batonpass with the recorded Node, and never fails a hook if either moved. */
export function launcherScript(launcher: Launcher): string {
  return [
    '#!/bin/sh',
    '# Written by `baton install`. Run `baton install` again after moving Node or batonpass.',
    `node=${shellQuote(launcher.node)}`,
    `script=${shellQuote(launcher.script)}`,
    'if [ -x "$node" ] && [ -f "$script" ]; then exec "$node" "$script" "$@"; fi',
    '# Hooks must never fail a Codex or Claude Code session.',
    'if [ "$1" = hook ]; then exit 0; fi',
    'echo "batonpass: $node or $script no longer exists; run baton install again." >&2',
    'exit 1',
    '',
  ].join('\n');
}

function launcherTargets(text: string): Launcher | null {
  // Values are single-quoted, with each ' written as '\'' (see shellQuote).
  const value = (name: string) => new RegExp(`^${name}='((?:[^']|'\\\\'')*)'$`, 'm').exec(text)?.[1]?.replaceAll(`'\\''`, "'");
  const node = value('node');
  const script = value('script');
  return node && script ? { node, script } : null;
}

function entries(tool: 'claude' | 'codex', command: string): Array<{ event: string; group: Group }> {
  const cmd = (event: string) => `${command} hook ${event} --tool ${tool}`;
  const start: Handler = { type: 'command', command: cmd('session-start'), timeout: 5 };
  if (tool === 'codex') Object.assign(start, { additionalContextLimit: 2500, statusMessage: 'Loading batonpass context' });
  return [
    { event: 'SessionStart', group: { matcher: MATCHER, hooks: [start] } },
    // Stop only hands the refresh to a detached process (about 0.1 s), so it runs synchronously.
    { event: 'Stop', group: { hooks: [{ type: 'command', command: cmd('stop'), timeout: 30 }] } },
    { event: 'PreCompact', group: { hooks: [{ type: 'command', command: cmd('pre-compact'), timeout: 10 }] } },
  ];
}

function readText(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function parseJson(path: string, text: string | null, fallback: Json): Json {
  if (text === null) return structuredClone(fallback);
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not a JSON object');
    return value as Json;
  } catch (error) {
    throw new Error(`Cannot parse ${path}: ${(error as Error).message}. Fix the file, then run baton install again.`);
  }
}

/** Removes our handlers. Install keeps emptied event keys so the file's key order survives a reinstall. */
function removeCommands(hooks: HookMap, commands: Set<string>, dropEmpty: boolean): void {
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept: Group[] = [];
    for (const group of groups) {
      const handlers = Array.isArray(group.hooks) ? group.hooks : null;
      if (!handlers || !handlers.some((h) => commands.has(String(h.command)))) {
        kept.push(group);
        continue;
      }
      const rest = handlers.filter((h) => !commands.has(String(h.command)));
      if (rest.length) kept.push({ ...group, hooks: rest });
    }
    if (kept.length || !dropEmpty) hooks[event] = kept;
    else delete hooks[event];
  }
}

function readManifest(path: string): Manifest | null {
  const text = readText(path);
  return text ? (JSON.parse(text) as Manifest) : null;
}

const serialize = (value: Json) => `${JSON.stringify(value, null, 2)}\n`;

export function planInstall(paths: InstallPaths, target: { claude: boolean; codex: boolean }, launcher: Launcher, skillText: string, now: Date): InstallPlan {
  const previous = readManifest(paths.manifest);
  const command = quote(paths.launcher);
  const tools = (['claude', 'codex'] as const).filter((tool) => target[tool]);
  const commands = tools.flatMap((tool) => entries(tool, command).map((e) => String(e.group.hooks![0]!.command)));
  const stale = new Set([...(previous?.commands ?? []), ...commands]);
  const changes: FileChange[] = [];
  const created = new Set(previous?.created ?? []);
  const files: string[] = [];

  for (const tool of tools) {
    const path = tool === 'claude' ? paths.claudeSettings : paths.codexHooks;
    const before = readText(path);
    const fallback: Json = tool === 'codex' ? { description: CODEX_DESCRIPTION, hooks: {} } : {};
    const doc = parseJson(path, before, fallback);
    const hooks = (typeof doc.hooks === 'object' && doc.hooks !== null ? doc.hooks : {}) as HookMap;
    removeCommands(hooks, stale, false);
    for (const { event, group } of entries(tool, command)) (hooks[event] ??= []).push(group);
    doc.hooks = hooks;
    const after = serialize(doc);
    if (before === null) created.add(path);
    files.push(path);
    if (after !== before) changes.push({ path, before, after });
    const skill = tool === 'claude' ? paths.claudeSkill : paths.codexSkill;
    const skillBefore = readText(skill);
    if (skillBefore !== skillText) changes.push({ path: skill, before: skillBefore, after: skillText });
  }

  const launcherText = launcherScript(launcher);
  const launcherBefore = readText(paths.launcher);
  if (launcherBefore !== launcherText) changes.push({ path: paths.launcher, before: launcherBefore, after: launcherText, mode: 0o755 });

  const notes = [
    'batonpass keeps everything in ~/.baton. The default strategy makes no network calls; see docs/privacy.md before enabling jev-select, which sends redacted dialogue text to TypeSafe.',
  ];
  if (target.codex) {
    notes.push('Codex asks you to review and trust new hooks: open Codex, run /hooks, and trust the three batonpass hooks.');
    const config = readText(paths.codexConfig) ?? '';
    if (/^\s*\[\[?hooks[.\]]/m.test(config)) notes.push('Your Codex config.toml also has inline [hooks]; Codex merges both and warns at startup.');
  }
  const manifest: Manifest = {
    version: 1,
    installedAt: now.toISOString(),
    tools: [...new Set([...(previous?.tools ?? []), ...tools])],
    commands: [...new Set([...(previous?.commands ?? []).filter((c) => !commands.some((n) => n.split(' hook ')[1] === c.split(' hook ')[1])), ...commands])],
    files: [...new Set([...(previous?.files ?? []), ...files])],
    created: [...created],
    skills: [...new Set([...(previous?.skills ?? []), ...tools.map((t) => (t === 'claude' ? paths.claudeSkill : paths.codexSkill))])],
    launcher: paths.launcher,
  };
  return { changes, manifest, notes };
}

export function planUninstall(paths: InstallPaths): InstallPlan {
  const manifest = readManifest(paths.manifest);
  if (!manifest) return { changes: [], manifest: null, notes: ['batonpass hooks are not installed.'] };
  const commands = new Set(manifest.commands);
  const changes: FileChange[] = [];
  for (const path of manifest.files) {
    const before = readText(path);
    if (before === null) continue;
    const doc = parseJson(path, before, {});
    const hooks = (typeof doc.hooks === 'object' && doc.hooks !== null ? doc.hooks : {}) as HookMap;
    removeCommands(hooks, commands, true);
    if (Object.keys(hooks).length) doc.hooks = hooks;
    else delete doc.hooks;
    const emptyCodex = doc.description === CODEX_DESCRIPTION && Object.keys(doc).length === 1;
    const after = manifest.created.includes(path) && (Object.keys(doc).length === 0 || emptyCodex) ? null : serialize(doc);
    if (after !== before) changes.push({ path, before, after });
  }
  for (const skill of [...manifest.skills, ...(manifest.launcher ? [manifest.launcher] : [])]) {
    const before = readText(skill);
    if (before !== null) changes.push({ path: skill, before, after: null });
  }
  return { changes, manifest: null, notes: ['Removed the batonpass hooks and skills. Your ledger in ~/.baton is kept; delete it yourself if you want.'] };
}

export function applyPlan(paths: InstallPaths, plan: InstallPlan, now: Date): void {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  for (const change of plan.changes) {
    if (change.before !== null) {
      const backup = join(paths.backups, stamp, change.path.replace(/^\/+/, '').replace(/[\\/]/g, '__'));
      mkdirSync(dirname(backup), { recursive: true, mode: 0o700 });
      writeFileSync(backup, change.before, { mode: 0o600 });
    }
    if (change.after === null) {
      rmSync(change.path, { force: true });
      try {
        rmdirSync(dirname(change.path));
      } catch {
        // Directory not empty or already gone: leave it.
      }
    } else {
      mkdirSync(dirname(change.path), { recursive: true });
      writeFileSync(change.path, change.after);
      if (change.mode !== undefined) chmodSync(change.path, change.mode);
    }
  }
  if (plan.manifest) writeFileSync(paths.manifest, serialize(plan.manifest as unknown as Json), { mode: 0o600 });
  else rmSync(paths.manifest, { force: true });
}

export function renderDiff(changes: FileChange[]): string {
  return changes
    .map((c) => {
      const a = c.before === null ? [] : c.before.split('\n');
      const b = c.after === null ? [] : c.after.split('\n');
      let start = 0;
      while (start < a.length && start < b.length && a[start] === b[start]) start++;
      let endA = a.length;
      let endB = b.length;
      while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
        endA--;
        endB--;
      }
      return [
        `--- ${c.before === null ? '/dev/null' : c.path}`,
        `+++ ${c.after === null ? '/dev/null' : c.path}`,
        `@@ line ${start + 1} @@`,
        ...a.slice(start, endA).map((line) => `-${line}`),
        ...b.slice(start, endB).map((line) => `+${line}`),
      ].join('\n');
    })
    .join('\n\n');
}

export function hookStatus(paths: InstallPaths): Check[] {
  const manifest = readManifest(paths.manifest);
  if (!manifest) return [[null, 'Hooks not installed: run `baton install`']];
  const checks: Check[] = manifest.tools.map((tool) => {
    const text = readText(tool === 'claude' ? paths.claudeSettings : paths.codexHooks) ?? '';
    const mine = manifest.commands.filter((c) => c.endsWith(`--tool ${tool}`));
    const present = mine.filter((c) => text.includes(JSON.stringify(c))).length;
    const label = tool === 'claude' ? 'Claude Code' : 'Codex';
    return [present === mine.length && present > 0, `${label} hooks installed (${present} of ${mine.length})`] as Check;
  });
  const targets = launcherTargets(readText(paths.launcher) ?? '');
  if (!targets || !existsSync(targets.node) || !existsSync(targets.script)) {
    checks.push([false, 'Hook launcher points to a missing Node or batonpass: run `baton install` again']);
  }
  return checks;
}
