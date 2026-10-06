# batonpass

Automatic, local, verbatim session handoff between Codex and Claude Code.

Finish a turn in Codex, open Claude Code in the same repository, and it already knows what Codex just did: the last exchanges word for word, the goal, the pull requests and the state of the branch. The same works from Claude Code to Codex. No command to remember, no hosted service, no model-written summary.

While both work on the same repository, either one (or you) can also message the other with `baton send`; the message shows up in the other agent at its next prompt, tool call or turn end.

## How it works

- **`Stop` hook** (both tools, runs in the background): reads the new lines of the session transcript, removes secrets, stores the dialogue in a local SQLite ledger (`~/.baton/baton.db`) and renders a numbered snapshot of the project.
- **`SessionStart` hook** (both tools): injects the latest brief, about 2,000 tokens, as context. No network call, no model call.
- **`PreCompact` hook**: stores everything before the tool compacts its own context.
- **`UserPromptSubmit`, `PostToolUse` and `Stop` hooks** (both tools): deliver messages from the other agent. See [Messages between agents](#messages-between-agents).
- Sessions are grouped by git remote, so clones and worktrees of one repository share one history.

The brief is framed as prior context, not instructions, and always tells the new session how to look further back: `baton search "<words>"`, `baton show --full`, or the original session (`codex resume <id>`, `claude --resume <id>`).

## Install

Requires Node.js 24 or later.

```bash
npm install -g @batonpass/cli
baton install --dry-run
baton install
```

`baton install` merges five hooks into `~/.claude/settings.json` and `~/.codex/hooks.json`, installs the `baton-resume` and `baton-message` skills for both tools, keeps a backup of every file it changes, and records what it added so `baton uninstall` removes exactly that. Codex runs a new hook only after you trust it: run `/hooks` in Codex. Upgrading from 0.1.0: run `baton install` again to add the message hooks; your existing hooks are left as they are, so Codex keeps trusting them, and `baton doctor` says when hooks are missing.

Existing history is read on the first `baton ingest` (the last 30 days, at most 64 MiB per transcript).

## Commands

| Command | What it does |
| --- | --- |
| `baton status` | Projects, sessions per tool, snapshot age, Jev spend today |
| `baton show [--full] [--project id] [--json]` | Print the latest snapshot for this repository |
| `baton ingest [--all] [--project id]` | Read new transcript lines now and refresh snapshots |
| `baton search <words…>` | Full-text search over this project's redacted history |
| `baton note <text…>` | Pin a note into every future snapshot of this project |
| `baton send [--to codex\|claude] <text…>` | Message the other agent working on this project |
| `baton inbox [--tool codex\|claude] [--ack] [--all] [--json]` | List this project's messages; `--ack` marks them read |
| `baton resume codex` / `baton resume claude` | Start the other tool here with the brief as its first prompt |
| `baton doctor [--jev]` | Check Node, hooks, transcripts, ledger health and redaction counts |
| `baton eval` | Run the recall evaluation and write a scorecard |
| `baton install` / `baton uninstall` | Add or remove the hooks and the skills |

## Messages between agents

```bash
baton send "Schema migration is merged; rebase before touching billing."  # inside an agent: goes to the other one
baton send --to codex "Pause after the current step."                     # from your terminal
baton inbox                                                               # what is waiting in this project
```

The recipient sees the message at its next hook boundary:

| When | Codex | Claude Code |
| --- | --- | --- |
| You submit a prompt | `UserPromptSubmit` adds it as context | same |
| A tool call finishes | `PostToolUse` adds it as context; the agent reads it before its next step | same |
| The agent ends its turn | `Stop` blocks once with the message as the reason, so the agent reads it and continues | same |

- Messages are framed as relayed data, with sender, time and id, inside `<baton-messages>`; the agent is told they are not instructions from the user and that the user's own messages take precedence. A message sent from a terminal is labelled as from the user, but batonpass cannot verify who ran `baton send`. Inside an agent's shell the sender is that agent; pass `--from user` when you type the command there yourself (Claude Code's `!`).
- Each message is delivered once: claiming it and marking it delivered is one SQLite statement, so two hooks never both get it. `baton inbox --ack` marks your agent's messages read by hand.
- Messages are grouped by project like sessions (git remote), redacted before they are stored, and at most 2,000 characters. Hooks deliver messages up to 24 hours old (`[messages] maxAgeHours`); older ones stay listed in `baton inbox`.
- Subagents never receive them: delivery waits for the agent you are talking to.
- `Stop` forces at most one extra step per turn (it checks `stop_hook_active`), so two agents cannot keep each other running.
- The `baton-message` skill tells each agent how to send, and to reply only when it helps the other agent.

Limits:

- Hooks run only while an agent is working. A message to an idle session waits for your next prompt there; nothing wakes it yet. [docs/waking-idle-agents.md](docs/waking-idle-agents.md) records what was tested and the plan.
- With two sessions of the same tool open on one project, whichever reaches a hook boundary first gets the message.
- Codex runs the new `UserPromptSubmit` and `PostToolUse` hooks only after you trust them in `/hooks`. Until then, the `Stop` hook you already trusted still delivers at the end of each turn.
- Codex shows a `Stop` reason to the model XML-escaped inside `<hook_prompt>`; the model still reads it.
- Each tool call pays about 50 to 80 ms for the `PostToolUse` check: one Node start and one indexed query. Git runs only while a message for that tool is waiting, in any project.
- Outside a git repository, the project is the exact directory: send from the directory the agents were started in.

Verified in live sessions with Claude Code 2.1.284 and Codex CLI 0.160.0 (all three delivery points in each), and against the Codex hook schema in `openai/codex` rust-v0.160.1.

## Privacy

- Transcripts never leave your machine. The ledger lives in `~/.baton` (directory `0700`, database `0600`).
- Tool outputs are never stored (Claude Code's compaction summaries are, and the model writes those from the whole context). Everything stored passes a secret redactor first, messages from `baton send` included.
- The default strategy makes no network call. The only optional network use is Jev (below) and read-only `gh` for open pull requests.

Details: [docs/privacy.md](docs/privacy.md).

## Selection

The brief keeps the most recent dialogue turns verbatim until its budget is spent (`recent-dialogue`, the default). With a TypeSafe key you can opt in to `jev-select`: when the dialogue does not fit, TypeSafe's Jev model marks exchanges that are safe to cut, and only confident answers are acted on. `jev.rules` (experimental) extracts standing instructions into their own section.

```toml
# ~/.baton/config.toml
[select]
strategy = "jev-select"        # default "recent-dialogue"

[jev]
maxInputTokensPerDay = 2000000 # about $0.08 a day at the published price
rules = false

[messages]
maxAgeHours = 24               # hooks skip undelivered messages older than this

[aliases]
"~/old/checkout/of/web" = "github.com/acme/web"
```

## Evaluation

`baton eval` rebuilds 8 synthetic multi-session histories (Codex and Claude Code mixed), renders the brief with each strategy, and asks a fresh `claude -p` session 64 questions about decisions, constraints, identifiers, verified results and open items: once from the brief alone, once with one `baton search`. Latest scorecard ([evals/results](evals/results/SCORECARD-2026-09-26.md), answered by Claude Haiku through `claude -p`):

| Strategy | Recall, brief only | Recall, brief + one search | Brief tokens (avg) |
| --- | --- | --- | --- |
| no context | 0.0% (0/64) | 70.3% (45/64) | 0 |
| `recent-dialogue` (default) | 71.9% (46/64) | 95.3% (61/64) | 1,497 |
| `jev-select` | not yet measured (needs a TypeSafe key) | | |

A release ships only when the default strategy is at least as good as `recent-dialogue` on both measures, beats having no context, and the run had no failed answers.

## Supported transcripts

Codex rollouts (`~/.codex/sessions`, CLI 0.155 format) and Claude Code sessions (`~/.claude/projects`, 2.1.x). Readers ignore unknown line types; `baton doctor` reports malformed lines. Adding another agent means adding one reader: see [docs/writing-a-reader.md](docs/writing-a-reader.md).

## License

MIT. Contributions welcome: see [CONTRIBUTING.md](CONTRIBUTING.md).
