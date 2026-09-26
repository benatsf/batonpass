import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { redact } from '../src/redact.ts';

const ROOT = join(import.meta.dirname, '..');
const TARGETS = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md', 'docs', 'integrations', 'evals'];
const TEXT = /\.(md|json|ts|yml|yaml|txt)$/;

function walk(path: string, out: string[]): void {
  if (!existsSync(path)) return;
  if (statSync(path).isDirectory()) {
    // docs/superpowers holds design notes that quote the redaction tests' synthetic inputs.
    for (const entry of readdirSync(path)) if (entry !== 'node_modules' && entry !== 'superpowers') walk(join(path, entry), out);
  } else if (TEXT.test(path)) out.push(path);
}

test('published docs, fixtures, integrations and scorecards contain no secret-shaped strings', () => {
  const files: string[] = [];
  for (const target of TARGETS) walk(join(ROOT, target), files);
  assert.ok(files.length > 10, 'the scan found the repository files');
  const offenders = files
    .map((file) => ({ file: relative(ROOT, file), findings: redact(readFileSync(file, 'utf8')).findings }))
    .filter((r) => Object.keys(r.findings).length > 0);
  assert.deepEqual(offenders, []);
});

test('every required repository document exists', () => {
  for (const file of ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md', 'LICENSE', 'docs/privacy.md', 'docs/writing-a-reader.md', '.github/workflows/ci.yml']) {
    assert.ok(existsSync(join(ROOT, file)), file);
  }
});
