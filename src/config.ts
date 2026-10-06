import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';

export interface BatonConfig {
  home: string;
  backfill: { maxBytes: number; days: number };
  retention: { days: number; snapshots: number };
  reader: { maxLineBytes: number };
  render: {
    briefTokens: number;
    fullTokens: number;
    briefDialogueTokens: number;
    fullDialogueTokens: number;
    staleAfterSeconds: number;
    timeZone: string;
  };
  select: { strategy: 'recent-dialogue' | 'jev-select'; protectRecentTurns: number };
  jev: {
    model: string;
    dropThreshold: number;
    maxRequestsPerIngest: number;
    maxInputTokensPerDay: number;
    rules: boolean;
    apiKeyEnv: string;
  };
  /** Undelivered messages older than this are no longer injected by hooks (`baton inbox` still lists them). */
  messages: { maxAgeHours: number };
  aliases: Record<string, string>;
  sources: { codexHome: string; claudeProjects: string };
  eval: { answerCommand: string[] };
}

function userHome(env: NodeJS.ProcessEnv): string {
  return env.HOME ?? homedir();
}

export function expandHome(path: string, env: NodeJS.ProcessEnv): string {
  return path === '~' ? userHome(env) : path.startsWith('~/') ? join(userHome(env), path.slice(2)) : path;
}

export function batonHome(env: NodeJS.ProcessEnv): string {
  return resolve(env.BATON_HOME ? expandHome(env.BATON_HOME, env) : join(userHome(env), '.baton'));
}

export function defaultConfig(home: string, env: NodeJS.ProcessEnv): BatonConfig {
  return {
    home,
    backfill: { maxBytes: 64 * 1024 * 1024, days: 30 },
    retention: { days: 90, snapshots: 50 },
    reader: { maxLineBytes: 8 * 1024 * 1024 },
    render: {
      briefTokens: 2000,
      fullTokens: 10000,
      briefDialogueTokens: 1300,
      fullDialogueTokens: 8000,
      staleAfterSeconds: 900,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    select: { strategy: 'recent-dialogue', protectRecentTurns: 2 },
    jev: {
      model: 'jev-latest',
      dropThreshold: 0.2,
      maxRequestsPerIngest: 4,
      maxInputTokensPerDay: 2_000_000,
      rules: false,
      apiKeyEnv: 'TYPESAFE_API_KEY',
    },
    messages: { maxAgeHours: 24 },
    aliases: {},
    sources: {
      codexHome: env.CODEX_HOME ? expandHome(env.CODEX_HOME, env) : join(userHome(env), '.codex'),
      claudeProjects: join(userHome(env), '.claude', 'projects'),
    },
    eval: { answerCommand: ['claude', '-p', '--no-session-persistence'] },
  };
}

export function ensureHome(home: string): void {
  mkdirSync(join(home, 'logs'), { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function mergeConfig(base: BatonConfig, raw: Record<string, unknown>, env: NodeJS.ProcessEnv): BatonConfig {
  const out = structuredClone(base) as unknown as Record<string, unknown>;
  for (const [section, value] of Object.entries(raw)) {
    if (section === 'aliases' && isObject(value)) {
      const aliases: Record<string, string> = {};
      for (const [path, id] of Object.entries(value)) if (typeof id === 'string') aliases[expandHome(path, env)] = id;
      out.aliases = aliases;
      continue;
    }
    const target = out[section];
    if (!isObject(target) || !isObject(value)) continue;
    for (const [key, next] of Object.entries(value)) {
      if (!(key in target)) continue;
      const current = target[key];
      const sameKind = Array.isArray(current) ? Array.isArray(next) : typeof current === typeof next;
      if (sameKind) target[key] = next;
    }
  }
  const merged = out as unknown as BatonConfig;
  merged.sources.codexHome = expandHome(merged.sources.codexHome, env);
  merged.sources.claudeProjects = expandHome(merged.sources.claudeProjects, env);
  return merged;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BatonConfig {
  const home = batonHome(env);
  const base = defaultConfig(home, env);
  const file = join(home, 'config.toml');
  if (!existsSync(file)) return base;
  return mergeConfig(base, parseToml(readFileSync(file, 'utf8')) as Record<string, unknown>, env);
}
