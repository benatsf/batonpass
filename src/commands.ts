import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { JevClient } from 'fast-jev-compaction';
import type { CliIO } from './cli.ts';
import { staleSeconds, type Context } from './context.ts';
import { ingest } from './ingest.ts';
import { hookStatus, installPaths } from './install.ts';
import type { MessageRow } from './ledger.ts';
import { detectAgent, isAgent, MAX_MESSAGE_CHARS, otherAgent, renderMessages } from './messages.ts';
import { redact } from './redact.ts';
import { withStaleWarning } from './render.ts';
import { abridge, formatTime, toolLabel } from './select/dialogue.ts';
import { refresh } from './snapshot.ts';

export type Command = (ctx: Context, io: CliIO, args: string[]) => Promise<number>;
export type Check = [ok: boolean | null, text: string];

export const RESUME_PROMPT =
  'Continue the work on this project from the batonpass context above. First state the current state in at most three lines (last outcome, open items, standing rules), then wait for my next instruction.';

const nowOf = (ctx: Context) => (ctx.now ?? (() => new Date()))();

function ageText(now: Date, iso: string): string {
  const s = Math.max(0, (now.getTime() - Date.parse(iso)) / 1000);
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172_800) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86_400)} d`;
}

export const status: Command = async (ctx, io) => {
  const now = nowOf(ctx);
  const tz = ctx.config.render.timeZone;
  const projects = ctx.ledger.projects();
  if (!projects.length) io.out('No sessions ingested yet. Run `baton ingest`, or finish a turn in Codex or Claude Code with the hooks installed.\n');
  for (const p of projects) {
    const sessions = ctx.ledger.sessions(p.id);
    const counts = ['codex', 'claude'].map((tool) => `${toolLabel(tool)} ${sessions.filter((s) => s.tool === tool).length}`).join(', ');
    const snap = ctx.ledger.latestSnapshot(p.id);
    const age = snap ? `snapshot #${snap.seq}, ${ageText(now, snap.createdAt)} old` : 'no snapshot yet';
    io.out(`${p.id}\n  sessions: ${counts} · last activity ${formatTime(p.lastTs, tz)} · ${age}\n`);
  }
  const jev = ctx.config.select.strategy === 'jev-select' ? 'on' : 'off';
  io.out(`Jev: ${jev} · spent today ${ctx.ledger.jevSpend(now.toISOString().slice(0, 10))} input tokens\n`);
  return 0;
};

export const show: Command = async (ctx, io, args) => {
  const { values } = parseArgs({ args, options: { full: { type: 'boolean' }, project: { type: 'string' }, json: { type: 'boolean' } } });
  const id = values.project ?? ctx.resolve(io.cwd).id;
  const snap = ctx.ledger.latestSnapshot(id);
  if (!snap) {
    io.err(`No snapshot yet for ${id}. Finish a turn with the hooks installed, or run \`baton ingest\`.\n`);
    return 1;
  }
  if (values.json) {
    io.out(`${JSON.stringify(snap, null, 2)}\n`);
    return 0;
  }
  const text = values.full ? snap.full : snap.brief;
  const lag = staleSeconds(ctx, id, snap.createdAt);
  io.out(`${lag > ctx.config.render.staleAfterSeconds ? withStaleWarning(text, lag) : text}\n`);
  return 0;
};

export const ingestCommand: Command = async (ctx, io, args) => {
  const { values } = parseArgs({ args, options: { all: { type: 'boolean' }, project: { type: 'string' } } });
  const report = ingest(ctx);
  const here = ctx.resolve(io.cwd);
  const targets = new Map<string, string | null>();
  for (const id of report.projects) targets.set(id, null);
  if (values.all) for (const p of ctx.ledger.projects()) targets.set(p.id, null);
  if (values.project) targets.set(values.project, null);
  if (ctx.ledger.sessions(here.id).length || ctx.ledger.notes(here.id).length) targets.set(here.id, here.root);
  let refreshed = 0;
  const busy: string[] = [];
  for (const [projectId, root] of targets) {
    const result = await refresh(ctx, { projectId, root, ingest: false });
    if (result.status === 'committed') refreshed++;
    if (result.status === 'locked') busy.push(projectId);
  }
  const extras = [
    report.skippedLong ? `, ${report.skippedLong} over-long lines skipped` : '',
    report.parseErrors ? `, ${report.parseErrors} malformed lines skipped` : '',
  ].join('');
  io.out(`Read ${report.files} transcript file(s): ${report.events} new events${extras}.\nRefreshed ${refreshed} snapshot(s)${busy.length ? `; busy, skipped: ${busy.join(', ')}` : ''}.\n`);
  return 0;
};

