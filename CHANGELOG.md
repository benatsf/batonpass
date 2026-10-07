# Changelog

All notable changes follow [Semantic Versioning](https://semver.org/).

## Unreleased

- `baton desktop enable` no longer prints "Boot-out failed: 3: No such process" the first time: it asks launchctl to unload the background job only when one was installed before.

## 0.3.0

- `baton desktop` (macOS, opt-in): keeps Claude desktop's Code-tab sessions visible in every Claude account signed in on the Mac. `enable` backs up the session list and installs a LaunchAgent that syncs every minute; `status`, `sync [--dry-run]` and `disable` complete it. Copies drop connector, Remote Control, scheduled-task and cloud fields; deletions spread as hidden, quarantined copies; transcripts are never touched. See `docs/claude-desktop-sync.md`.
- `baton doctor` reports whether the desktop sync is on and whether it logged errors; `baton uninstall` also stops it.

## 0.2.2

- `baton inbox` run inside Codex or Claude Code prints messages in the same `<baton-messages>` data framing as the hooks, so message text reaches the agent as relayed data rather than bare text. In your own terminal it is still a plain list.
- `docs/waking-idle-agents.md`: what `codex queue` does to idle, busy, closed and unknown Codex sessions, and the agreed plan for waking an idle agent (not built yet).

## 0.2.1

- `baton install` no longer reports "inline [hooks]" in Codex's config.toml when that file only holds Codex's own hook trust records (`[hooks.state."…"]`).

## 0.2.0

- Messages between agents: `baton send` queues a short message for the other agent (or from you) in the same project; `baton inbox` lists them and `--ack` marks them read.
- Delivery through new `UserPromptSubmit` and `PostToolUse` hooks and the existing `Stop` hook, for both Codex and Claude Code. Each message is delivered once, framed as data from another agent, never into a subagent, and `Stop` forces at most one continuation per turn.
- `baton-message` skill for both tools.
- `baton doctor` compares installed hooks with the ones this version needs, so an upgrade without `baton install` is reported.
- `baton install` puts its hooks back at the same position among yours on a reinstall; Codex keys hook trust by position.
- The Codex reader skips Stop-hook continuations (`<hook_prompt>`), which are not user prompts.
- Ledger schema 3 (new `messages` table, added in place). Earlier versions refuse to open it.
- The Codex reader no longer records scheduled heartbeats (`<heartbeat>`) or opened app pages (`<external_codex_apps_open_page>`) as user prompts, nor any user message whose Codex `content_item_kinds` all mark harness context. Rows already in the ledger are not rewritten.

## 0.1.0

- Codex and Claude Code transcript readers, incremental and read-only.
- Secret redaction before storage; tool outputs are never stored.
- SQLite ledger with full-text search and atomic, numbered snapshots.
- `SessionStart`, `Stop` and `PreCompact` hooks for both tools; `baton install` / `uninstall`.
- `recent-dialogue` selection by default; opt-in `jev-select`; experimental `jev.rules`.
- `baton status | show | ingest | search | note | resume | doctor | eval`.
- Recall evaluation with 8 cases and 64 probes, and a published scorecard.
