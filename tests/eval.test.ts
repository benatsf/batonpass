import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CASES_DIR, grade, loadCase, loadCases, renderScorecard, runEval, tokens, writeScorecard, type Answerer, type Probe } from '../src/eval.ts';

test('tokens fold case, accents and punctuation; grading needs every word', () => {
  assert.deepEqual(tokens('Français, RLS!'), ['francais', 'rls']);
  const probe: Probe = { id: 'p', kind: 'identifier', question: 'q', answer: 'billing_plans.stripe_price_id', accept: ['v7'] };
  assert.equal(grade('It is public.billing_plans, column stripe_price_id.', probe), true);
  assert.equal(grade('billing plans', probe), false);
  assert.equal(grade('Version: V7', probe), true);
  assert.equal(grade('UNKNOWN', probe), false);
});

test('loads a case: repeats expanded, turns spaced, both tools, alias path', () => {
  const c = loadCase(join(CASES_DIR, 'billing-migration'));
  assert.deepEqual(c.sessions.map((s) => s.tool), ['codex', 'claude']);
  assert.equal(c.sessions[0]!.turns.length, 17);
  assert.equal(c.sessions[0]!.turns[2]!.user, 'Check invoice template 1 against the new portal flow.');
  assert.equal(Date.parse(c.sessions[0]!.turns[1]!.at) - Date.parse(c.sessions[0]!.turns[0]!.at), 7 * 60_000);
  assert.equal(c.sessions[0]!.cwd, '/batonpass-eval/billing-migration');
  assert.ok(c.now > new Date(c.sessions[1]!.turns.at(-1)!.at));
});

/** An ideal reader: it "answers" with exactly the batonpass context and search results it was given. */
const oracle: Answerer = async (prompt) => {
  if (prompt.includes('Reply with only the search words')) return prompt.slice(prompt.lastIndexOf('question: ') + 'question: '.length);
  const context = /<baton-context[\s\S]*<\/baton-context>/.exec(prompt)?.[0] ?? '';
  const results = /Search results for[\s\S]*?\n\nAnswer the question/.exec(prompt)?.[0] ?? '';
  return `${context}\n${results}`.trim() || 'UNKNOWN';
};

const firstTwo = () => loadCases(CASES_DIR).filter((c) => c.name === 'billing-migration' || c.name === 'auth-hardening');

test('runs end to end: the brief beats no context, and one search adds recall', async () => {
  const card = await runEval({ cases: firstTwo(), strategies: ['no-context', 'recent-dialogue'], answer: oracle, answerCommand: 'oracle', env: { PATH: process.env.PATH }, date: '2026-09-26' });
  const [none, recent] = card.rows;
  assert.equal(card.probes, 16);
  assert.equal(card.results.length, 32);
  assert.equal(none!.passBrief, 0);
  assert.ok(none!.passSearch > 0);
  assert.ok(recent!.passBrief > 0);
  assert.ok(recent!.passBrief < 16, 'early facts fall outside the brief');
  assert.ok(recent!.passSearch > recent!.passBrief);
  const md = renderScorecard(card, 'recent-dialogue');
  assert.match(md, /\| recent-dialogue \| \d+\.\d% \(\d+\/16\) \| \d+\.\d% \(\d+\/16\) \|/);
  assert.match(md, /Release gate \(spec 11\.1\): the default strategy `recent-dialogue` passes/);
  const written = writeScorecard(card, mkdtempSync(join(tmpdir(), 'baton-card-')));
  assert.ok(existsSync(written.markdown) && existsSync(written.json) && existsSync(written.raw));
});

test('Jev rows run with an injected asker and are skipped without a key', async () => {
  const cases = firstTwo().filter((c) => c.name === 'billing-migration');
  const asker = {
    calls: 0,
    async ask(_state: unknown, questions: Record<string, unknown>) {
      this.calls++;
      return { answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { noul: 0.5 }])), usage: { input_tokens: 500 } };
    },
  };
  const card = await runEval({ cases, strategies: ['jev-select'], answer: oracle, answerCommand: 'oracle', env: {}, asker });
  assert.equal(card.rows[0]!.status, 'ok');
  assert.ok(asker.calls > 0);
  assert.ok(card.rows[0]!.jevInputTokens >= 500);
  const skipped = await runEval({ cases, strategies: ['jev-select+rules'], answer: oracle, answerCommand: 'oracle', env: {} });
  assert.equal(skipped.rows[0]!.status, 'skipped:no-key');
  assert.match(renderScorecard(skipped), /\| jev-select\+rules \| skipped \(no TypeSafe key\) \|/);
});
