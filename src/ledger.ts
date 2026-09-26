import { createHash } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { BatonEvent, Cursor, EventKind, ParseState, StoredEvent } from './types.ts';

export interface SessionRow {
  tool: string;
  sessionId: string;
  projectId: string;
  title: string | null;
  firstTs: string;
  lastTs: string;
  cwd: string | null;
  model: string | null;
  sourcePath: string | null;
  usage: Record<string, unknown> | null;
  turns: number;
  compactions: number;
}

export interface CoverEntry {
  tool: string;
  sessionId: string;
  title: string | null;
  lastTs: string;
  sourcePath: string | null;
  offset: number | null;
}

export interface Snapshot {
  projectId: string;
  seq: number;
  createdAt: string;
  covers: CoverEntry[];
  brief: string;
  full: string;
  stats: Record<string, unknown>;
}

export interface ProjectSummary {
  id: string;
  sessions: number;
  lastTs: string;
}

export type SnapshotBody = Omit<Snapshot, 'projectId' | 'seq'>;

const SCHEMA_VERSION = 1;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS sources (
  path TEXT PRIMARY KEY, tool TEXT NOT NULL, inode INTEGER NOT NULL, offset INTEGER NOT NULL,
  size INTEGER NOT NULL, mtime_ms REAL NOT NULL, skipping INTEGER NOT NULL DEFAULT 0,
  state_json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  tool TEXT NOT NULL, session_id TEXT NOT NULL, project_id TEXT NOT NULL, title TEXT,
  first_ts TEXT NOT NULL, last_ts TEXT NOT NULL, cwd TEXT, model TEXT, source_path TEXT,
  usage_json TEXT, turns INTEGER NOT NULL DEFAULT 0, compactions INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tool, session_id));
CREATE INDEX IF NOT EXISTS sessions_project ON sessions(project_id, last_ts);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY, project_id TEXT NOT NULL, tool TEXT NOT NULL, session_id TEXT NOT NULL,
  ts TEXT NOT NULL, cwd TEXT, kind TEXT NOT NULL, text TEXT NOT NULL, meta_json TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE);
CREATE INDEX IF NOT EXISTS events_project_ts ON events(project_id, ts);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(text, content='events', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
  INSERT INTO events_fts(rowid, text) VALUES (new.id, new.text); END;
CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, text) VALUES ('delete', old.id, old.text); END;
CREATE TABLE IF NOT EXISTS scores (
  project_id TEXT NOT NULL, item_key TEXT NOT NULL, model TEXT NOT NULL, question TEXT NOT NULL,
  score REAL NOT NULL, decided_at TEXT NOT NULL, PRIMARY KEY (project_id, item_key, model, question));
CREATE TABLE IF NOT EXISTS snapshots (
  project_id TEXT NOT NULL, seq INTEGER NOT NULL, created_at TEXT NOT NULL, covers_json TEXT NOT NULL,
  brief_md TEXT NOT NULL, full_md TEXT NOT NULL, stats_json TEXT NOT NULL, PRIMARY KEY (project_id, seq));
CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, project_id TEXT NOT NULL, ts TEXT NOT NULL, text TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS jev_spend (day TEXT PRIMARY KEY, input_tokens INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS redactions (rule TEXT PRIMARY KEY, count INTEGER NOT NULL);
`;

type Row = Record<string, unknown>;
const json = <T>(value: unknown, fallback: T): T => (typeof value === 'string' ? (JSON.parse(value) as T) : fallback);

function toEvent(r: Row): StoredEvent {
  return {
    id: Number(r.id),
    projectId: String(r.project_id),
    tool: String(r.tool),
    sessionId: String(r.session_id),
    ts: String(r.ts),
    cwd: (r.cwd as string | null) ?? null,
    kind: String(r.kind) as EventKind,
    text: String(r.text),
    meta: json(r.meta_json, {}),
  };
}

function ftsQuery(query: string, mode: 'and' | 'or'): string | null {
  const words = (query.match(/[\p{L}\p{N}_#.-]+/gu) ?? []).filter((w) => /[\p{L}\p{N}]/u.test(w));
  if (!words.length) return null;
  return words.map((w) => `"${w.replace(/"/g, '""')}"`).join(mode === 'and' ? ' ' : ' OR ');
}