export const search: Command = async (ctx, io, args) => {
  const { values, positionals } = parseArgs({ args, options: { project: { type: 'string' }, limit: { type: 'string' } }, allowPositionals: true });
  const query = positionals.join(' ').trim();
  if (!query) {
    io.err('Usage: baton search <words…> [--project id] [--limit n]\n');
    return 2;
  }
  const id = values.project ?? ctx.resolve(io.cwd).id;
  const limit = Math.max(1, Math.min(50, Number(values.limit ?? 10) || 10));
  const hits = ctx.ledger.search(id, query, limit);
  if (!hits.length) {
    io.out(`No matches for "${query}" in ${id}.\n`);
    return 0;
  }
  const tz = ctx.config.render.timeZone;
  for (const e of hits) {
    io.out(`[${toolLabel(e.tool)} · ${formatTime(e.ts, tz)} · ${e.kind} · session ${e.sessionId.slice(0, 8)}] ${abridge(e.text, 600).text}\n\n`);
  }
  return 0;
};

export const note: Command = async (ctx, io, args) => {
  const { values, positionals } = parseArgs({ args, options: { project: { type: 'string' } }, allowPositionals: true });
  const text = positionals.join(' ').trim();
  if (!text) {
    io.err('Usage: baton note <text…> [--project id]\n');
    return 2;
  }
  const here = ctx.resolve(io.cwd);
  const id = values.project ?? here.id;
  const clean = redact(text);
  ctx.ledger.addRedactions(clean.findings);
  ctx.ledger.addNote(id, clean.text, nowOf(ctx).toISOString());
  const result = await refresh(ctx, { projectId: id, root: values.project ? null : here.root, ingest: false });
  io.out(`Pinned to ${id}${result.status === 'committed' ? ` (snapshot #${result.seq})` : ''}.\n`);
  return 0;
};

const SEND_USAGE = 'Usage: baton send --to <codex|claude> [--from codex|claude|user] [--project id] <text…>\n';
const SEND_OPTIONS = new Set(['to', 'from', 'project']);

/**
 * Only --to, --from and --project are options, anywhere; every other word is message text, so a
 * message may start with "-" (bullet lists, "-1 failing"). After `--`, everything is text.
 */
function parseSendArgs(args: string[]): { options: Record<string, string>; text: string } | null {
  const options: Record<string, string> = {};
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') {
      words.push(...args.slice(i + 1));
      break;
    }
    const option = /^--([a-z]+)(?:=([\s\S]*))?$/.exec(arg);
    if (!option || !SEND_OPTIONS.has(option[1]!)) {
      words.push(arg);
      continue;
    }
    const value = option[2] ?? args[++i];
    if (value === undefined) return null;
    options[option[1]!] = value;
  }
  return { options, text: words.join(' ').trim() };
}

export const send: Command = async (ctx, io, args) => {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    io.out(SEND_USAGE);
    return 0;
  }
  const parsed = parseSendArgs(args);
  if (!parsed) {
    io.err(SEND_USAGE);
    return 2;
  }
  const { options, text } = parsed;
  const detected = detectAgent(io.env);
  if (!options.from && detected === 'both') {
    io.err('Both Codex and Claude Code variables are set here (one agent was started from the other), so the sender is unknown: pass --from codex or --from claude.\n');
    return 2;
  }
  const sender = options.from ?? (isAgent(detected) ? detected : 'user');
  if (!isAgent(sender) && sender !== 'user') {
    io.err(`--from must be codex, claude or user.\n${SEND_USAGE}`);
    return 2;
  }
  // From inside an agent, the recipient defaults to the other one.
  const recipient = options.to ?? (isAgent(sender) ? otherAgent(sender) : undefined);
  if (!isAgent(recipient) || !text) {
    io.err(SEND_USAGE);
    return 2;
  }
  if (recipient === sender) {
    io.err(`A message from ${toolLabel(sender)} to ${toolLabel(recipient)} would come back to the sender at its next tool call. Pass --from user if you are not the agent.\n`);
    return 2;
  }
  if (text.length > MAX_MESSAGE_CHARS) {
    io.err(`The message is ${text.length} characters; the limit is ${MAX_MESSAGE_CHARS}. Keep it short, or point to a file.\n`);
    return 2;
  }
  const id = options.project ?? ctx.resolve(io.cwd).id;
  const clean = redact(text);
  ctx.ledger.addRedactions(clean.findings);
  const messageId = ctx.ledger.addMessage(id, { recipient, sender, text: clean.text, createdAt: nowOf(ctx).toISOString() });
  const to = toolLabel(recipient);
  io.out(`Message #${messageId} queued for ${to} in ${id}. ${to} sees it at its next prompt, tool call or turn end.\n`);
  const redacted = Object.values(clean.findings).reduce((sum, n) => sum + n, 0);
  if (redacted) io.out(`Redacted ${redacted} secret-looking value${redacted === 1 ? '' : 's'} before storing.\n`);
  return 0;
};

