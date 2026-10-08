# Claude desktop sessions in every account

`baton desktop` keeps the Claude desktop app's Code-tab sidebar the same in every Claude account signed in on this Mac, the way Codex lists every local session whichever account is logged in. It is opt-in and macOS-only.

## Why sessions disappear when you switch account

Claude Code writes every conversation to `~/.claude/projects/<project>/<session-id>.jsonl`. Those transcripts are shared by all accounts, and `claude --resume` opens any of them. The desktop app's sidebar is a separate index: one small JSON record per session in

```
~/Library/Application Support/Claude/claude-code-sessions/<accountUuid>/<orgUuid>/local_<id>.json
```

The app reads only the signed-in account and organisation's folder, and reads it only when it starts or switches account. Switching account hides the other sessions; it deletes nothing.

Codex has no such split: its sessions are files named by date and id, its index is rebuilt from those files, and logging out deletes only the credentials. `baton desktop` gets the same result by keeping a copy of each record in every account's folder.

## What a sync does

Every minute (or when you run `baton desktop sync`):

1. It finds the real account folders: those holding sessions, or that Claude loaded and kept (from `~/Library/Logs/Claude/main.log`). A folder Claude passed through for a second during a switch is ignored, and nothing runs in the ten seconds after a switch.
2. For each session it takes the most recently saved copy, and copies it into every account folder that lacks it. The copy keeps the title, folder, worktree, model, permission mode and archive state, and drops what belongs to the account that created it: connectors (`remoteMcpServersConfig`, `enabledMcpTools`), Remote Control links (`bridgeSessionIds`, `remoteControl*`), scheduled tasks, cloud and environment links. Fields a later Claude version adds whose names look account-bound are dropped too.
3. An older copy in a folder Claude has not loaded is brought up to date (a rename, an archive), keeping that account's own connector and Remote Control fields.
4. A session deleted in one account (`deleted_<id>` newer than every copy) is hidden in the others: each copy moves to `~/.baton/desktop-sync/quarantine/` and the same `deleted_<id>` marker is written next to it.

It never modifies or removes a file in the folder Claude has loaded (it only adds new ones there), never touches a record Claude saved in the last ten minutes, never follows a symlink, and never reads, moves or deletes a transcript. Writes go to a temporary file renamed into place, so Claude never reads a partial record; a record Claude rewrote in the meantime is left as Claude wrote it.

A session is not copied while its transcript was written in the last minute (a turn is running), when its transcript is gone, when its worktree no longer exists, or when it is an SSH, WSL or cloud session.

## Use

```bash
baton install            # the background job runs batonpass through ~/.baton/bin/baton
baton desktop status     # account folders and what the next sync would do
baton desktop enable     # back up the session list, sync once, then every minute
baton desktop sync       # run one sync now (--dry-run shows it without writing)
baton desktop disable    # stop the background job
```

`enable` copies `claude-code-sessions` to `~/.baton/desktop-sync/backups/<time>/` first, then installs the LaunchAgent `~/Library/LaunchAgents/batonpass.desktop-sync.plist`. `disable` and `baton uninstall` unload and remove it; copies already made stay, and Claude shows them like any other session. `baton doctor` reports whether the sync is on and whether it logged errors (`~/.baton/logs/desktop-sync.err`).

## What to expect

- Copies appear the next time you switch to that account. A brand-new account's sidebar fills in after you switch away from it and back once.
- Resuming a session under another account works and is billed to that account. Connectors the new account lacks are reported to the model as unavailable, Remote Control starts a fresh link without the earlier history, and extended thinking written under another organisation cannot be reused, so the first reply rereads the session at extra cost.
- Deleting a session hides it everywhere but frees no disk space: while another account still lists a session, Claude keeps its transcript instead of deleting it. It stays resumable with `claude --resume <id>`.
- Opening the same session in two accounts at once makes two Claude processes write to one transcript. Finish in one before continuing in the other.

## Browser tabs and cookies

Signing out of Claude closes every tab in every session's built-in browser, and empties the browser's cookie jar, which all sessions share. Claude keeps those tabs only in memory, also closes them after 30 idle minutes, and offers no way for another program to reopen them. So batonpass cannot put them back the way it puts back sidebar records.

What it does instead: when a Claude Code session resumes, the SessionStart hook adds the pages that session's agent had open, newest first. It rebuilds the list from the agent's own browser calls in the ledger (the last 14 days, at most 8 pages), after reading any turn the switch cut short. Continue the session, for example with "reopen your tabs", and the agent reopens the ones the work needs. Pages you opened yourself are not in the transcript, so they are not listed. This needs only the hooks (`baton install`), not `baton desktop enable`.

Cookies come back through Claude's own Chrome import, which refills the jar from Chrome after you sign in. A site you signed into only inside the built-in browser has to be signed into again; signing into it in Chrome as well makes it survive the next switch. batonpass does not copy the cookie jar: that would mean keeping a second copy of every web login and replacing a database Claude keeps open.

## Limits

This relies on how Claude desktop stores its sidebar, which is undocumented and was checked against Claude desktop 2.26454 (October 2026). If an update changes it, `baton desktop disable` stops the job; the backup restores the previous state.
