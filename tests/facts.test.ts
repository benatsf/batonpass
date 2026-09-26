import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectFacts, type CommandRunner } from '../src/facts.ts';

const fake = (answers: Record<string, string | null>): CommandRunner => (cmd, args) => answers[`${cmd} ${args.join(' ')}`] ?? null;

test('collects git and gh facts', () => {
  const facts = collectFacts('/r', fake({
    'git rev-parse --abbrev-ref HEAD': 'main',
    'git log -1 --format=%h%x09%s': 'abc1234\tFix checkout',
    'git rev-list --left-right --count @{upstream}...HEAD': '2\t1',
    'git --no-optional-locks status --porcelain': ' M a.ts\n?? b.ts',
    'git log -5 --format=%h %s': 'abc1234 Fix checkout\ndef5678 Add tests',
    'gh pr list --state open --limit 10 --json number,title,isDraft,statusCheckRollup': JSON.stringify([
      { number: 51, title: 'Retire functions', isDraft: false, statusCheckRollup: [{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }, { status: 'IN_PROGRESS' }] },
    ]),
  }));
  assert.deepEqual(facts, {
    branch: 'main', head: 'abc1234', subject: 'Fix checkout', ahead: 1, behind: 2, changedFiles: 2,
    recentCommits: ['abc1234 Fix checkout', 'def5678 Add tests'],
    openPrs: [{ number: 51, title: 'Retire functions', isDraft: false, checks: '1 passed, 1 failed, 1 pending' }],
  });
});

test('missing upstream, gh or a clean tree degrade gracefully', () => {
  const facts = collectFacts('/r', fake({ 'git rev-parse --abbrev-ref HEAD': 'main', 'git --no-optional-locks status --porcelain': '' }));
  assert.equal(facts.ahead, null);
  assert.equal(facts.changedFiles, 0);
  assert.equal(facts.openPrs, null);
});

test('stops calling commands once the time budget is spent', () => {
  let t = 0;
  const calls: string[] = [];
  collectFacts('/r', (cmd, args) => { calls.push(`${cmd} ${args[0]}`); t += 1000; return ''; }, 1500, () => t);
  assert.deepEqual(calls, ['git rev-parse', 'git log']);
});

test('works against a real repository', () => {
  const dir = mkdtempSync(join(tmpdir(), 'baton-facts-'));
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@e.st', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'first commit']);
  writeFileSync(join(dir, 'new.txt'), 'x');
  const facts = collectFacts(dir);
  assert.equal(facts.branch, 'main');
  assert.equal(facts.subject, 'first commit');
  assert.equal(facts.changedFiles, 1);
});
