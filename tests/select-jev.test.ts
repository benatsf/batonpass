import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JevAsker, JevQuestions, JevResponse, JevState, NoulQuestion } from 'fast-jev-compaction';
import { defaultConfig } from '../src/config.ts';
import { chooseSelector } from '../src/context.ts';
import { Ledger } from '../src/ledger.ts';
import type { Turn } from '../src/select/dialogue.ts';
import { createJevSelector, type JevSelectorOptions } from '../src/select/jev.ts';
import { recentSelector, type SelectorInput } from '../src/snapshot.ts';

type Judge = (text: string, kind: 'keep' | 'rule') => number;

class FakeAsker implements JevAsker {
  calls: Array<{ state: JevState; questions: JevQuestions }> = [];
  judge: Judge;
  fail: Error | null = null;
  constructor(judge: Judge) {
    this.judge = judge;
  }
  async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
    this.calls.push({ state, questions });
    if (this.fail) throw this.fail;
    const history = (state as { history: Array<{ i: number; text: string }> }).history;
    const answers: JevResponse['answers'] = {};
    for (const [name, q] of Object.entries(questions)) {
      const i = Number(/i=(\d+)/.exec((q as NoulQuestion).instructions)![1]);
      answers[name] = { noul: this.judge(history.find((h) => h.i === i)?.text ?? '', name.startsWith('r') ? 'rule' : 'keep') };
    }
    return { answers, usage: { input_tokens: 1000 } };
  }
}

const DECISION = `Decision: billing stays on Postgres, never MySQL. ${'d'.repeat(120)}`;
const TEXTS = [DECISION, ...Array.from({ length: 15 }, (_, i) => `chatter ${i} ${'c'.repeat(120)}`), 'Latest: deploy to staging.', 'Newest: run the tests.'];
const chatterIsNoise: Judge = (text, kind) => (kind === 'rule' ? (text.includes('never') ? 0.9 : 0.1) : text.startsWith('chatter') ? 0.05 : 0.9);

function turnsOf(texts: string[]): Turn[] {
  return texts.map((user, i) => {
    const ts = new Date(Date.UTC(2026, 8, 26, 0, i)).toISOString();
    return { key: `codex:s:${i}`, tool: 'codex', sessionId: 's', ts, user, reply: `ok ${i}`, replyTs: ts };
  });
}

function setup(over: { rules?: boolean; maxRequests?: number; maxDaily?: number } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'baton-jev-'));
  const config = defaultConfig(home, { HOME: home });
  config.render.timeZone = 'UTC';
  config.render.briefDialogueTokens = 200;
  config.render.fullDialogueTokens = 400;
  config.select.strategy = 'jev-select';
  config.jev.rules = over.rules ?? false;
  config.jev.maxRequestsPerIngest = over.maxRequests ?? 4;
  config.jev.maxInputTokensPerDay = over.maxDaily ?? 2_000_000;
  const ledger = new Ledger(join(home, 'baton.db'));
  const input = (texts: string[] = TEXTS): SelectorInput => ({ projectId: 'p', turns: turnsOf(texts), pinnedText: 'Ship the billing refactor', config, now: new Date('2026-09-26T18:00:00Z') });
  const select = (asker: JevAsker | null, extra: Partial<JevSelectorOptions> = {}) => createJevSelector({ asker, ledger, ...extra });
  return { config, ledger, input, select };
}

const keys = (turns: Array<{ key: string }>) => turns.map((t) => t.key);

test('under budget it behaves like recent-dialogue and asks nothing', async () => {
  const t = setup();
  const asker = new FakeAsker(chatterIsNoise);
  const input = t.input(['short one', 'short two']);
  const out = await t.select(asker)(input);
  assert.equal(asker.calls.length, 0);
  assert.deepEqual(keys(out.brief), keys((await recentSelector(input)).brief));
  assert.deepEqual(out.stats, { strategy: 'jev-select', jev: 'skipped:fits' });
});

