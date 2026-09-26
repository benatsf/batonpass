import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateTokens, type JevAsker } from 'fast-jev-compaction';
import { createContext, type Context } from './context.ts';
import { writeSession, type ScriptSession, type ScriptTurn } from './script.ts';
import { abridge, formatTime, toolLabel } from './select/dialogue.ts';
import { createJevSelector } from './select/jev.ts';
import { refresh } from './snapshot.ts';

export const EVAL_ROOT = '/batonpass-eval';
export const CASES_DIR = fileURLToPath(new URL('../evals/cases', import.meta.url));
export const JEV_USD_PER_MTOK = 0.042;

export type ProbeKind = 'decision' | 'constraint' | 'identifier' | 'verified' | 'open';

export interface Probe {
  id: string;
  kind: ProbeKind;
  question: string;
  answer: string;
  accept?: string[];
}

export interface EvalCase {
  name: string;
  description: string;
  sessions: ScriptSession[];
  probes: Probe[];
  now: Date;
}

export type Strategy = 'no-context' | 'recent-dialogue' | 'jev-select' | 'jev-select+rules';
export const STRATEGIES: Strategy[] = ['no-context', 'recent-dialogue', 'jev-select', 'jev-select+rules'];

export type Answerer = (prompt: string) => Promise<string>;

export interface ProbeResult {
  case: string;
  probe: string;
  strategy: Strategy;
  briefOnly: { answer: string; pass: boolean };
  withSearch: { query: string; answer: string; pass: boolean };
}

export interface StrategyRow {
  strategy: Strategy;
  status: 'ok' | 'skipped:no-key';
  probes: number;
  passBrief: number;
  passSearch: number;
  recallBrief: number;
  recallSearch: number;
  briefTokens: number;
  refreshMs: number;
  jevInputTokens: number;
  costUsd: number;
  answerErrors: number;
}

export interface Scorecard {
  date: string;
  answerCommand: string;
  cases: number;
  probes: number;
  rows: StrategyRow[];
  results: ProbeResult[];
}

export interface EvalOptions {
  cases: EvalCase[];
  strategies: Strategy[];
  answer: Answerer;
  answerCommand: string;
  env: NodeJS.ProcessEnv;
  concurrency?: number;
  asker?: JevAsker | null;
  date?: string;
}

interface CaseTurn {
  user: string;
  reply: string;
  repeat?: number;
}

interface CaseSession {
  tool: 'codex' | 'claude';
  id: string;
  title?: string;
  goal?: string;
  pr?: { number: number; repo: string; url: string };
  compactAfterTurn?: number;
  cwdSuffix?: string;
  turns: CaseTurn[];
}

const TURN_GAP_MS = 7 * 60_000;
const SESSION_GAP_MS = 60 * 60_000;

