import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import type { Cursor } from '../types.ts';

export interface ReadOptions {
  backfillBytes: number;
  maxLineBytes: number;
  maxReadBytes: number;
  chunkBytes?: number;
}

export interface ReadResult {
  lines: string[];
  cursor: Cursor;
  skippedLong: number;
  reset: boolean;
}

const NEWLINE = 0x0a;

function alignToNextLine(fd: number, start: number, size: number, chunkBytes: number): number {
  const one = Buffer.alloc(1);
  readSync(fd, one, 0, 1, start - 1);
  if (one[0] === NEWLINE) return start;
  const buf = Buffer.allocUnsafe(chunkBytes);
  for (let pos = start; pos < size; ) {
    const n = readSync(fd, buf, 0, Math.min(chunkBytes, size - pos), pos);
    if (n <= 0) break;
    const index = buf.subarray(0, n).indexOf(NEWLINE);
    if (index >= 0) return pos + index + 1;
    pos += n;
  }
  return size;
}

export function readNewLines(path: string, prev: Cursor | null, options: ReadOptions): ReadResult {
  const chunkBytes = options.chunkBytes ?? 1024 * 1024;
  const fd = openSync(path, 'r');
  try {
    const st = fstatSync(fd);
    const reset = prev !== null && (prev.inode !== st.ino || st.size < prev.offset);
    const resume = prev !== null && !reset;
    let start = resume ? prev.offset : Math.max(0, st.size - options.backfillBytes);
    if (!resume && start > 0) start = alignToNextLine(fd, start, st.size, chunkBytes);
    const end = Math.min(st.size, start + options.maxReadBytes);

    const lines: string[] = [];
    let skippedLong = 0;
    let skipping = resume ? Boolean(prev.skipping) : false;
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let committed = start;
    const buf = Buffer.allocUnsafe(chunkBytes);

    for (let pos = start; pos < end; ) {
      const n = readSync(fd, buf, 0, Math.min(chunkBytes, end - pos), pos);
      if (n <= 0) break;
      let lineStart = 0;
      for (let i = 0; i < n; i++) {
        if (buf[i] !== NEWLINE) continue;
        const piece = buf.subarray(lineStart, i);
        if (skipping || pendingBytes + piece.length > options.maxLineBytes) {
          skippedLong++;
        } else {
          const line = Buffer.concat([...pending, piece]).toString('utf8').replace(/\r$/, '');
          if (line.trim()) lines.push(line);
        }
        pending = [];
        pendingBytes = 0;
        skipping = false;
        lineStart = i + 1;
        committed = pos + i + 1;
      }
      if (lineStart < n) {
        const rest = buf.subarray(lineStart, n);
        if (skipping || pendingBytes + rest.length > options.maxLineBytes) {
          skipping = true;
          pending = [];
          pendingBytes = 0;
        } else {
          pending.push(Buffer.from(rest));
          pendingBytes += rest.length;
        }
      }
      pos += n;
    }

    // An over-long line that runs past this read window is abandoned up to `end`
    // so the next read makes progress instead of re-reading the same window.
    const carrySkip = skipping && end < st.size;
    if (carrySkip) committed = end;
    return {
      lines,
      skippedLong,
      reset,
      cursor: { path, inode: st.ino, offset: committed, size: st.size, mtimeMs: st.mtimeMs, skipping: carrySkip },
    };
  } finally {
    closeSync(fd);
  }
}

export function readHeadLine(path: string, maxBytes: number): string | null {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    const index = buf.subarray(0, n).indexOf(NEWLINE);
    return index < 0 ? null : buf.subarray(0, index).toString('utf8').replace(/\r$/, '');
  } finally {
    closeSync(fd);
  }
}