test('drops confident chatter so an older decision survives the cut', async () => {
  const t = setup();
  const asker = new FakeAsker(chatterIsNoise);
  const out = await t.select(asker)(t.input());
  const recent = await recentSelector(t.input());
  assert.ok(!keys(recent.full).includes('codex:s:0'));
  assert.ok(keys(out.full).includes('codex:s:0'));
  assert.ok(keys(out.brief).includes('codex:s:0'));
  assert.equal(out.full.find((x) => x.key === 'codex:s:0')!.reason, 'jev-keep');
  assert.equal(out.full.at(-1)!.reason, 'protected');
  assert.equal(asker.calls.length, 1);
  const questions = Object.values(asker.calls[0]!.questions) as NoulQuestion[];
  assert.equal(questions.length, 16);
  assert.ok(questions.every((q) => !/i=(32|34) \(user\)/.test(q.instructions)));
  assert.equal(out.stats.jev, 'ok');
  assert.equal(t.ledger.jevSpend('2026-09-26'), 1000);
  assert.equal(out.stats.jevInputTokens, 1000);
});

test('unconfident answers never drop a turn', async () => {
  const t = setup();
  const out = await t.select(new FakeAsker((_, kind) => (kind === 'keep' ? 0.3 : 0)))(t.input());
  assert.deepEqual(keys(out.full), keys((await recentSelector(t.input())).full));
});

test('decisions are cached per turn and model', async () => {
  const t = setup();
  const asker = new FakeAsker(chatterIsNoise);
  await t.select(asker)(t.input());
  const again = await t.select(asker)(t.input());
  assert.equal(asker.calls.length, 1);
  assert.equal(again.stats.jev, 'cached');
  assert.ok(keys(again.full).includes('codex:s:0'));
});

test('the daily cap, a missing key and errors fall back to recency', async () => {
  const capped = setup({ maxDaily: 10 });
  const asker = new FakeAsker(chatterIsNoise);
  const out = await capped.select(asker)(capped.input());
  assert.equal(asker.calls.length, 0);
  assert.equal(out.stats.jev, 'skipped:daily-cap');
  assert.deepEqual(keys(out.full), keys((await recentSelector(capped.input())).full));

  const noKey = setup();
  assert.equal((await noKey.select(null)(noKey.input())).stats.jev, 'skipped:no-key');

  const failing = setup();
  const broken = new FakeAsker(chatterIsNoise);
  broken.fail = new TypeError('fetch failed');
  const fallback = await failing.select(broken)(failing.input());
  assert.equal(fallback.stats.jev, 'error:TypeError');
  assert.deepEqual(keys(fallback.full), keys((await recentSelector(failing.input())).full));
});

test('the request cap stops after the allowed number of requests', async () => {
  const t = setup({ maxRequests: 1 });
  const asker = new FakeAsker(chatterIsNoise);
  const out = await t.select(asker, { maxQuestionsPerRequest: 5 })(t.input());
  assert.equal(asker.calls.length, 1);
  assert.equal(out.stats.jev, 'partial:request-cap');
});

test('experimental standing rules are extracted verbatim', async () => {
  const t = setup({ rules: true });
  const asker = new FakeAsker(chatterIsNoise);
  const out = await t.select(asker)(t.input());
  assert.equal(out.rules.length, 1);
  assert.ok(out.rules[0]!.text.startsWith('Decision: billing stays on Postgres, never MySQL.'));
  const ruleQuestions = Object.keys(asker.calls[0]!.questions).filter((name) => name.startsWith('r'));
  assert.equal(ruleQuestions.length, 18);
});

test('chooseSelector uses recency unless jev-select is configured', async () => {
  const t = setup();
  t.config.select.strategy = 'recent-dialogue';
  assert.equal(chooseSelector(t.config, {}, t.ledger), recentSelector);
  t.config.select.strategy = 'jev-select';
  const out = await chooseSelector(t.config, {}, t.ledger)(t.input());
  assert.equal(out.stats.jev, 'skipped:no-key');
});
