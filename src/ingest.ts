import type { BatonConfig } from './config.ts';
import type { Ledger } from './ledger.ts';
import { readNewLines } from './readers/lines.ts';
import { redactValue } from './redact.ts';
import type { BatonEvent, Cursor, ParseState, ProjectRef, SourceFile, SourceReader } from './types.ts';

export interface IngestDeps {
  ledger: Ledger;
  readers: SourceReader[];
  config: BatonConfig;
  resolve: (cwd: string) => ProjectRef;
  now?: () => Date;
}

export interface IngestReport {
  files: number;
  events: number;
  skippedLong: number;
  parseErrors: number;
  missingCwd: number;
  projects: Set<string>;
}

const MAX_READ_BYTES = 256 * 1024 * 1024;

function unchanged(prev: { cursor: Cursor } | null, file: SourceFile): boolean {
  if (!prev) return false;
  const c = prev.cursor;
  return !c.skipping && c.size === file.size && c.inode === file.inode && c.mtimeMs === file.mtimeMs;
}

export function ingest(deps: IngestDeps, options: { onlyPaths?: string[] } = {}): IngestReport {
  const now = (deps.now ?? (() => new Date()))();
  const cutoff = now.getTime() - deps.config.backfill.days * 86_400_000;
  const only = options.onlyPaths ? new Set(options.onlyPaths) : null;
  const report: IngestReport = { files: 0, events: 0, skippedLong: 0, parseErrors: 0, missingCwd: 0, projects: new Set() };

  for (const reader of deps.readers) {
    let titles: Map<string, string> | null = null;
    for (const file of reader.discover()) {
      if (only && !only.has(file.path)) continue;
      const prev = deps.ledger.getSource(file.path);
      if (!prev && file.mtimeMs < cutoff) continue;
      if (unchanged(prev, file)) continue;
      titles ??= reader.sessionTitles?.() ?? new Map();
      const sessionTitles = titles;
      // Re-read the cursor inside the write transaction: a concurrent hook may have advanced it.
      const read = deps.ledger.transaction(() => {
        const current = deps.ledger.getSource(file.path);
        if (unchanged(current, file)) return false;
        ingestFile(deps, reader, file, current, sessionTitles, report);
        return true;
      });
      if (read) report.files++;
    }
  }
  return report;
}

function ingestFile(
  deps: IngestDeps,
  reader: SourceReader,
  file: SourceFile,
  prev: { cursor: Cursor; state: ParseState } | null,
  sessionTitles: Map<string, string>,
  report: IngestReport,
): void {
  const { ledger, config } = deps;
  const result = readNewLines(file.path, prev?.cursor ?? null, {
    backfillBytes: config.backfill.maxBytes,
    maxLineBytes: config.reader.maxLineBytes,
    maxReadBytes: MAX_READ_BYTES,
  });
  const state: ParseState = prev && !result.reset ? prev.state : reader.initialState(file);
  report.skippedLong += result.skippedLong;
  const findings: Record<string, number> = {};
  // Titles and usage can precede a session's first stored event, so they are applied after the loop.
  const titles = new Map<string, string>();
  const usage = new Map<string, { meta: Record<string, unknown>; model: string | null }>();
  const tool = reader.tool;

  for (const line of result.lines) {
    let events: BatonEvent[];
    try {
      events = reader.parse(line, state);
    } catch {
      report.parseErrors++;
      continue;
    }
    for (const event of events) {
      if (event.kind === 'usage') {
        usage.set(event.sessionId, { meta: event.meta, model: typeof event.meta.model === 'string' ? event.meta.model : null });
        continue;
      }
      if (event.kind === 'title') {
        titles.set(event.sessionId, event.text);
        continue;
      }
      if (!event.cwd) {
        report.missingCwd++;
        continue;
      }
      const project = deps.resolve(event.cwd);
      const clean: BatonEvent = { ...event, text: redactValue(event.text, findings), meta: redactValue(event.meta, findings) };
      if (ledger.insertEvent(project.id, clean)) {
        ledger.upsertSession(project.id, clean, file.path);
        report.events++;
        report.projects.add(project.id);
      }
    }
  }

  const indexTitle = sessionTitles.get(state.sessionId);
  if (indexTitle && !titles.has(state.sessionId)) titles.set(state.sessionId, indexTitle);
  for (const [sessionId, title] of titles) ledger.setSessionTitle(tool, sessionId, redactValue(title, findings));
  for (const [sessionId, u] of usage) ledger.setSessionUsage(tool, sessionId, redactValue(u.meta, findings), u.model);
  ledger.addRedactions(findings);
  ledger.putSource(reader.tool, result.cursor, state);
}
