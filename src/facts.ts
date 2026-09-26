import { execFileSync } from 'node:child_process';
import type { PrFact, RepoFacts } from './types.ts';

export type CommandRunner = (cmd: string, args: string[], cwd: string, timeoutMs: number) => string | null;

export const defaultRunner: CommandRunner = (cmd, args, cwd, timeoutMs) => {
  try {
    return execFileSync(cmd, args, { cwd, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 4 * 1024 * 1024 }).trim();
  } catch {
    return null;
  }
};

const PASSED = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const FAILED = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);

function summarizeChecks(rollup: unknown): string {
  if (!Array.isArray(rollup) || rollup.length === 0) return 'no checks';
  let passed = 0;
  let failed = 0;
  let pending = 0;
  for (const check of rollup as Array<Record<string, unknown>>) {
    const state = String(check.conclusion ?? check.state ?? '').toUpperCase();
    if (PASSED.has(state)) passed++;
    else if (FAILED.has(state)) failed++;
    else pending++;
  }
  return [passed && `${passed} passed`, failed && `${failed} failed`, pending && `${pending} pending`].filter(Boolean).join(', ');
}

function parsePrs(raw: string | null): PrFact[] | null {
  if (!raw) return null;
  try {
    return (JSON.parse(raw) as Array<Record<string, unknown>>).map((pr) => ({
      number: Number(pr.number),
      title: String(pr.title ?? ''),
      isDraft: Boolean(pr.isDraft),
      checks: summarizeChecks(pr.statusCheckRollup),
    }));
  } catch {
    return null;
  }
}

export function collectFacts(root: string, run: CommandRunner = defaultRunner, budgetMs = 1500, clock: () => number = Date.now): RepoFacts {
  const deadline = clock() + budgetMs;
  const call = (cmd: string, args: string[]): string | null => {
    const left = deadline - clock();
    return left <= 0 ? null : run(cmd, args, root, Math.min(left, 1000));
  };
  const branch = call('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  const headLine = call('git', ['log', '-1', '--format=%h%x09%s']);
  const [head, subject] = headLine ? headLine.split('\t') : [];
  const counts = call('git', ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']);
  const [behind, ahead] = counts ? counts.split(/\s+/).map(Number) : [];
  // --no-optional-locks: never take index.lock, so the agent's own git commands are not blocked.
  const status = call('git', ['--no-optional-locks', 'status', '--porcelain']);
  const log = call('git', ['log', '-5', '--format=%h %s']);
  const prs = call('gh', ['pr', 'list', '--state', 'open', '--limit', '10', '--json', 'number,title,isDraft,statusCheckRollup']);
  return {
    branch: branch || null,
    head: head || null,
    subject: subject || null,
    ahead: Number.isFinite(ahead) ? ahead! : null,
    behind: Number.isFinite(behind) ? behind! : null,
    changedFiles: status === null ? null : status === '' ? 0 : status.split('\n').length,
    recentCommits: log ? log.split('\n') : [],
    openPrs: parsePrs(prs),
  };
}
