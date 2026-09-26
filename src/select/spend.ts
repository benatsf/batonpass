import type { Ledger } from '../ledger.ts';

export type SpendVerdict = 'ok' | 'request-cap' | 'daily-cap';

export class SpendGuard {
  requests = 0;
  inputTokens = 0;
  readonly ledger: Ledger;
  readonly limits: { maxRequests: number; maxInputTokensPerDay: number };
  readonly day: string;

  constructor(ledger: Ledger, limits: { maxRequests: number; maxInputTokensPerDay: number }, day: string) {
    this.ledger = ledger;
    this.limits = limits;
    this.day = day;
  }

  check(estimatedTokens: number): SpendVerdict {
    if (this.requests >= this.limits.maxRequests) return 'request-cap';
    if (this.ledger.jevSpend(this.day) + estimatedTokens > this.limits.maxInputTokensPerDay) return 'daily-cap';
    return 'ok';
  }

  record(tokens: number): void {
    this.requests++;
    this.inputTokens += tokens;
    this.ledger.addJevSpend(this.day, tokens);
  }
}
