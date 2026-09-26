import { estimateTokens, fitState, noulAnswer, type JevAsker, type JevQuestions, type Message, type NoulQuestion } from 'fast-jev-compaction';
import type { Ledger } from '../ledger.ts';
import type { DialogueSelection, Selector, SelectorInput } from '../snapshot.ts';
import { formatTurn, type SelectedTurn, type Turn } from './dialogue.ts';
import { selectRecent, turnTokens } from './recent.ts';
import { RULE_QUESTION_ID, ruleQuestion, standingRules } from './rules.ts';
import { SpendGuard } from './spend.ts';

export const KEEP_QUESTION_ID = 'keep_v1';

export const DIALOGUE_CONTEXT =
  "Earlier sessions of a coding agent on one project are being handed to a fresh session. `history` is the dialogue so far, oldest first: the user's messages and the agent's final replies; long texts may be abridged. `goal` holds the notes the user pinned and the current goals. A keep question asks whether one exchange must stay verbatim in the handoff; a rule question asks whether a user message states a standing rule for the project.";

export interface JevSelectorOptions {
  asker: JevAsker | null;
  ledger: Ledger;
  maxStateTokens?: number;
  maxRequestTokens?: number;
  maxQuestionsPerRequest?: number;
  windowFactor?: number;
}

interface Pending {
  name: string;
  key: string;
  id: string;
  question: NoulQuestion;
  tokens: number;
}

const COLLAPSED = /^\[… \d+ chars omitted …\]$/;

function keepQuestion(user: number, reply: number | null): NoulQuestion {
  return {
    type: 'noul',
    instructions: `History entries i=${user} (user)${reply === null ? '' : ` and i=${reply} (agent reply)`} form one exchange. Would a fresh session need this exchange, verbatim, to continue the current work correctly?`,
    criteria: {
      true: 'It holds a decision, constraint, identifier, open item or result that later work depends on and that later history does not restate.',
      false: 'It is superseded, restated later, or no longer relevant to the current work.',
    },
  };
}

async function askJev(
  o: JevSelectorOptions,
  input: SelectorInput,
  window: Turn[],
  protect: number,
  keepFor: Turn[],
  ruleFor: Turn[],
  keep: Map<string, number>,
  rule: Map<string, number>,
): Promise<{ status: string; requests: number; tokens: number }> {
  const { config, projectId, now } = input;
  const messages: Message[] = [];
  const index = new Map<string, { user: number; reply: number | null }>();
  for (const t of window) {
    const user = messages.push({ role: 'user', text: t.user, toolUses: [] }) - 1;
    const reply = t.reply === null ? null : messages.push({ role: 'assistant', text: t.reply, toolUses: [] }) - 1;
    index.set(t.key, { user, reply });
  }
  const fitted = fitState(messages, [], { maxStateTokens: o.maxStateTokens ?? 22_000, preserveRecentMessages: protect * 2, goal: input.pinnedText });
  const state = { ...fitted.state, context: DIALOGUE_CONTEXT };
  const stateTokens = estimateTokens(JSON.stringify(state));
  const visible = new Set(state.history.filter((h) => !COLLAPSED.test(h.text)).map((h) => h.i));

  const pending: Pending[] = [];
  const add = (prefix: string, id: string, turns: Turn[], build: (at: { user: number; reply: number | null }) => NoulQuestion) =>
    turns.forEach((t, n) => {
      const at = index.get(t.key);
      if (!at || !visible.has(at.user)) return;
      const question = build(at);
      pending.push({ name: `${prefix}${n}`, key: t.key, id, question, tokens: estimateTokens(JSON.stringify(question)) + 2 });
    });
  add('k', KEEP_QUESTION_ID, keepFor, (at) => keepQuestion(at.user, at.reply));
  add('r', RULE_QUESTION_ID, ruleFor, (at) => ruleQuestion(at.user));

  const guard = new SpendGuard(
    o.ledger,
    { maxRequests: config.jev.maxRequestsPerIngest, maxInputTokensPerDay: config.jev.maxInputTokensPerDay },
    now.toISOString().slice(0, 10),
  );
  const maxRequest = o.maxRequestTokens ?? 30_000;
  const maxQuestions = o.maxQuestionsPerRequest ?? 200;
  let status = 'ok';
  let offset = 0;
  while (offset < pending.length) {
    const batch: Pending[] = [];
    let tokens = stateTokens;
    while (offset + batch.length < pending.length && batch.length < maxQuestions) {
      const next = pending[offset + batch.length]!;
      if (batch.length && tokens + next.tokens > maxRequest) break;
      batch.push(next);
      tokens += next.tokens;
    }
    const verdict = guard.check(tokens);
    if (verdict !== 'ok') {
      status = `${guard.requests ? 'partial' : 'skipped'}:${verdict}`;
      break;
    }
    const questions: JevQuestions = Object.fromEntries(batch.map((q) => [q.name, q.question]));
    const response = await o.asker!.ask(state, questions);
    guard.record(response.usage?.input_tokens ?? tokens);
    for (const q of batch) {
      const p = noulAnswer(response.answers, q.name);
      (q.id === KEEP_QUESTION_ID ? keep : rule).set(q.key, p);
      o.ledger.putScore(projectId, q.key, config.jev.model, q.id, p, now.toISOString());
    }
    offset += batch.length;
  }
  return { status, requests: guard.requests, tokens: guard.inputTokens };
}

