import type { NoulQuestion } from 'fast-jev-compaction';
import { abridge, type Turn } from './dialogue.ts';

export const RULE_QUESTION_ID = 'rule_v1';
export const RULE_THRESHOLD = 0.6;

export function ruleQuestion(userIndex: number): NoulQuestion {
  return {
    type: 'noul',
    instructions: `History entry i=${userIndex} (user) is a user message. Is this message, or part of it, a standing instruction the user expects to hold in future sessions of this project (a rule about what must never be done, a language preference, an approval requirement), as opposed to a one-off request?`,
    criteria: {
      true: 'It states a lasting rule or preference for this project.',
      false: 'It is a one-off request, a question, or feedback on a single result.',
    },
  };
}

export function standingRules(turns: Turn[], scores: Map<string, number>): Array<{ ts: string; text: string }> {
  return turns.filter((t) => (scores.get(t.key) ?? 0) > RULE_THRESHOLD).map((t) => ({ ts: t.ts, text: abridge(t.user, 300).text }));
}
