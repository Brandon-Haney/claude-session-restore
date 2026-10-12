const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const hook = path.join(__dirname, "..", "hooks", "session-start-health.mjs");

function runHook(health) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "csr-hook-")), "health.json");
  if (health) fs.writeFileSync(file, JSON.stringify(health));
  return execFileSync(process.execPath, [hook], { input: "{}", env: { ...process.env, CLAUDE_SESSION_RESTORE_HEALTH: file } }).toString();
}

test("silent with no health file or no active errors", () => {
  assert.strictEqual(runHook(null), "");
  const expired = { issues: [{ code: "a", severity: "error", message: "m", firstSeen: 0, lastSeen: 0, expiresAt: 1 }] };
  assert.strictEqual(runHook(expired), "");
  const info = { issues: [{ code: "a", severity: "info", message: "m", firstSeen: 0, lastSeen: 0, expiresAt: Date.now() + 60000 }] };
  assert.strictEqual(runHook(info), "");
});

test("active errors reach the user and Claude's context", () => {
  const out = JSON.parse(
    runHook({
      extensionVersion: "0.2.0",
      issues: [{ code: "registry-format-changed", severity: "error", message: "fields renamed", firstSeen: 1, lastSeen: 2, expiresAt: Date.now() + 60000 }],
    }),
  );
  assert.match(out.systemMessage, /1 compatibility problem/);
  assert.strictEqual(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(out.hookSpecificOutput.additionalContext, /registry-format-changed\] fields renamed/);
});
