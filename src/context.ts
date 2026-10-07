import { appendFileSync, renameSync, statSync } from 'node:fs';
import { JevClient } from 'fast-jev-compaction';
import type { BatonConfig } from './config.ts';
import { createJevSelector } from './select/jev.ts';
import type { Selector } from './snapshot.ts';
import { join } from 'node:path';
import { ensureHome, loadConfig } from './config.ts';
import { collectFacts } from './facts.ts';
import { Ledger } from './ledger.ts';
import { createResolver } from './project.ts';
import { redact, REDACTOR_VERSION } from './redact.ts';
import { createClaudeReader } from './readers/claude.ts';
import { createCodexReader } from './readers/codex.ts';
import { recentSelector, type RefreshDeps } from './snapshot.ts';

export interface Context extends RefreshDeps {
  env: NodeJS.ProcessEnv;
  log(event: string, detail?: Record<string, unknown>): void;
  close(): void;
}

const LOG_MAX_BYTES = 1024 * 1024;

export function appendLog(home: string, event: string, detail: Record<string, unknown>): void {
  const path = join(home, 'logs', 'baton.log');
  try {
    if (statSync(path).size > LOG_MAX_BYTES) renameSync(path, `${path}.1`);
  } catch {
    // No log yet.
  }
  appendFileSync(path, `${new Date().toISOString()} ${event} ${JSON.stringify(detail)}\n`, { mode: 0o600 });
}

const JEV_TIMEOUT_MS = 20_000;

export function chooseSelector(config: BatonConfig, env: NodeJS.ProcessEnv, ledger: Ledger): Selector {
  if (config.select.strategy !== 'jev-select') return recentSelector;
  const apiKey = env[config.jev.apiKeyEnv];
  const asker = apiKey
    ? new JevClient({ apiKey, model: config.jev.model, fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(JEV_TIMEOUT_MS) }) })
    : null;
  return createJevSelector({ asker, ledger });
}

export function createContext(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Context> = {}): Context {
  const config = loadConfig(env);
  ensureHome(config.home);
  const ledger = new Ledger(join(config.home, 'baton.db'));
  // A ledger written before a redaction rule changed is scrubbed again, once.
  ledger.reRedact(REDACTOR_VERSION, (text) => redact(text).text);
  return {
    env,
    config,
    ledger,
    readers: [createCodexReader(config.sources.codexHome), createClaudeReader(config.sources.claudeProjects)],
    resolve: createResolver(config.aliases),
    now: () => new Date(),
    facts: (root) => collectFacts(root),
    select: chooseSelector(config, env, ledger),
    log: (event, detail = {}) => appendLog(config.home, event, detail),
    close: () => ledger.close(),
    ...overrides,
  };
}

/** Seconds by which the newest known transcript of the project is newer than the snapshot. */
export function staleSeconds(ctx: Context, projectId: string, createdAt: string): number {
  let newest = 0;
  for (const path of ctx.ledger.sourcePathsForProject(projectId)) {
    try {
      newest = Math.max(newest, statSync(path).mtimeMs);
    } catch {
      // A deleted transcript cannot make the snapshot stale.
    }
  }
  return Math.max(0, (newest - Date.parse(createdAt)) / 1000);
}
