const test = require("node:test");
const assert = require("node:assert");
const t = require("../dist/tracker.test-build.js");

const session = (id, extra = {}) => ({ sessionId: id, cwd: "C:\\proj", kind: "terminal", order: 0, missingTicks: 0, lastSeen: 1, ...extra });

test("snapshot replaces instead of accumulating, with one-tick grace", () => {
  let snap = t.nextSnapshot([], [session("a"), session("b")]);
  assert.deepStrictEqual(snap.map((s) => s.sessionId), ["a", "b"]);
  // b exits: kept for one snapshot (shutdown grace), then dropped.
  snap = t.nextSnapshot(snap, [session("a")]);
  assert.deepStrictEqual(snap.map((s) => [s.sessionId, s.missingTicks]), [["a", 0], ["b", 1]]);
  snap = t.nextSnapshot(snap, [session("a")]);
  assert.deepStrictEqual(snap.map((s) => s.sessionId), ["a"]);
});

test("a session that comes back resets its missing count", () => {
  let snap = t.nextSnapshot([session("a")], []);
  snap = t.nextSnapshot(snap, [session("a")]);
  assert.strictEqual(snap[0].missingTicks, 0);
});

test("offers skip running and duplicate sessions", () => {
  const offers = t.sessionsToOffer([session("a"), session("b"), session("a")], new Set(["b"]));
  assert.deepStrictEqual(offers.map((s) => s.sessionId), ["a"]);
});

test("ownership: terminal sessions must descend from this window's shells", () => {
  const procs = t.parseProcessTable("10 1 Code.exe\n20 10 bash.exe\n30 20 claude.exe\n40 99 claude.exe\n");
  const entry = { pid: 30, sessionId: "a", cwd: "C:\\", entrypoint: "cli" };
  assert.deepStrictEqual(t.ancestry(30, procs), [30, 20, 10, 1]);
  assert.deepStrictEqual(t.ownership(entry, t.ancestry(30, procs), new Set([20]), 10), { kind: "terminal", shellPid: 20 });
  // Another window's session in the same folder (e.g. a home-folder workspace) is not ours.
  assert.strictEqual(t.ownership({ ...entry, pid: 40 }, t.ancestry(40, procs), new Set([20]), 10), null);
});

test("ownership: chat panel sessions must descend from this extension host", () => {
  const procs = t.parseProcessTable("10 1 Code.exe\n50 10 claude.exe\n60 11 claude.exe\n");
  const panel = { pid: 50, sessionId: "p", cwd: "C:\\", entrypoint: "claude-vscode" };
  assert.deepStrictEqual(t.ownership(panel, t.ancestry(50, procs), new Set(), 10), { kind: "panel" });
  assert.strictEqual(t.ownership({ ...panel, pid: 60 }, t.ancestry(60, procs), new Set(), 10), null);
});

test("ancestry stops on cycles", () => {
  const procs = t.parseProcessTable("1 2 a\n2 1 b\n");
  assert.deepStrictEqual(t.ancestry(1, procs), [1, 2]);
});

test("registry parsing and liveness filter", () => {
  assert.strictEqual(t.parseRegistryEntry("not json"), null);
  assert.strictEqual(t.parseRegistryEntry('{"pid":1}'), null);
  const e = t.parseRegistryEntry('{"pid":5,"sessionId":"s","cwd":"C:\\\\x","entrypoint":"cli","kind":"interactive"}');
  assert.strictEqual(e.entrypoint, "cli");
  const bg = { ...e, pid: 6, kind: "background" };
  assert.deepStrictEqual(t.liveEntries([e, bg], () => true).map((x) => x.pid), [5]);
  assert.deepStrictEqual(t.liveEntries([e], () => false), []);
});
