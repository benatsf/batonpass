export interface Cursor {
  path: string;
  inode: number;
  offset: number;
  size: number;
  mtimeMs: number;
  /** True when the previous read stopped inside an over-long line that must still be skipped. */
  skipping?: boolean;
}

export type EventKind =
  | 'user'
  | 'assistant'
  | 'final'
  | 'tool_call'
  | 'goal'
  | 'compaction'
  | 'title'
  | 'pr'
  | 'usage'
  | 'cwd_change';

export interface BatonEvent {
  tool: string;
  sessionId: string;
  ts: string;
  cwd: string | null;
  kind: EventKind;
  text: string;
  meta: Record<string, unknown>;
}

export interface StoredEvent extends BatonEvent {
  id: number;
  projectId: string;
}

export interface SourceFile {
  path: string;
  tool: string;
  size: number;
  mtimeMs: number;
  inode: number;
}

export type ParseState = {
  sessionId: string;
  cwd: string | null;
  /** Codex sub-agent sessions are skipped entirely. */
  skip?: boolean;
  lastTs?: string;
  model?: string;
};

export interface SourceReader {
  tool: string;
  discover(): SourceFile[];
  initialState(file: SourceFile): ParseState;
  parse(line: string, state: ParseState): BatonEvent[];
  sessionTitles?(): Map<string, string>;
}

export interface ProjectRef {
  id: string;
  root: string | null;
  kind: 'remote' | 'alias' | 'path';
}