export class Ledger {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    const version = Number((this.db.prepare('PRAGMA user_version').get() as Row).user_version);
    if (version < SCHEMA_VERSION) {
      this.transaction(() => {
        this.db.exec(SCHEMA);
        this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      });
    }
    if (path !== ':memory:') {
      try {
        chmodSync(path, 0o600);
      } catch {
        // Best effort on filesystems without POSIX modes.
      }
    }
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getSource(path: string): { tool: string; cursor: Cursor; state: ParseState } | null {
    const r = this.db.prepare('SELECT * FROM sources WHERE path = ?').get(path) as Row | undefined;
    if (!r) return null;
    return {
      tool: String(r.tool),
      cursor: { path, inode: Number(r.inode), offset: Number(r.offset), size: Number(r.size), mtimeMs: Number(r.mtime_ms), skipping: Number(r.skipping) === 1 },
      state: json<ParseState>(r.state_json, { sessionId: '', cwd: null }),
    };
  }

  putSource(tool: string, cursor: Cursor, state: ParseState): void {
    this.db
      .prepare(`INSERT INTO sources (path, tool, inode, offset, size, mtime_ms, skipping, state_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET tool=excluded.tool, inode=excluded.inode, offset=excluded.offset, size=excluded.size,
          mtime_ms=excluded.mtime_ms, skipping=excluded.skipping, state_json=excluded.state_json, updated_at=excluded.updated_at`)
      .run(cursor.path, tool, cursor.inode, cursor.offset, cursor.size, cursor.mtimeMs, cursor.skipping ? 1 : 0, JSON.stringify(state), new Date().toISOString());
  }

