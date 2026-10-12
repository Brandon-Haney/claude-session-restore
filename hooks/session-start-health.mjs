#!/usr/bin/env node
// Claude Code SessionStart hook: if the Claude Session Restore extension has found
// that Claude Code changed something it relies on, tell the user and hand the details
// to Claude so it can investigate. Silent when everything is fine.
//
// Install: copy to ~/.claude/hooks/ and add to ~/.claude/settings.json:
//   "SessionStart": [{ "matcher": "startup|resume", "hooks": [{ "type": "command",
//     "command": "node \"$HOME/.claude/hooks/session-start-health.mjs\"", "timeout": 10 }] }]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const file = process.env.CLAUDE_SESSION_RESTORE_HEALTH ?? path.join(os.homedir(), ".claude-session-restore", "health.json");

let health;
try {
  health = JSON.parse(fs.readFileSync(file, "utf8"));
} catch {
  process.exit(0); // extension not installed or nothing recorded yet
}

const now = Date.now();
const issues = (Array.isArray(health?.issues) ? health.issues : []).filter(
  (i) => i && i.severity === "error" && typeof i.message === "string" && i.expiresAt > now,
);
if (issues.length === 0) process.exit(0);

const lines = issues.map(
  (i) =>
    `- [${i.code}] ${i.message} (first seen ${new Date(i.firstSeen).toLocaleString()}, last seen ${new Date(i.lastSeen).toLocaleString()}${i.claudeVersion ? `, Claude Code ${i.claudeVersion}` : ""})`,
);

const context = [
  `The user's "Claude Session Restore" VS Code extension (v${health.extensionVersion ?? "?"}) reports that it may no longer work with this version of Claude Code:`,
  ...lines,
  "",
  "The extension reads Claude Code's undocumented running-session registry (~/.claude/sessions/<pid>.json: pid, sessionId, cwd, kind, entrypoint) to restore sessions after VS Code restarts or crashes, and resumes them with `claude --resume <id>`.",
  `Health file: ${file}. Source: github.com/Brandon-Haney/claude-session-restore (src/tracker.ts and src/health.ts hold the registry assumptions).`,
  "At a natural point early in this conversation, briefly tell the user about this and offer to investigate what changed and fix the extension. Do not start changing anything without their go-ahead.",
].join("\n");

process.stdout.write(
  JSON.stringify({
    systemMessage: `⚠ Claude Session Restore: ${issues.length} compatibility problem(s) with this Claude Code version. Ask Claude to investigate.`,
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context },
  }),
);
