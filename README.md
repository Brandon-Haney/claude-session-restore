# Claude Session Restore

Reopens the Claude Code sessions that were running in a VS Code window when it last closed or crashed, the way a browser offers to restore its tabs.

Inspired by [Claude Sessions Restore](https://marketplace.visualstudio.com/items?itemName=fahadjabbar.claude-sessions-restore) by Fahad Jabbar (MIT), rewritten to restore only what was actually open.

## How it works

- Every few seconds it reads Claude Code's live session list (`~/.claude/sessions/<pid>.json`) and keeps the sessions that belong to **this window**:
  - terminal sessions whose `claude` process descends from one of this window's terminal shells;
  - chat panel sessions whose process descends from this window's extension host.
- The recorded list is replaced on every snapshot, not accumulated. A session you end with `/exit` or whose terminal you close drops off after two snapshots; a window that crashes or quits keeps its last list.
- On the next startup it waits a few seconds (so the Claude Code extension can restore its own chat tabs), then offers anything recorded that is no longer running: **Restore All**, **Choose…** or **Dismiss**.
- Terminal sessions reopen in a new terminal in their original folder with `claude --resume <id>`. Chat panel sessions reopen in the panel through `vscode://anthropic.claude-code/open?session=<id>`; if the tab is already open it is just focused.

## Commands

- **Claude Session Restore: Restore Sessions from Last Run**: pick from the last run's sessions again, e.g. after dismissing the prompt.
- **Claude Session Restore: Show Tracked Sessions**: what this window is currently recording.

## Settings

| Setting | Default | |
|---|---|---|
| `claudeRestore.promptOnStartup` | `true` | Offer to restore on startup. |
| `claudeRestore.includeChatPanel` | `true` | Also track chat panel sessions. |
| `claudeRestore.snapshotIntervalSeconds` | `10` | How often sessions are recorded. |
| `claudeRestore.resumeCommand` | `claude --resume ${sessionId}` | Command typed into restored terminals. |

## Limits

- `~/.claude/sessions/` is an undocumented Claude Code file; a future version could change it.
- Two windows open on the *same* folder share one record (VS Code stores state per workspace), so the last one to write wins.
- Claude Code deletes transcripts after `cleanupPeriodDays` (30 by default); a session older than that cannot be resumed.

## Build

```sh
npm install
npm test
npm run package   # produces claude-session-restore-<version>.vsix
code --install-extension claude-session-restore-0.1.0.vsix
```
