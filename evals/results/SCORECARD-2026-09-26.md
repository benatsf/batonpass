# batonpass recall scorecard, 2026-09-26

Answering command: `claude -p --no-session-persistence --model haiku` · cases: 8 · probes: 64.
A probe passes when every word of the expected answer, or of one accepted paraphrase, appears in the reply.

| Strategy | Recall, brief only | Recall, brief + one search | Brief tokens (avg) | Refresh ms (avg) | Jev input tokens | Jev cost |
| --- | --- | --- | --- | --- | --- | --- |
| no-context | 0.0% (0/64) | 70.3% (45/64) | 0 | 25 | 0 | $0.0000 |
| recent-dialogue | 71.9% (46/64) | 95.3% (61/64) | 1497 | 22 | 0 | $0.0000 |
| jev-select | skipped (no TypeSafe key) | – | – | – | – | – |
| jev-select+rules | skipped (no TypeSafe key) | – | – | – | – | – |

Release gate (spec 11.1): the default strategy `recent-dialogue` passes (at least as good as `recent-dialogue` on both measures).