const party = (name: string) => (isAgent(name) ? toolLabel(name) : 'the user');

function messageState(m: MessageRow, ackedNow: boolean, cutoff: string, tz: string): string {
  if (ackedNow) return 'read now';
  if (m.deliveredAt) return `delivered ${formatTime(m.deliveredAt, tz)} (${m.deliveredVia})`;
  return m.createdAt < cutoff ? 'pending, too old for hooks to deliver' : 'pending';
}

export const inbox: Command = async (ctx, io, args) => {
  const { values } = parseArgs({
    args,
    options: { tool: { type: 'string' }, ack: { type: 'boolean' }, all: { type: 'boolean' }, project: { type: 'string' }, json: { type: 'boolean' } },
  });
  if (values.tool !== undefined && !isAgent(values.tool)) {
    io.err('--tool must be codex or claude.\n');
    return 2;
  }
  const detected = detectAgent(io.env);
  const tool = values.tool ?? (isAgent(detected) ? detected : undefined);
  if (values.ack && !tool) {
    io.err('--ack needs --tool codex or --tool claude, so it never marks the other agent\'s messages as read.\n');
    return 2;
  }
  const id = values.project ?? ctx.resolve(io.cwd).id;
  const now = nowOf(ctx);
  const acked = values.ack && tool ? ctx.ledger.claimMessages(id, tool, 'inbox', now.toISOString()) : [];
  const ackedIds = new Set(acked.map((m) => m.id));
  const list = values.all
    ? ctx.ledger.messages(id, { recipient: tool, limit: 50 })
    : values.ack ? acked : ctx.ledger.messages(id, { recipient: tool, pendingOnly: true });
  if (values.json) {
    io.out(`${JSON.stringify(list, null, 2)}\n`);
    return 0;
  }
  const where = `${tool ? ` for ${toolLabel(tool)}` : ''} in ${id}`;
  if (!list.length) {
    io.out(`No ${values.all ? '' : 'pending '}messages${where}.\n`);
    return 0;
  }
  const tz = ctx.config.render.timeZone;
  if (detected) {
    // Inside an agent's shell this output reaches a model: frame the messages as data, as the hooks do.
    io.out(`${renderMessages(list, tool ?? null, tz)}\n`);
  } else {
    const cutoff = new Date(now.getTime() - ctx.config.messages.maxAgeHours * 3_600_000).toISOString();
    const pending = list.filter((m) => !m.deliveredAt || ackedIds.has(m.id)).length;
    io.out(`Messages${where} (${pending} pending):\n`);
    for (const m of list) {
      io.out(`\n#${m.id} · ${formatTime(m.createdAt, tz)} · from ${party(m.sender)} to ${party(m.recipient)} · ${messageState(m, ackedIds.has(m.id), cutoff, tz)}\n${m.text}\n`);
    }
  }
  if (acked.length) io.out(`\nMarked ${acked.length} message${acked.length === 1 ? '' : 's'} as read; hooks will not show ${acked.length === 1 ? 'it' : 'them'} again.\n`);
  return 0;
};

