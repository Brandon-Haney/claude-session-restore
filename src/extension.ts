import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  ancestry,
  listProcesses,
  liveEntries,
  nextSnapshot,
  ownership,
  readLastPrompts,
  readRegistry,
  sessionsToOffer,
  TrackedSession,
} from "./tracker";

const SNAPSHOT_KEY = "claudeRestore.snapshot";
// Sessions offered but not yet answered. Kept separately so a second crash before
// the user answers does not lose them.
const PENDING_KEY = "claudeRestore.pending";
const PROMPT_DELAY_MS = 8000;
const PROCESS_ID_TIMEOUT_MS = 3000;
const TICK_STUCK_MS = 60000;
const CLAUDE_EXTENSION_ID = "anthropic.claude-code";

let log: vscode.OutputChannel;

function config() {
  return vscode.workspace.getConfiguration("claudeRestore");
}

export async function activate(context: vscode.ExtensionContext) {
  log = vscode.window.createOutputChannel("Claude Session Restore");
  context.subscriptions.push(log);
  const state = context.workspaceState;

  const previous = state.get<TrackedSession[]>(SNAPSHOT_KEY, []);
  const pending = state.get<TrackedSession[]>(PENDING_KEY, []);
  const candidates = [...pending, ...previous];
  await state.update(PENDING_KEY, candidates);
  await state.update(SNAPSHOT_KEY, []);
  let lastOffered = candidates;
  log.appendLine(`Activated. ${previous.length} session(s) recorded last run, ${pending.length} unanswered.`);

  const tracker = new WindowTracker(state);
  const interval = Math.max(3, config().get<number>("snapshotIntervalSeconds", 10)) * 1000;
  const timer = setInterval(() => void tracker.tick(), interval);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
  void tracker.tick();

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeRestore.restore", () => offer(lastOffered, state, true)),
    vscode.commands.registerCommand("claudeRestore.showTracked", () => showTracked(state)),
  );

  if (candidates.length === 0) return;
  if (!config().get<boolean>("promptOnStartup", true)) {
    await state.update(PENDING_KEY, []);
    return;
  }
  // Give the Claude Code extension time to bring back its own chat tabs first,
  // so sessions it already restored are running and are not offered again.
  setTimeout(() => void offer(candidates, state, false), PROMPT_DELAY_MS);
}

export function deactivate() {}

