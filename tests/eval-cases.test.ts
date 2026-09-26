import test from 'node:test';
import assert from 'node:assert/strict';
import { CASES_DIR, grade, loadCases } from '../src/eval.ts';
import { redact } from '../src/redact.ts';

for (const c of loadCases(CASES_DIR)) {
  test(`case ${c.name} is well formed`, () => {
    const text = c.sessions.flatMap((s) => s.turns.flatMap((t) => [t.user, t.reply])).join('\n');
    const tools = new Set(c.sessions.map((s) => s.tool));
    assert.ok(tools.has('codex') && tools.has('claude'), 'mixes both tools');
    assert.ok(c.probes.length >= 6, 'at least six probes');
    assert.equal(new Set(c.probes.map((p) => p.id)).size, c.probes.length, 'unique probe ids');
    for (const p of c.probes) assert.ok(grade(text, p), `${p.id}: the answer does not occur in the history`);
    assert.ok(c.sessions.every((s) => s.cwd.startsWith(`/batonpass-eval/${c.name}`)));
    assert.deepEqual(redact(text).findings, {}, 'fixtures contain no secret-shaped strings');
  });
}
