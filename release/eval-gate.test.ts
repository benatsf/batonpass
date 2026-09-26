import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultConfig } from '../src/config.ts';
import { CASES_DIR, gate, loadCases, type Scorecard } from '../src/eval.ts';

const RESULTS = join(import.meta.dirname, '..', 'evals', 'results');
const cards = readdirSync(RESULTS).filter((f) => /^SCORECARD-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
const card = cards.length ? (JSON.parse(readFileSync(join(RESULTS, cards.at(-1)!), 'utf8')) as Scorecard) : null;
const defaults = defaultConfig('/unused', {});
const row = (strategy: string) => card?.rows.find((r) => r.strategy === strategy && r.status === 'ok');

test('a published scorecard exists and covers every shipped case', () => {
  assert.ok(card, 'run `baton eval --out evals/results` and commit the scorecard');
  assert.equal(card.cases, loadCases(CASES_DIR).length);
  assert.ok(card.cases >= 8, 'at least 8 cases');
  assert.ok(card.probes >= 60, 'at least 60 probes');
});

test('the scorecard includes the no-context floor', () => {
  assert.ok(row('no-context'), 'run the evaluation with the no-context strategy');
});

test('the default strategy is at least as good as recent-dialogue on both measures', () => {
  assert.ok(card && gate(card, defaults.select.strategy));
});

test('jev.rules stays off unless it does not lower either measure', () => {
  if (!defaults.jev.rules) return;
  const rules = row('jev-select+rules');
  const plain = row('jev-select');
  assert.ok(rules && plain && rules.recallBrief >= plain.recallBrief && rules.recallSearch >= plain.recallSearch);
});
