# Changelog

All notable changes follow [Semantic Versioning](https://semver.org/).

## 0.1.0

- Codex and Claude Code transcript readers, incremental and read-only.
- Secret redaction before storage; tool outputs are never stored.
- SQLite ledger with full-text search and atomic, numbered snapshots.
- `SessionStart`, `Stop` and `PreCompact` hooks for both tools; `baton install` / `uninstall`.
- `recent-dialogue` selection by default; opt-in `jev-select`; experimental `jev.rules`.
- `baton status | show | ingest | search | note | resume | doctor | eval`.
- Recall evaluation with 8 cases and 64 probes, and a published scorecard.
