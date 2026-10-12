# Claude Session Restore

Reopens the Claude Code sessions that were running in a VS Code window when it last closed or crashed, the way a browser offers to restore its tabs.

> **Unofficial.** Not made by or affiliated with Anthropic.
>
> **Status: early.** Tested on Windows only: tracking, window reloads, a force close and a normal quit, with 8 sessions across 3 windows.

Inspired by [Claude Sessions Restore](https://marketplace.visualstudio.com/items?itemName=fahadjabbar.claude-sessions-restore) by Fahad Jabbar (MIT), rewritten to restore only what was actually open.

## How it works

- Every few seconds it reads Claude Code's live session list (`~/.claude/sessions/<pid>.json`) and keeps the sessions that belong to **this window**:
  - terminal sessions whose `claude` process descends from one of this window's terminal shells;
  - chat panel sessions whose process descends from this window's extension host.
- The recorded list is replaced on every snapshot, not accumulated. A session you end with `/exit` or whose terminal you close drops off after two snapshots; a window that crashes or quits keeps its last list.
- On the next startup it waits a few seconds (so the Claude Code extension can restore its own chat tabs), then offers anything recorded that is no longer running: **Restore All**, **Choose…** or **Dismiss**.
- Terminal sessions reopen in a new terminal in their original folder with `claude --resume <id>`. Chat panel sessions reopen in the panel through `vscode://anthropic.claude-code/open?session=<id>`; if the tab is already open it is just focused.

## When Claude Code changes

The session registry is undocumented, so the extension checks that it still matches what it expects, and says so loudly when it does not. Checks run once a minute for five minutes after anything that could reveal a change (the window opens, a terminal opens, a new Claude session appears), plus every 15 minutes as a backstop for `claude` started in a terminal that was already open. The rest of the time it stays idle.

| Check | Problem code |
|---|---|
| `claude` has been running in one of this window's terminals for a few minutes with no entry in `~/.claude/sessions/` | `registry-missing-sessions` |
| …and `~/.claude/sessions/` does not exist at all | `registry-dir-missing` |
| It has an entry, but one the extension no longer recognises (changed `kind` or `entrypoint`) | `registry-sessions-unrecognised` |
| Registry files no longer have `pid`, `sessionId` and `cwd` | `registry-format-changed` |
| A restored terminal session is not running a minute after `claude --resume` was sent | `resume-not-running` |

New `kind` or `entrypoint` values and Claude Code version changes are noted in the output log without an alert.

A problem is reported in three places:

1. A VS Code warning (at most once a day per problem) with **Show Log** and **Investigate with Claude**, which opens Claude Code in `claudeRestore.sourceFolder`.
2. `~/.claude-session-restore/health.json`, shared by all windows. Problems stay in it while they last and expire an hour after they were last seen (three days for a failed resume).
3. An optional Claude Code `SessionStart` hook, [`hooks/session-start-health.mjs`](hooks/session-start-health.mjs), which shows a warning when a Claude session starts and gives Claude the details so it can offer to investigate. It is silent when everything is fine. To install, copy it to `~/.claude/hooks/` and add to `~/.claude/settings.json`:

```json
"hooks": {
  "SessionStart": [
    { "matcher": "startup|resume", "hooks": [{ "type": "command", "command": "node \"$HOME/.claude/hooks/session-start-health.mjs\"", "timeout": 10 }] }
  ]
}
```

Run **Claude Session Restore: Check Compatibility with Claude Code** at any time for an immediate check.

## Commands

- **Claude Session Restore: Restore Sessions from Last Run**: pick from the last run's sessions again, e.g. after dismissing the prompt.
- **Claude Session Restore: Show Tracked Sessions**: what this window is currently recording.
- **Claude Session Restore: Check Compatibility with Claude Code**: run the checks below now.

## Settings

| Setting | Default | |
|---|---|---|
| `claudeRestore.promptOnStartup` | `true` | Offer to restore on startup. |
| `claudeRestore.includeChatPanel` | `true` | Also track chat panel sessions. |
| `claudeRestore.snapshotIntervalSeconds` | `10` | How often sessions are recorded. |
| `claudeRestore.resumeCommand` | `claude --resume ${sessionId}` | Command typed into restored terminals. |
| `claudeRestore.sourceFolder` | first workspace folder | Where **Investigate with Claude** opens Claude Code. |

## Limits

- `~/.claude/sessions/` is an undocumented Claude Code file; a future version could change it.
- Two windows open on the *same* folder share one record (VS Code stores state per workspace), so the last one to write wins.
- Claude Code deletes transcripts after `cleanupPeriodDays` (30 by default); a session older than that cannot be resumed.

## Build

```sh
npm install
npm test
npm run package   # produces claude-session-restore-<version>.vsix
code --install-extension claude-session-restore-<version>.vsix
```
