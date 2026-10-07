import test from 'node:test';
import assert from 'node:assert/strict';
import { createContext } from '../src/context.ts';
import { runHook } from '../src/hooks.ts';
import { writeSession, type ScriptSession } from '../src/script.ts';
import { openPages, renderTabs } from '../src/tabs.ts';
import { makeEnv } from './support/env.ts';

const call = (tool: string, input: Record<string, unknown> | string) => ({
  text: `mcp__Claude_Browser__${tool} ${typeof input === 'string' ? input : JSON.stringify(input)}`,
});

test('replays navigations per tab and lists the open pages newest first', () => {
  assert.deepEqual(
    openPages([
      call('navigate', { url: 'https://dash.example.com/login' }),
      call('navigate', { tabId: 'seed', url: 'https://dash.example.com/billing' }),
      call('preview_start', { url: 'http://localhost:5178/' }),
      call('navigate', { tabId: 'tab-2', url: 'https://docs.example.com/a' }),
      call('navigate', { tabId: 'tab-3', url: 'https://old.example.com/' }),
      call('tabs_close', { tabId: 'tab-3' }),
      { text: 'Bash ls' },
    ]),
    ['https://docs.example.com/a', 'http://localhost:5178/', 'https://dash.example.com/billing'],
  );
});

test('a page visited again moves to the front, and duplicates collapse', () => {
  assert.deepEqual(
    openPages([
      call('navigate', { tabId: 'a', url: 'https://one.example.com/' }),
      call('navigate', { tabId: 'b', url: 'https://two.example.com/' }),
      call('navigate', { tabId: 'a', url: 'https://one.example.com/' }),
      call('navigate', { tabId: 'c', url: 'https://two.example.com/' }),
    ]),
    ['https://two.example.com/', 'https://one.example.com/'],
  );
});

test('skips what cannot be reopened: history moves, blank pages, redacted and cut URLs', () => {
  assert.deepEqual(
    openPages([
      call('navigate', { url: 'back' }),
      call('navigate', { tabId: 'x', url: 'about:blank' }),
      call('navigate', { tabId: 'y', url: 'https://app.example.com/?token=[REDACTED:bearer]' }),
      call('navigate', '{"tabId":"z","url":"https://app.example.com/a-very-long-path-that-ingest-cut-off-at-three-hundred'),
      call('browser_batch', { actions: [{ name: 'navigate', input: { url: 'https://batch.example.com/' } }, { name: 'computer', input: { action: 'screenshot' } }] }),
    ]),
    ['https://batch.example.com/'],
  );
});

test('lists at most eight pages', () => {
  const calls = Array.from({ length: 12 }, (_, i) => call('navigate', { tabId: `t${i}`, url: `https://p${i}.example.com/` }));
  const pages = openPages(calls);
  assert.equal(pages.length, 8);
  assert.equal(pages[0], 'https://p11.example.com/');
});

test('renders the pages as a framed block, with markup characters escaped', () => {
  assert.equal(
    renderTabs(['https://a.example.com/x<y>']),
    [
      '<baton-browser-tabs>',
      "Pages this session had open in Claude's built-in browser, newest first. Claude closes these tabs when the signed-in account changes and after 30 idle minutes. If the work continues on one of them and it is no longer open, reopen it with the browser tools.",
      '- https://a.example.com/x%3Cy%3E',
      '</baton-browser-tabs>',
    ].join('\n'),
  );
});

function setup() {
  const env = makeEnv();
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const id = '7a1b2c3d-0000-4000-8000-000000000001';
  const session: ScriptSession = {
    tool: 'claude',
    id,
    cwd: env.repo,
    turns: [
      {
        at: at(40),
        user: 'Open the billing dashboard.',
        reply: 'It is open.',
        tools: [{ name: 'mcp__Claude_Browser__navigate', input: JSON.stringify({ tabId: 'seed', url: 'https://dash.example.com/billing' }), output: 'ok' }],
      },
    ],
  };
  const path = writeSession(env.root, session);
  const make = () => createContext({ HOME: env.root, BATON_HOME: env.home, PATH: process.env.PATH }, { facts: () => null });
  const input = (over: Record<string, unknown>) => JSON.stringify({ cwd: env.repo, session_id: id, transcript_path: path, ...over });
  return { env, path, make, input, at, session };
}

const contextOf = (out: string) => (out ? (JSON.parse(out).hookSpecificOutput.additionalContext as string) : '');

test('a resumed Claude Code session is told which pages its browser had open', async () => {
  const { make, input } = setup();
  await runHook('Stop', 'claude', input({}), make, { stop: 'refresh' });
  const context = contextOf(await runHook('SessionStart', 'claude', input({ source: 'resume' }), make));
  assert.ok(context.includes('<baton-context'), 'the project brief is still there');
  assert.ok(context.endsWith('- https://dash.example.com/billing\n</baton-browser-tabs>'));
});

test('a turn that never reached Stop is read at resume', async () => {
  const { env, make, input, at, session, path } = setup();
  await runHook('Stop', 'claude', input({}), make, { stop: 'refresh' });
  session.turns.push({
    at: at(5),
    user: 'Now the invoices.',
    reply: '',
    tools: [{ name: 'mcp__Claude_Browser__navigate', input: JSON.stringify({ tabId: 'seed', url: 'https://dash.example.com/invoices' }), output: 'ok' }],
  });
  assert.equal(writeSession(env.root, session), path);
  const context = contextOf(await runHook('SessionStart', 'claude', input({ source: 'resume' }), make));
  assert.ok(context.includes('- https://dash.example.com/invoices\n</baton-browser-tabs>'));
  assert.ok(!context.includes('/billing'), 'the seed tab moved on from the billing page');
});

test('no page list at startup, for Codex, or for a session without browser calls', async () => {
  const { make, input } = setup();
  await runHook('Stop', 'claude', input({}), make, { stop: 'refresh' });
  assert.ok(!contextOf(await runHook('SessionStart', 'claude', input({ source: 'startup' }), make)).includes('baton-browser-tabs'));
  assert.ok(!contextOf(await runHook('SessionStart', 'codex', input({ source: 'resume' }), make)).includes('baton-browser-tabs'));
  const other = contextOf(await runHook('SessionStart', 'claude', input({ source: 'resume', session_id: 'someone-else', transcript_path: undefined }), make));
  assert.ok(other.includes('<baton-context') && !other.includes('baton-browser-tabs'));
});