  insertEvent(projectId: string, e: BatonEvent): boolean {
    const key = createHash('sha256').update(`${e.tool}\u0000${e.sessionId}\u0000${e.ts}\u0000${e.kind}\u0000${e.text}`).digest('hex').slice(0, 32);
    const result = this.db
      .prepare(`INSERT OR IGNORE INTO events (project_id, tool, session_id, ts, cwd, kind, text, meta_json, dedupe_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(projectId, e.tool, e.sessionId, e.ts, e.cwd, e.kind, e.text, JSON.stringify(e.meta), key);
    return Number(result.changes) > 0;
  }

  upsertSession(projectId: string, e: BatonEvent, sourcePath: string | null): void {
    this.db
      .prepare(`INSERT INTO sessions (tool, session_id, project_id, first_ts, last_ts, cwd, source_path, turns, compactions)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tool, session_id) DO UPDATE SET
          project_id = excluded.project_id,
          first_ts = min(first_ts, excluded.first_ts),
          last_ts = max(last_ts, excluded.last_ts),
          cwd = coalesce(excluded.cwd, cwd),
          source_path = coalesce(excluded.source_path, source_path),
          turns = turns + excluded.turns,
          compactions = compactions + excluded.compactions`)
      .run(e.tool, e.sessionId, projectId, e.ts, e.ts, e.cwd, sourcePath, e.kind === 'user' ? 1 : 0, e.kind === 'compaction' ? 1 : 0);
  }

  setSessionTitle(tool: string, sessionId: string, title: string): void {
    this.db.prepare('UPDATE sessions SET title = ? WHERE tool = ? AND session_id = ?').run(title, tool, sessionId);
  }

  setSessionUsage(tool: string, sessionId: string, usage: Record<string, unknown>, model: string | null): void {
    this.db
      .prepare('UPDATE sessions SET usage_json = ?, model = coalesce(?, model) WHERE tool = ? AND session_id = ?')
      .run(JSON.stringify(usage), model, tool, sessionId);
  }

  events(projectId: string, kinds?: EventKind[]): StoredEvent[] {
    const rows = this.db.prepare('SELECT * FROM events WHERE project_id = ? ORDER BY ts, id').all(projectId) as Row[];
    const events = rows.map(toEvent);
    return kinds ? events.filter((e) => kinds.includes(e.kind)) : events;
  }

  sessions(projectId: string): SessionRow[] {
    const rows = this.db.prepare('SELECT * FROM sessions WHERE project_id = ? ORDER BY last_ts DESC').all(projectId) as Row[];
    return rows.map((r) => ({
      tool: String(r.tool),
      sessionId: String(r.session_id),
      projectId: String(r.project_id),
      title: (r.title as string | null) ?? null,
      firstTs: String(r.first_ts),
      lastTs: String(r.last_ts),
      cwd: (r.cwd as string | null) ?? null,
      model: (r.model as string | null) ?? null,
      sourcePath: (r.source_path as string | null) ?? null,
      usage: json(r.usage_json, null),
      turns: Number(r.turns),
      compactions: Number(r.compactions),
    }));
  }

  projects(): ProjectSummary[] {
    const rows = this.db
      .prepare('SELECT project_id AS id, count(*) AS sessions, max(last_ts) AS last_ts FROM sessions GROUP BY project_id ORDER BY last_ts DESC')
      .all() as Row[];
    return rows.map((r) => ({ id: String(r.id), sessions: Number(r.sessions), lastTs: String(r.last_ts) }));
  }

  search(projectId: string, query: string, limit = 10): StoredEvent[] {
    for (const mode of ['and', 'or'] as const) {
      const match = ftsQuery(query, mode);
      if (!match) return [];
      const rows = this.db
        .prepare(`SELECT e.* FROM events_fts f JOIN events e ON e.id = f.rowid
          WHERE events_fts MATCH ? AND e.project_id = ? AND e.kind IN ('user','assistant','final','goal','compaction','pr','tool_call')
          ORDER BY rank LIMIT ?`)
        .all(match, projectId, limit) as Row[];
      if (rows.length) return rows.map(toEvent);
    }
    return [];
  }

  getScore(projectId: string, itemKey: string, model: string, question: string): number | null {
    const r = this.db
      .prepare('SELECT score FROM scores WHERE project_id = ? AND item_key = ? AND model = ? AND question = ?')
      .get(projectId, itemKey, model, question) as Row | undefined;
    return r ? Number(r.score) : null;
  }

  putScore(projectId: string, itemKey: string, model: string, question: string, score: number, decidedAt: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO scores (project_id, item_key, model, question, score, decided_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(projectId, itemKey, model, question, score, decidedAt);
  }

  addNote(projectId: string, text: string, ts: string): void {
    this.db.prepare('INSERT INTO notes (project_id, ts, text) VALUES (?, ?, ?)').run(projectId, ts, text);
  }

  notes(projectId: string): Array<{ ts: string; text: string }> {
    return (this.db.prepare('SELECT ts, text FROM notes WHERE project_id = ? ORDER BY id').all(projectId) as Row[]).map((r) => ({
      ts: String(r.ts),
      text: String(r.text),
    }));
  }

  commitSnapshot(projectId: string, build: (seq: number) => SnapshotBody): number {
    return this.transaction(() => {
      const r = this.db.prepare('SELECT coalesce(max(seq), 0) + 1 AS seq FROM snapshots WHERE project_id = ?').get(projectId) as Row;
      const seq = Number(r.seq);
      const s = build(seq);
      this.db
        .prepare('INSERT INTO snapshots (project_id, seq, created_at, covers_json, brief_md, full_md, stats_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(projectId, seq, s.createdAt, JSON.stringify(s.covers), s.brief, s.full, JSON.stringify(s.stats));
      return seq;
    });
  }

  latestSnapshot(projectId: string): Snapshot | null {
    const r = this.db.prepare('SELECT * FROM snapshots WHERE project_id = ? ORDER BY seq DESC LIMIT 1').get(projectId) as Row | undefined;
    if (!r) return null;
    return {
      projectId,
      seq: Number(r.seq),
      createdAt: String(r.created_at),
      covers: json(r.covers_json, []),
      brief: String(r.brief_md),
      full: String(r.full_md),
      stats: json(r.stats_json, {}),
    };
  }

  jevSpend(day: string): number {
    const r = this.db.prepare('SELECT input_tokens FROM jev_spend WHERE day = ?').get(day) as Row | undefined;
    return r ? Number(r.input_tokens) : 0;
  }

  addJevSpend(day: string, tokens: number): void {
    this.db
      .prepare('INSERT INTO jev_spend (day, input_tokens) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET input_tokens = input_tokens + excluded.input_tokens')
      .run(day, Math.round(tokens));
  }

  addRedactions(findings: Record<string, number>): void {
    const stmt = this.db.prepare('INSERT INTO redactions (rule, count) VALUES (?, ?) ON CONFLICT(rule) DO UPDATE SET count = count + excluded.count');
    for (const [rule, count] of Object.entries(findings)) stmt.run(rule, count);
  }

  redactionCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.db.prepare('SELECT rule, count FROM redactions ORDER BY rule').all() as Row[]) out[String(r.rule)] = Number(r.count);
    return out;
  }

  sourcePathsForProject(projectId: string): string[] {
    return (this.db.prepare('SELECT DISTINCT source_path FROM sessions WHERE project_id = ? AND source_path IS NOT NULL').all(projectId) as Row[]).map((r) =>
      String(r.source_path),
    );
  }

  prune(now: Date, retentionDays: number, keepSnapshots: number): void {
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
    this.transaction(() => {
      this.db.prepare('DELETE FROM events WHERE ts < ?').run(cutoff);
      this.db.prepare('DELETE FROM sessions WHERE last_ts < ?').run(cutoff);
      this.db
        .prepare(`DELETE FROM snapshots WHERE (project_id, seq) IN (
          SELECT project_id, seq FROM (SELECT project_id, seq, row_number() OVER (PARTITION BY project_id ORDER BY seq DESC) AS n FROM snapshots) WHERE n > ?)`)
        .run(keepSnapshots);
    });
  }
}
