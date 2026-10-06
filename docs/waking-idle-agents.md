# Waking an idle agent

Status: researched, not built. batonpass delivers messages only through hooks, and hooks run only while an agent is working, so a message to an idle session waits for the user's next prompt there. This page records what was tested on 2026-10-06 and the plan Claude Code and Codex agreed in a discussion relayed through batonpass.

## What `codex queue` does

`codex queue --thread <id> --message <text>` (Codex CLI 0.160.0) adds a message to an existing session. Tested on a disposable interactive Codex session in a scratch repository, with the batonpass hooks installed and trusted:

| Case | Result |
| --- | --- |
| Session open and idle | Accepted. A new turn started about 7 seconds later, with the queued text as the prompt. `UserPromptSubmit` fired, and a pending batonpass message was delivered at that prompt with its usual framing. |
| Session busy (a turn running) | Accepted. The running turn was not interrupted; the queued message ran as its own turn right after it finished. Queued messages run in order. |
| Unknown session id | Error `no rollout found for thread id …`, but only after more than a minute. |
| Unknown session name | No answer after 80 seconds; stopped by hand. |
| Session closed | Accepted, nothing ran. The turn ran when the session was resumed (two minutes later in the test; nothing bounds it). The pending batonpass message was delivered then. |

Claude Code has no equivalent for an idle interactive session, so waking would work for Codex only.

## What that means for a design

- A queued wake does reach the batonpass hooks, so message framing survives. The queued text itself must be fixed and neutral ("batonpass: a message from Claude Code is waiting"), never message content.
- `codex queue` accepting a message proves nothing: a closed session accepts it and runs it whenever it is resumed. batonpass needs a reliable signal that the session is open and idle before queueing. A recent hook run is not one (Stop can precede exit, a hung process looks recent).
- Calls need a short timeout and must target session ids, never names.

## Agreed plan

1. Done in 0.2.2: `baton inbox` run inside an agent prints messages in the same `<baton-messages>` framing as the hooks.
2. Per-session opt-in: `baton wake on`, run inside the session, registers that exact session id (`CODEX_THREAD_ID`) with an expiry; `baton wake off` or expiry revokes it.
3. Messages carry a persisted chain id that replies inherit: at most one wake per chain, claimed atomically, with a cooldown and an hourly budget that survive restarts. An ambiguous queue result is never retried; on any doubt the message waits for normal hook delivery.
4. Immediately before queueing, check that the opt-in is still valid, the session exists, and a reliable signal shows it open and idle.

Step 4 is the open problem: no such signal has been found yet (`codex agents`, which lists sessions on the local app-server daemon, is a candidate, unverified). Nothing past step 1 should ship until it is solved and the cases above pass as tests.
