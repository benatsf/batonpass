import type { StoredEvent } from '../types.ts';

export interface Turn {
  key: string;
  tool: string;
  sessionId: string;
  ts: string;
  user: string;
  reply: string | null;
  replyTs: string | null;
}

export type SelectionReason = 'recent' | 'protected' | 'jev-keep' | 'unscored';

export interface SelectedTurn extends Turn {
  rendered: string;
  abridged: boolean;
  reason: SelectionReason;
}

export function buildTurns(events: StoredEvent[]): Turn[] {
  const bySession = new Map<string, StoredEvent[]>();
  for (const event of events) {
    const key = `${event.tool}:${event.sessionId}`;
    const list = bySession.get(key) ?? [];
    list.push(event);
    bySession.set(key, list);
  }
  const turns: Turn[] = [];
  for (const list of bySession.values()) {
    list.sort((a, b) => a.ts.localeCompare(b.ts) || a.id - b.id);
    let current: Turn | null = null;
    let hasFinal = false;
    for (const event of list) {
      if (event.kind === 'user') {
        if (current) turns.push(current);
        current = { key: `${event.tool}:${event.sessionId}:${event.id}`, tool: event.tool, sessionId: event.sessionId, ts: event.ts, user: event.text, reply: null, replyTs: null };
        hasFinal = false;
      } else if (current && event.kind === 'final') {
        current.reply = event.text;
        current.replyTs = event.ts;
        hasFinal = true;
      } else if (current && event.kind === 'assistant' && !hasFinal) {
        current.reply = event.text;
        current.replyTs = event.ts;
      }
    }
    if (current) turns.push(current);
  }
  return turns.sort((a, b) => a.ts.localeCompare(b.ts));
}

export function formatTime(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

export function toolLabel(tool: string): string {
  return tool === 'codex' ? 'Codex' : tool === 'claude' ? 'Claude Code' : tool;
}

export function abridge(text: string, max: number): { text: string; abridged: boolean } {
  if (text.length <= max) return { text, abridged: false };
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return { text: `${text.slice(0, head)}\n[… ${text.length - max} chars omitted …]\n${text.slice(-tail)}`, abridged: true };
}

export function formatTurn(turn: Turn, timeZone: string, maxChars?: number): { text: string; abridged: boolean } {
  const label = toolLabel(turn.tool);
  const user = maxChars ? abridge(turn.user, maxChars) : { text: turn.user, abridged: false };
  const reply = turn.reply === null ? null : maxChars ? abridge(turn.reply, maxChars) : { text: turn.reply, abridged: false };
  const head = `[${label} · ${formatTime(turn.ts, timeZone)}] User:\n${user.text}`;
  const tail = reply
    ? `\n[${label} · ${formatTime(turn.replyTs ?? turn.ts, timeZone)}] Agent:\n${reply.text}`
    : '\n(no reply recorded yet)';
  return { text: head + tail, abridged: user.abridged || Boolean(reply?.abridged) };
}