async function selectWithJev(o: JevSelectorOptions, input: SelectorInput): Promise<DialogueSelection> {
  const { config, turns, projectId } = input;
  const tz = config.render.timeZone;
  const cost = new Map(turns.map((t) => [t.key, turnTokens(formatTurn(t, tz).text)]));
  const total = turns.reduce((sum, t) => sum + cost.get(t.key)!, 0);
  if (!turns.length || (total <= config.render.briefDialogueTokens && !config.jev.rules)) {
    return {
      brief: selectRecent(turns, config.render.briefDialogueTokens, tz),
      full: selectRecent(turns, config.render.fullDialogueTokens, tz),
      rules: [],
      stats: { strategy: 'jev-select', jev: 'skipped:fits' },
    };
  }

  const limit = (o.windowFactor ?? 3) * config.render.fullDialogueTokens;
  let start = turns.length;
  let used = 0;
  while (start > 0 && used + cost.get(turns[start - 1]!.key)! <= limit) {
    start--;
    used += cost.get(turns[start]!.key)!;
  }
  const window = turns.slice(Math.min(start, turns.length - 1));
  const protect = Math.min(window.length, Math.max(0, config.select.protectRecentTurns));
  const protectedKeys = new Set(window.slice(window.length - protect).map((t) => t.key));
  const candidates = window.slice(0, window.length - protect);

  const model = config.jev.model;
  const keep = new Map<string, number>();
  const rule = new Map<string, number>();
  const keepFor: Turn[] = [];
  const ruleFor: Turn[] = [];
  for (const t of candidates) {
    const score = o.ledger.getScore(projectId, t.key, model, KEEP_QUESTION_ID);
    if (score === null) keepFor.push(t);
    else keep.set(t.key, score);
  }
  if (config.jev.rules) {
    for (const t of window) {
      const score = o.ledger.getScore(projectId, t.key, model, RULE_QUESTION_ID);
      if (score === null) ruleFor.push(t);
      else rule.set(t.key, score);
    }
  }

  let jev = 'cached';
  let requests = 0;
  let inputTokens = 0;
  if (keepFor.length || ruleFor.length) {
    if (!o.asker) jev = 'skipped:no-key';
    else {
      try {
        const asked = await askJev(o, input, window, protect, keepFor, ruleFor, keep, rule);
        jev = asked.status;
        requests = asked.requests;
        inputTokens = asked.tokens;
      } catch (error) {
        jev = `error:${error instanceof Error ? error.name : 'Unknown'}`;
      }
    }
  }

  const threshold = config.jev.dropThreshold;
  const drops = candidates.filter((t) => (keep.get(t.key) ?? 1) < threshold).sort((a, b) => keep.get(a.key)! - keep.get(b.key)!);
  const windowSize = window.reduce((sum, t) => sum + cost.get(t.key)!, 0);
  const pick = (budget: number): SelectedTurn[] => {
    const dropped = new Set<string>();
    let size = windowSize;
    for (const t of drops) {
      if (size <= budget) break;
      dropped.add(t.key);
      size -= cost.get(t.key)!;
    }
    return selectRecent(window.filter((t) => !dropped.has(t.key)), budget, tz).map((t) => ({
      ...t,
      reason: protectedKeys.has(t.key) ? ('protected' as const) : keep.has(t.key) ? ('jev-keep' as const) : ('unscored' as const),
    }));
  };

  return {
    brief: pick(config.render.briefDialogueTokens),
    full: pick(config.render.fullDialogueTokens),
    rules: config.jev.rules ? standingRules(window, rule) : [],
    stats: { strategy: 'jev-select', jev, requests, jevInputTokens: inputTokens, confidentDrops: drops.length },
  };
}

export function createJevSelector(options: JevSelectorOptions): Selector {
  return (input) => selectWithJev(options, input);
}
