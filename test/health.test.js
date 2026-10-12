const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const h = require("../dist/health.test-build.js");
const t = require("../dist/tracker.test-build.js");

function fakeClaudeDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csr-"));
  if (files) {
    fs.mkdirSync(path.join(dir, "sessions"));
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, "sessions", name), body);
  }
  return dir;
}

const good = JSON.stringify({ pid: 10, sessionId: "s1", cwd: "C:\\p", kind: "interactive", entrypoint: "cli", version: "2.1.296" });

test("a healthy registry produces no problems or notices", () => {
  const scan = h.scanRegistry(fakeClaudeDir({ "10.json": good }));
  assert.deepStrictEqual(h.registryProblems(scan, []), []);
  assert.deepStrictEqual(h.registryNotices(scan), []);
  assert.deepStrictEqual([...scan.versions], ["2.1.296"]);
});

test("renamed fields are reported as a format change", () => {
  const renamed = JSON.stringify({ processId: 10, session_id: "s1", cwd: "C:\\p" });
  const scan = h.scanRegistry(fakeClaudeDir({ "10.json": renamed }));
  assert.deepStrictEqual(h.registryProblems(scan, []).map((p) => p.code), ["registry-format-changed"]);
});

test("a file caught mid-write is not reported", () => {
  const scan = h.scanRegistry(fakeClaudeDir({ "10.json": '{"pid": 1' }));
  assert.deepStrictEqual(scan.invalid, []);
});

test("claude running with no registry entry is reported, and a missing directory is called out", () => {
  const scan = h.scanRegistry(fakeClaudeDir({ "10.json": good }));
  assert.deepStrictEqual(h.registryProblems(scan, [99]).map((p) => p.code), ["registry-missing-sessions"]);
  const none = h.scanRegistry(fakeClaudeDir(null));
  assert.deepStrictEqual(h.registryProblems(none, [99]).map((p) => p.code), ["registry-dir-missing"]);
});

test("a registered but unrecognised session is reported separately", () => {
  const scan = h.scanRegistry(fakeClaudeDir({ "10.json": good }));
  assert.deepStrictEqual(h.registryProblems(scan, [10]).map((p) => p.code), ["registry-sessions-unrecognised"]);
});

test("new kind and entrypoint values are noticed", () => {
  const odd = JSON.stringify({ pid: 10, sessionId: "s1", cwd: "C:\\p", kind: "tty", entrypoint: "claude-vscode-v2" });
  const notices = h.registryNotices(h.scanRegistry(fakeClaudeDir({ "10.json": odd })));
  assert.strictEqual(notices.length, 2);
});

test("only top-level claude processes under this window's shells count", () => {
  const procs = t.parseProcessTable(
    ["1 0 Code.exe", "20 1 bash.exe", "30 20 claude.exe", "31 30 bash.exe", "32 31 claude.exe", "40 2 bash.exe", "41 40 claude.exe"].join("\n"),
  );
  // 32 is `claude -p` run by session 30; 41 belongs to another window's shell.
  assert.deepStrictEqual(h.claudeProcessesUnderShells(procs, new Set([20])), [30]);
});

test("health merge refreshes, keeps firstSeen and expires old issues", () => {
  let health = h.mergeHealth(null, [{ code: "a", severity: "error", message: "m", ttlMs: 1000 }], "0.2.0", 1000);
  assert.strictEqual(health.issues[0].expiresAt, 2000);
  health = h.mergeHealth(health, [{ code: "a", severity: "error", message: "m2", ttlMs: 1000 }], "0.2.0", 1500);
  assert.deepStrictEqual([health.issues[0].firstSeen, health.issues[0].lastSeen, health.issues[0].message], [1000, 1500, "m2"]);
  health = h.mergeHealth(health, [], "0.2.0", 3000);
  assert.deepStrictEqual(health.issues, []);
});
