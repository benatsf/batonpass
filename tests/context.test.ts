import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureHome } from '../src/config.ts';
import { createContext } from '../src/context.ts';
import { Ledger } from '../src/ledger.ts';

test('opening a context re-redacts a ledger written by an older redactor', () => {
  const root = mkdtempSync(join(tmpdir(), 'baton-context-'));
  const home = join(root, '.baton');
  ensureHome(home);
  const leaked = 'Xk9' + 'mQ2vLp7w';
  const old = new Ledger(join(home, 'baton.db'));
  old.insertEvent('p', { tool: 'codex', sessionId: 's', ts: '2026-09-26T10:00:00.000Z', cwd: '/w', kind: 'tool_call', text: `exec DATABASE_PASSWORD=${leaked}`, meta: {} });
  old.close();
  const ctx = createContext({ HOME: root, BATON_HOME: home });
  assert.equal(ctx.ledger.events('p')[0]!.text, 'exec DATABASE_PASSWORD=[REDACTED:assignment]');
  ctx.close();
});