export function tokens(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

export function grade(response: string, probe: Probe): boolean {
  const have = new Set(tokens(response));
  return [probe.answer, ...(probe.accept ?? [])].some((option) => {
    const need = tokens(option);
    return need.length > 0 && need.every((t) => have.has(t));
  });
}

export function loadCase(dir: string): EvalCase {
  const name = basename(dir);
  const file = JSON.parse(readFileSync(join(dir, 'history.json'), 'utf8')) as { description: string; start: string; sessions: CaseSession[] };
  const probes = JSON.parse(readFileSync(join(dir, 'probes.json'), 'utf8')) as Probe[];
  let t = Date.parse(file.start);
  const sessions = file.sessions.map((s): ScriptSession => {
    const turns: ScriptTurn[] = [];
    for (const turn of s.turns) {
      for (let n = 1; n <= (turn.repeat ?? 1); n++) {
        const fill = (text: string) => text.replaceAll('{n}', String(n));
        turns.push({ at: new Date(t).toISOString(), user: fill(turn.user), reply: fill(turn.reply) });
        t += TURN_GAP_MS;
      }
    }
    t += SESSION_GAP_MS;
    return { tool: s.tool, id: s.id, cwd: `${EVAL_ROOT}/${name}${s.cwdSuffix ?? ''}`, title: s.title, goal: s.goal, pr: s.pr, compactAfterTurn: s.compactAfterTurn, turns };
  });
  return { name, description: file.description, sessions, probes, now: new Date(t) };
}

export function loadCases(root: string): EvalCase[] {
  return readdirSync(root)
    .filter((entry) => statSync(join(root, entry)).isDirectory())
    .sort()
    .map((entry) => loadCase(join(root, entry)));
}

export function commandAnswerer(command: string[], env: NodeJS.ProcessEnv, cwd: string, timeoutMs = 180_000): Answerer {
  return (prompt) =>
    new Promise((resolve) => {
      const [cmd, ...args] = command;
      const child = spawn(cmd!, args, { cwd, env: { ...env, BATON_HOOK: '1', BATON_SKIP_INJECT: '1' }, stdio: ['pipe', 'pipe', 'ignore'] });
      let out = '';
      const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
      child.on('error', () => {
        clearTimeout(timer);
        resolve('');
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve(code === 0 ? out.trim() : '');
      });
      child.stdin.end(prompt);
    });
}

const withContext = (context: string) => (context ? `${context}\n\n` : '');
const BRIEF_PROMPT = (context: string, question: string) =>
  `${withContext(context)}Answer the question from the context above only. If the context does not contain the answer, reply exactly UNKNOWN.\nQuestion: ${question}\nReply with the answer only, in one short line.`;
const QUERY_PROMPT = (context: string, question: string) =>
  `${withContext(context)}Before answering, you may run one full-text search over the earlier history of this project. Reply with only the search words (two to six words) most likely to find the answer to this question: ${question}`;
const SEARCH_PROMPT = (context: string, query: string, results: string, question: string) =>
  `${withContext(context)}Search results for "${query}":\n${results || '(no matches)'}\n\nAnswer the question from the context and the search results only. If they do not contain the answer, reply exactly UNKNOWN.\nQuestion: ${question}\nReply with the answer only, in one short line.`;

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

interface Prepared {
  ctx: Context;
  projectId: string;
  brief: string;
  refreshMs: number;
  jevInputTokens: number;
  cleanup(): void;
}

async function prepareCase(c: EvalCase, strategy: Strategy, baseEnv: NodeJS.ProcessEnv, asker: JevAsker | null | undefined): Promise<Prepared> {
  const root = mkdtempSync(join(tmpdir(), `baton-eval-${c.name}-`));
  for (const s of c.sessions) writeSession(root, s);
  const home = join(root, '.baton');
  mkdirSync(home, { recursive: true });
  const jev = strategy.startsWith('jev-select');
  writeFileSync(
    join(home, 'config.toml'),
    [
      '[select]',
      `strategy = "${jev ? 'jev-select' : 'recent-dialogue'}"`,
      '[jev]',
      `rules = ${strategy === 'jev-select+rules'}`,
      '[render]',
      'timeZone = "UTC"',
      '[aliases]',
      `"${EVAL_ROOT}/${c.name}" = "eval/${c.name}"`,
    ].join('\n'),
  );
  const env: NodeJS.ProcessEnv = { HOME: root, BATON_HOME: home, PATH: baseEnv.PATH, TYPESAFE_API_KEY: baseEnv.TYPESAFE_API_KEY };
  const ctx = createContext(env, { now: () => c.now, facts: () => null });
  if (jev && asker !== undefined) ctx.select = createJevSelector({ asker, ledger: ctx.ledger });
  const projectId = `eval/${c.name}`;
  const started = performance.now();
  await refresh(ctx, { projectId, root: null });
  const refreshMs = performance.now() - started;
  const snapshot = ctx.ledger.latestSnapshot(projectId);
  if (!snapshot) {
    ctx.close();
    throw new Error(`Case ${c.name} produced no snapshot`);
  }
  return {
    ctx,
    projectId,
    brief: strategy === 'no-context' ? '' : snapshot.brief,
    refreshMs,
    jevInputTokens: ctx.ledger.jevSpend(c.now.toISOString().slice(0, 10)),
    cleanup: () => {
      ctx.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function skippedRow(strategy: Strategy, probes: number): StrategyRow {
  return { strategy, status: 'skipped:no-key', probes, passBrief: 0, passSearch: 0, recallBrief: 0, recallSearch: 0, briefTokens: 0, refreshMs: 0, jevInputTokens: 0, costUsd: 0, answerErrors: 0 };
}

export async function runEval(o: EvalOptions): Promise<Scorecard> {
  const probes = o.cases.reduce((n, c) => n + c.probes.length, 0);
  const rows: StrategyRow[] = [];
  const results: ProbeResult[] = [];
  for (const strategy of o.strategies) {
    const hasAsker = o.asker !== undefined ? o.asker !== null : Boolean(o.env.TYPESAFE_API_KEY);
    if (strategy.startsWith('jev-select') && !hasAsker) {
      rows.push(skippedRow(strategy, probes));
      continue;
    }
    let passBrief = 0;
    let passSearch = 0;
    let briefTokens = 0;
    let refreshMs = 0;
    let jevInputTokens = 0;
    let answerErrors = 0;
    for (const c of o.cases) {
      const prepared = await prepareCase(c, strategy, o.env, o.asker);
      try {
        briefTokens += estimateTokens(prepared.brief);
        refreshMs += prepared.refreshMs;
        jevInputTokens += prepared.jevInputTokens;
        const caseResults = await mapLimit(c.probes, o.concurrency ?? 4, async (probe): Promise<ProbeResult> => {
          const briefAnswer = await o.answer(BRIEF_PROMPT(prepared.brief, probe.question));
          const query = (await o.answer(QUERY_PROMPT(prepared.brief, probe.question))).split('\n')[0]!.trim().slice(0, 100);
          const hits = query ? prepared.ctx.ledger.search(prepared.projectId, query, 5) : [];
          const found = hits.map((e) => `[${toolLabel(e.tool)} · ${formatTime(e.ts, 'UTC')} · ${e.kind}] ${abridge(e.text, 600).text}`).join('\n');
          const searchAnswer = await o.answer(SEARCH_PROMPT(prepared.brief, query, found, probe.question));
          return {
            case: c.name,
            probe: probe.id,
            strategy,
            briefOnly: { answer: briefAnswer, pass: grade(briefAnswer, probe) },
            withSearch: { query, answer: searchAnswer, pass: grade(searchAnswer, probe) },
          };
        });
        for (const r of caseResults) {
          results.push(r);
          if (r.briefOnly.pass) passBrief++;
          if (r.withSearch.pass) passSearch++;
          if (!r.briefOnly.answer || !r.withSearch.answer) answerErrors++;
        }
      } finally {
        prepared.cleanup();
      }
    }
    const n = probes || 1;
    rows.push({
      strategy,
      status: 'ok',
      probes,
      passBrief,
      passSearch,
      recallBrief: passBrief / n,
      recallSearch: passSearch / n,
      briefTokens: Math.round(briefTokens / (o.cases.length || 1)),
      refreshMs: Math.round(refreshMs / (o.cases.length || 1)),
      jevInputTokens,
      costUsd: (jevInputTokens / 1_000_000) * JEV_USD_PER_MTOK,
      answerErrors,
    });
  }
  return { date: o.date ?? new Date().toISOString().slice(0, 10), answerCommand: o.answerCommand, cases: o.cases.length, probes, rows, results };
}

const answerErrors = (card: Scorecard) => card.rows.reduce((n, r) => n + r.answerErrors, 0);

export function gate(card: Scorecard, defaultStrategy: string): boolean {
  // Empty replies (rate limits, timeouts) make recall meaningless, so they fail the gate.
  if (answerErrors(card) > 0) return false;
  const row = (strategy: string) => card.rows.find((r) => r.strategy === strategy && r.status === 'ok');
  const chosen = row(defaultStrategy);
  const base = row('recent-dialogue');
  return Boolean(chosen && base && chosen.recallBrief >= base.recallBrief && chosen.recallSearch >= base.recallSearch);
}

const pct = (n: number, d: number) => `${((100 * n) / (d || 1)).toFixed(1)}% (${n}/${d})`;

export function renderScorecard(card: Scorecard, defaultStrategy = 'recent-dialogue'): string {
  const lines = [
    `# batonpass recall scorecard, ${card.date}`,
    '',
    `Answering command: \`${card.answerCommand}\` · cases: ${card.cases} · probes: ${card.probes}.`,
    'A probe passes when every word of the expected answer, or of one accepted paraphrase, appears in the reply.',
    '',
    '| Strategy | Recall, brief only | Recall, brief + one search | Brief tokens (avg) | Refresh ms (avg) | Jev input tokens | Jev cost |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...card.rows.map((r) =>
      r.status === 'ok'
        ? `| ${r.strategy} | ${pct(r.passBrief, r.probes)} | ${pct(r.passSearch, r.probes)} | ${r.briefTokens} | ${r.refreshMs} | ${r.jevInputTokens} | $${r.costUsd.toFixed(4)} |`
        : `| ${r.strategy} | skipped (no TypeSafe key) | – | – | – | – | – |`,
    ),
    '',
    answerErrors(card)
      ? `Release gate (spec 11.1): fails: ${answerErrors(card)} answering errors (empty replies or timeouts); rerun the evaluation.`
      : `Release gate (spec 11.1): the default strategy \`${defaultStrategy}\` ${gate(card, defaultStrategy) ? 'passes' : 'fails'} (at least as good as \`recent-dialogue\` on both measures).`,
  ];
  return `${lines.join('\n')}\n`;
}

export function writeScorecard(card: Scorecard, outDir: string): { markdown: string; json: string; raw: string } {
  const rawDir = join(outDir, card.date, 'raw');
  mkdirSync(rawDir, { recursive: true });
  const markdown = join(outDir, `SCORECARD-${card.date}.md`);
  const json = join(outDir, `SCORECARD-${card.date}.json`);
  const raw = join(rawDir, 'results.json');
  writeFileSync(markdown, renderScorecard(card));
  writeFileSync(json, `${JSON.stringify({ ...card, results: undefined }, null, 2)}\n`);
  writeFileSync(raw, `${JSON.stringify(card.results, null, 2)}\n`);
  return { markdown, json, raw };
}