export const resume: Command = async (ctx, io, args) => {
  const target = args[0];
  if (target !== 'codex' && target !== 'claude') {
    io.err('Usage: baton resume <codex|claude>\n');
    return 2;
  }
  if (io.env.BATON_HOOK === '1') {
    io.err('baton resume is disabled inside an agent started by baton (BATON_HOOK=1).\n');
    return 1;
  }
  const here = ctx.resolve(io.cwd);
  await refresh(ctx, { projectId: here.id, root: here.root });
  const snap = ctx.ledger.latestSnapshot(here.id);
  if (!snap) {
    io.err(`Nothing to resume for ${here.id} yet.\n`);
    return 1;
  }
  io.out(`${snap.brief}\n`);
  return io.spawn(target, [`${snap.brief}\n\n${RESUME_PROMPT}`], { cwd: here.root ?? io.cwd, env: { ...io.env, BATON_SKIP_INJECT: '1' } });
};

function logProblems(home: string): Check {
  let errors = 0;
  let malformed = 0;
  let long = 0;
  try {
    const lines = readFileSync(join(home, 'logs', 'baton.log'), 'utf8').trim().split('\n').slice(-500);
    for (const line of lines) {
      const [, event, json] = /^\S+ (\S+) (.*)$/.exec(line) ?? [];
      if (event === 'hook-error') errors++;
      if (json && (event === 'stop' || event === 'pre-compact')) {
        const detail = JSON.parse(json) as { parseErrors?: number; skippedLong?: number };
        malformed += detail.parseErrors ?? 0;
        long += detail.skippedLong ?? 0;
      }
    }
  } catch {
    return [null, 'No hook activity logged yet'];
  }
  return [errors === 0 ? true : null, `Recent hook runs: ${errors} errors, ${malformed} malformed lines, ${long} over-long lines skipped`];
}

export function doctorChecks(ctx: Context): Check[] {
  const checks: Check[] = [];
  const major = Number(process.versions.node.split('.')[0]);
  checks.push([major >= 24, `Node ${process.versions.node} (needs 24 or later)`]);
  const mode = statSync(ctx.config.home).mode & 0o777;
  checks.push([mode === 0o700, `Data directory ${ctx.config.home} (mode ${mode.toString(8)})`]);
  const check = String((ctx.ledger.db.prepare('PRAGMA quick_check').get() as { quick_check: unknown }).quick_check);
  checks.push([check === 'ok', `Ledger integrity: ${check}`]);
  for (const reader of ctx.readers) {
    const count = reader.discover().length;
    checks.push([count > 0 ? true : null, `${toolLabel(reader.tool)} transcripts found: ${count}`]);
  }
  const redactions = Object.entries(ctx.ledger.redactionCounts()).map(([rule, n]) => `${rule} ${n}`).join(', ');
  checks.push([null, `Secrets redacted so far: ${redactions || 'none'}`]);
  checks.push(logProblems(ctx.config.home));
  checks.push(...hookStatus(installPaths(ctx.env, ctx.config.home)));
  if (ctx.config.select.strategy === 'jev-select') {
    const hasKey = Boolean(ctx.env[ctx.config.jev.apiKeyEnv]);
    checks.push([hasKey, `Jev: on, key in ${ctx.config.jev.apiKeyEnv} ${hasKey ? 'present' : 'missing'}`]);
  } else {
    checks.push([null, 'Jev: off (select.strategy = recent-dialogue, no network calls)']);
  }
  return checks;
}

export const doctor: Command = async (ctx, io, args) => {
  const { values } = parseArgs({ args, options: { jev: { type: 'boolean' } } });
  const checks = doctorChecks(ctx);
  if (values.jev) {
    const apiKey = ctx.env[ctx.config.jev.apiKeyEnv];
    if (!apiKey) checks.push([false, `Jev live check: no key in ${ctx.config.jev.apiKeyEnv}`]);
    else {
      try {
        await new JevClient({ apiKey, model: ctx.config.jev.model }).ask('batonpass connectivity check', {
          ping: { type: 'noul', instructions: 'Is this state a connectivity check?' },
        });
        checks.push([true, `Jev reachable (model ${ctx.config.jev.model})`]);
      } catch (error) {
        checks.push([false, `Jev live check failed: ${error instanceof Error ? error.message : String(error)}`]);
      }
    }
  }
  for (const [ok, text] of checks) io.out(`${ok === true ? '✓' : ok === false ? '✗' : '–'} ${text}\n`);
  return checks.some(([ok]) => ok === false) ? 1 : 0;
};
