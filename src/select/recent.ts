import { estimateTokens } from 'fast-jev-compaction';
import { formatTurn, type SelectedTurn, type SelectionReason, type Turn } from './dialogue.ts';

export const ABRIDGE_CHARS = 1500;

/** Tokens a rendered turn costs in a snapshot, including the blank line that separates turns. */
export function turnTokens(text: string): number {
  return estimateTokens(text) + 1;
}

export function selectRecent(turns: Turn[], budgetTokens: number, timeZone: string, reason: SelectionReason = 'recent'): SelectedTurn[] {
  const picked: SelectedTurn[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]!;
    const candidates = [formatTurn(turn, timeZone), formatTurn(turn, timeZone, ABRIDGE_CHARS)];
    const fit = candidates.find((c) => used + turnTokens(c.text) <= budgetTokens);
    if (fit) {
      picked.push({ ...turn, rendered: fit.text, abridged: fit.abridged, reason });
      used += turnTokens(fit.text);
      continue;
    }
    if (picked.length === 0) {
      // The newest turn is always kept; shrink each side until it fits the budget.
      let perSide = ABRIDGE_CHARS;
      let hard = formatTurn(turn, timeZone, perSide);
      while (turnTokens(hard.text) > budgetTokens && perSide > 100) {
        perSide = Math.floor(perSide / 2);
        hard = formatTurn(turn, timeZone, perSide);
      }
      picked.push({ ...turn, rendered: hard.text, abridged: true, reason });
    }
    break;
  }
  return picked.reverse();
}