function withTimeout<T>(value: Thenable<T>, ms: number): Promise<T | undefined> {
  return Promise.race([Promise.resolve(value), new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);
}

class WindowTracker {
  private chains = new Map<number, number[]>();
  private busySince = 0;
  private lastSummary = "";

  constructor(private state: vscode.Memento) {}

  async tick() {
    // Skip while a snapshot is in progress, but never let a stuck one block tracking for good.
    if (this.busySince && Date.now() - this.busySince < TICK_STUCK_MS) return;
    if (this.busySince) log.appendLine("Previous snapshot never finished; starting a new one.");
    this.busySince = Date.now();
    try {
      const live = liveEntries(readRegistry());
      const missing = live.filter((e) => !this.chains.has(e.pid));
      if (missing.length > 0) {
        // Process ancestry never changes, so the process table is only read when a new session appears.
        const procs = await listProcesses();
        for (const e of missing) {
          if (procs.size > 0) this.chains.set(e.pid, ancestry(e.pid, procs));
        }
      }
      const livePids = new Set(live.map((e) => e.pid));
      for (const pid of this.chains.keys()) if (!livePids.has(pid)) this.chains.delete(pid);

      const terminals = vscode.window.terminals;
      const shellPids = new Map<number, number>();
      await Promise.all(
        terminals.map(async (t, index) => {
          // A terminal that never started (or an extension's pseudo-terminal) can leave
          // processId pending forever; without a timeout that would stall every later snapshot.
          const pid = await withTimeout(t.processId, PROCESS_ID_TIMEOUT_MS);
          if (pid !== undefined) shellPids.set(pid, index);
        }),
      );

      const includePanel = config().get<boolean>("includeChatPanel", true);
      const now = Date.now();
      const current: TrackedSession[] = [];
      for (const entry of live) {
        const chain = this.chains.get(entry.pid);
        if (!chain) continue;
        const owner = ownership(entry, chain, new Set(shellPids.keys()), process.pid);
        if (!owner || (owner.kind === "panel" && !includePanel)) continue;
        current.push({
          sessionId: entry.sessionId,
          cwd: entry.cwd,
          kind: owner.kind,
          name: entry.name,
          order: owner.kind === "terminal" ? shellPids.get(owner.shellPid)! : 1000 + current.length,
          missingTicks: 0,
          lastSeen: now,
        });
      }

      const previous = this.state.get<TrackedSession[]>(SNAPSHOT_KEY, []);
      await this.state.update(SNAPSHOT_KEY, nextSnapshot(previous, current));

      const summary = `Tracking ${current.length} session(s); ${terminals.length} terminal(s), ${shellPids.size} with a shell process.`;
      if (summary !== this.lastSummary) log.appendLine(`${new Date().toLocaleTimeString()} ${summary}`);
      this.lastSummary = summary;
    } catch (err) {
      log.appendLine(`Snapshot failed: ${err}`);
    } finally {
      this.busySince = 0;
    }
  }
}

function liveSessionIds(): Set<string> {
  return new Set(liveEntries(readRegistry()).map((e) => e.sessionId));
}

interface SessionPick extends vscode.QuickPickItem {
  session: TrackedSession;
}

function describe(sessions: TrackedSession[]): SessionPick[] {
  const prompts = readLastPrompts(new Set(sessions.map((s) => s.sessionId)));
  return sessions.map((s) => {
    const prompt = prompts.get(s.sessionId);
    const label = prompt ? (prompt.length > 70 ? `${prompt.slice(0, 69)}…` : prompt) : (s.name ?? s.sessionId.slice(0, 8));
    return {
      label: `${s.kind === "panel" ? "$(comment-discussion)" : "$(terminal)"} ${label}`,
      description: `${path.basename(s.cwd)} · ${s.kind === "panel" ? "chat panel" : "terminal"} · ${ago(s.lastSeen)}`,
      detail: s.cwd,
      picked: true,
      session: s,
    };
  });
}

async function offer(candidates: TrackedSession[], state: vscode.Memento, fromCommand: boolean) {
  const includePanel = config().get<boolean>("includeChatPanel", true);
  const sessions = sessionsToOffer(candidates, liveSessionIds()).filter((s) => includePanel || s.kind === "terminal");
  if (sessions.length === 0) {
    await state.update(PENDING_KEY, []);
    if (fromCommand) vscode.window.showInformationMessage("No Claude sessions from the last run are waiting to be restored.");
    return;
  }

  let chosen: TrackedSession[] | undefined;
  if (fromCommand) {
    chosen = await pick(sessions);
  } else {
    const n = sessions.length;
    const answer = await vscode.window.showInformationMessage(
      `${n} Claude session${n === 1 ? " was" : "s were"} running when this window last closed.`,
      "Restore All",
      "Choose…",
      "Dismiss",
    );
    if (answer === "Restore All") chosen = sessions;
    else if (answer === "Choose…") chosen = await pick(sessions);
    else chosen = [];
  }
  // Escaping the picker keeps the sessions pending; any other answer settles them.
  if (chosen === undefined) return;
  await state.update(PENDING_KEY, []);
  for (const s of chosen) await restore(s);
}

async function pick(sessions: TrackedSession[]): Promise<TrackedSession[] | undefined> {
  const picks = await vscode.window.showQuickPick(describe(sessions), {
    canPickMany: true,
    title: "Claude sessions to restore",
    matchOnDescription: true,
    matchOnDetail: true,
  });
  return picks?.map((p) => p.session);
}

async function restore(s: TrackedSession) {
  if (liveSessionIds().has(s.sessionId)) {
    log.appendLine(`Skipped ${s.sessionId}: already running.`);
    return;
  }
  const cwdExists = fs.existsSync(s.cwd);
  if (!cwdExists) log.appendLine(`Folder ${s.cwd} no longer exists; resuming ${s.sessionId} from the workspace root.`);

  if (s.kind === "panel" && vscode.extensions.getExtension(CLAUDE_EXTENSION_ID)) {
    // Documented route; if the session is already open in a tab, the extension just focuses it.
    const uri = vscode.Uri.parse(`${vscode.env.uriScheme}://${CLAUDE_EXTENSION_ID}/open?session=${encodeURIComponent(s.sessionId)}`);
    await vscode.env.openExternal(uri);
    // Let each tab open before asking for the next one.
    await new Promise((r) => setTimeout(r, 700));
    log.appendLine(`Reopened chat panel session ${s.sessionId}.`);
    return;
  }

  const terminal = vscode.window.createTerminal({
    name: `claude · ${path.basename(s.cwd)}`,
    cwd: cwdExists ? s.cwd : undefined,
  });
  const command = config().get<string>("resumeCommand", "claude --resume ${sessionId}").split("${sessionId}").join(s.sessionId);
  terminal.sendText(command, true);
  terminal.show(true);
  log.appendLine(`Resumed terminal session ${s.sessionId} in ${s.cwd}.`);
}

async function showTracked(state: vscode.Memento) {
  const tracked = state.get<TrackedSession[]>(SNAPSHOT_KEY, []);
  if (tracked.length === 0) {
    vscode.window.showInformationMessage("No Claude sessions are being tracked in this window yet.");
    return;
  }
  await vscode.window.showQuickPick(
    describe(tracked).map((p) => ({ ...p, picked: undefined })),
    { title: `${tracked.length} Claude session(s) tracked in this window` },
  );
}

function ago(timestamp: number): string {
  const minutes = Math.round((Date.now() - timestamp) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}
