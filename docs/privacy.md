# Privacy and data handling

## What is read

Transcript files of Codex (`~/.codex/sessions/**/rollout-*.jsonl`, `~/.codex/session_index.jsonl`) and Claude Code (`~/.claude/projects/*/*.jsonl`). They are opened read-only and never modified, moved or deleted.

## What is stored

In `~/.baton/baton.db` (SQLite, file mode `0600`, directory `0700`):

- user messages and the agent's text replies, after redaction;
- tool call names with abbreviated inputs (at most 300 characters), after redaction;
- goals, session titles, pull request links, compaction markers, token usage and cost figures;
- your `baton note` entries, after redaction;
- rendered snapshots and cached Jev scores.

Tool outputs (command output, file contents, web pages) are never stored as such. Claude Code's compaction summaries are stored after redaction; the model writes them from the whole context, so they can paraphrase tool output. Events older than 90 days and all but the latest 50 snapshots per project are pruned.

## Redaction

Before anything is stored, text passes rules for private keys, credentials in URLs, Stripe, Supabase, Anthropic, OpenAI, GitHub, Apify, AWS, Google and Slack keys, JWTs, bearer tokens, values assigned to names containing password, secret, token or api_key (`DATABASE_PASSWORD=…`, `"password": "…"`, `--password …`), and high-entropy values next to words like "token" or "secret". A match becomes `[REDACTED:<rule>]`. `baton doctor` shows how many values each rule replaced. Redaction is a safety net, not a guarantee: rotate any secret you pasted into an agent session.

## What leaves your machine

- Nothing, with the default `recent-dialogue` strategy.
- With `select.strategy = "jev-select"` and a key in `TYPESAFE_API_KEY`: redacted dialogue text (never tool outputs) is sent to TypeSafe's Jev endpoint (`https://api.typesafe.ai/v1/systemone`). Requests are capped per ingest (`jev.maxRequestsPerIngest`) and per day (`jev.maxInputTokensPerDay`). Read TypeSafe's terms and data-handling pages at https://typesafe.ai before enabling it.
- When `gh` is installed and signed in, `baton` runs `gh pr list` (read-only) in your repository to show open pull requests.

There is no telemetry.

## Removing everything

`baton uninstall` removes the hooks and skills it installed. Delete `~/.baton` to remove the ledger.
