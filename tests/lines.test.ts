import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHeadLine, readNewLines, type ReadOptions } from '../src/readers/lines.ts';

const opts: ReadOptions = { backfillBytes: 1 << 20, maxLineBytes: 1 << 16, maxReadBytes: 1 << 20 };
const file = (content: string | Buffer) => {
  const path = join(mkdtempSync(join(tmpdir(), 'baton-lines-')), 'a.jsonl');
  writeFileSync(path, content);
  return path;
};

test('reads complete lines and leaves a partial last line for later', () => {
  const path = file('one\ntwo\nthr');
  const first = readNewLines(path, null, opts);
  assert.deepEqual(first.lines, ['one', 'two']);
  assert.equal(first.cursor.offset, 8);
  appendFileSync(path, 'ee\nfour\n');
  const second = readNewLines(path, first.cursor, opts);
  assert.deepEqual(second.lines, ['three', 'four']);
  assert.equal(second.reset, false);
});

test('strips CRLF and skips blank lines', () => {
  assert.deepEqual(readNewLines(file('a\r\n\r\nb\n'), null, opts).lines, ['a', 'b']);
});

test('decodes a multi-byte character split across chunks', () => {
  const text = 'é€😀 done\n';
  const lines = readNewLines(file(text), null, { ...opts, chunkBytes: 3 }).lines;
  assert.deepEqual(lines, ['é€😀 done']);
});

test('skips an over-long line and counts it', () => {
  const long = 'x'.repeat(200);
  const result = readNewLines(file(`a\n${long}\nb\n`), null, { ...opts, maxLineBytes: 100, chunkBytes: 16 });
  assert.deepEqual(result.lines, ['a', 'b']);
  assert.equal(result.skippedLong, 1);
});

test('skips an over-long line spanning several read windows', () => {
  const path = file(`a\n${'y'.repeat(500)}\nb\n`);
  const small = { ...opts, maxLineBytes: 100, maxReadBytes: 128, chunkBytes: 32 };
  let cursor = readNewLines(path, null, small).cursor;
  const seen: string[] = ['a'];
  for (let i = 0; i < 10 && cursor.offset < 505; i++) {
    const next = readNewLines(path, cursor, small);
    seen.push(...next.lines);
    cursor = next.cursor;
  }
  assert.ok(seen.includes('b'), `never reached the line after the long one: ${JSON.stringify(cursor)}`);
});

test('re-reads from the backfill window after truncation or replacement', () => {
  const path = file('one\ntwo\n');
  const first = readNewLines(path, null, opts);
  writeFileSync(path, 'x\n');
  const truncated = readNewLines(path, first.cursor, opts);
  assert.equal(truncated.reset, true);
  assert.deepEqual(truncated.lines, ['x']);
  const other = join(path, '..', 'b.jsonl');
  writeFileSync(other, 'new\n');
  renameSync(other, path);
  const replaced = readNewLines(path, truncated.cursor, opts);
  assert.equal(replaced.reset, true);
  assert.deepEqual(replaced.lines, ['new']);
});

test('first read starts at a line boundary inside the backfill window', () => {
  const result = readNewLines(file('aaaa\nbbbb\ncccc\n'), null, { ...opts, backfillBytes: 7 });
  assert.deepEqual(result.lines, ['cccc']);
});

test('readHeadLine returns the first line within a byte limit', () => {
  const path = file('{"head":1}\n{"x":2}\n');
  assert.equal(readHeadLine(path, 1024), '{"head":1}');
  assert.equal(readHeadLine(file('no newline here'), 5), null);
});
