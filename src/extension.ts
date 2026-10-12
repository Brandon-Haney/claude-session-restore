import * as fs from "fs";
import * as os from "os";
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
  claudeDir,
  sessionsToOffer,
  TrackedSession,
} from "./tracker";
import {
  claudeProcessesUnderShells,
  EVENT_ISSUE_TTL_MS,
  mergeHealth,
  PERSISTENT_ISSUE_TTL_MS,
  readHealth,
  registryNotices,
  registryProblems,
  scanRegistry,
  Severity,
  writeHealth,
} from "./health";

const SNAPSHOT_KEY = "claudeRestore.snapshot";
// Sessions offered but not yet answered. Kept separately so a second crash before
// the user answers does not lose them.
const PENDING_KEY = "claudeRestore.pending";
const PROMPT_DELAY_MS = 8000;
const PROCESS_ID_TIMEOUT_MS = 3000;
const TICK_STUCK_MS = 60000;
const CLAUDE_EXTENSION_ID = "anthropic.claude-code";
const HEALTH_INTERVAL_MS = 60000;
// A claude process must stay untracked this many checks (a few minutes) before it
// counts, so a session that has only just started is never reported.
const UNTRACKED_CHECKS_BEFORE_ALERT = 3;
const RESUME_VERIFY_DELAY_MS = 60000;
const ALERTED_KEY = "claudeRestore.alerted";
const ALERT_REPEAT_MS = 24 * 60 * 60 * 1000;

let log: vscode.OutputChannel;
let health: HealthMonitor;

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

  health = new HealthMonitor(context, tracker);
  const healthTimer = setInterval(() => void health.check(), HEALTH_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(healthTimer) });

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeRestore.restore", () => offer(lastOffered, state, true)),
    vscode.commands.registerCommand("claudeRestore.showTracked", () => showTracked(state)),
    vscode.commands.registerCommand("claudeRestore.checkHealth", () => health.check(true)),
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

/** This window's terminal shell pids, mapped to the terminal's position. */
async function windowShellPids(): Promise<Map<number, number>> {
  const shellPids = new Map<number, number>();
  await Promise.all(
    vscode.window.terminals.map(async (t, index) => {
      // A terminal that never started (or an extension's pseudo-terminal) can leave
      // processId pending forever; without a timeout that would stall every later snapshot.
      const pid = await withTimeout(t.processId, PROCESS_ID_TIMEOUT_MS);
      if (pid !== undefined) shellPids.set(pid, index);
    }),
  );
  return shellPids;
}

function withTimeout<T>(value: Thenable<T>, ms: number): Promise<T | undefined> {
  return Promise.race([Promise.resolve(value), new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);
}

class WindowTracker {
  private chains = new Map<number, number[]>();
  private busySince = 0;
  private lastSummary = "";
  /** Claude processes recorded by the last snapshot. */
  trackedPids = new Set<number>();

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
      const shellPids = await windowShellPids();

      const includePanel = config().get<boolean>("includeChatPanel", true);
      const now = Date.now();
      const current: TrackedSession[] = [];
      const tracked = new Set<number>();
      for (const entry of live) {
        const chain = this.chains.get(entry.pid);
        if (!chain) continue;
        const owner = ownership(entry, chain, new Set(shellPids.keys()), process.pid);
        if (!owner || (owner.kind === "panel" && !includePanel)) continue;
        tracked.add(entry.pid);
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
      this.trackedPids = tracked;

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
  setTimeout(() => {
    // Closed by the user in the meantime, or resumed fine: nothing to report.
    if (terminal.exitStatus !== undefined || liveSessionIds().has(s.sessionId)) return;
    health.report(
      "resume-not-running",
      "error",
      `A restored terminal session (${s.sessionId}) was not running ${RESUME_VERIFY_DELAY_MS / 1000}s after "${command}" was sent. The resume command may have changed, the transcript may have been deleted, or Claude Code may no longer record resumed sessions in ~/.claude/sessions/. Check the restored terminal for an error.`,
      EVENT_ISSUE_TTL_MS,
    );
  }, RESUME_VERIFY_DELAY_MS);
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

/**
 * Watches for signs that Claude Code changed the undocumented files this extension
 * relies on. Problems go to the output log, a VS Code warning, and a shared health
 * file that a Claude Code SessionStart hook reads to tell new sessions about it.
 */
class HealthMonitor {
  private untrackedChecks = new Map<number, number>();
  private noticesLogged = new Set<string>();
  private busy = false;
  private extensionVersion: string;

  constructor(private context: vscode.ExtensionContext, private tracker: WindowTracker) {
    this.extensionVersion = context.extension.packageJSON.version ?? "unknown";
  }

  async check(fromCommand = false) {
    if (this.busy) return;
    this.busy = true;
    try {
      const scan = scanRegistry(claudeDir());
      const claudeVersion = [...scan.versions].sort().pop();
      this.noteClaudeVersion(claudeVersion);
      for (const notice of registryNotices(scan)) {
        if (this.noticesLogged.has(notice)) continue;
        this.noticesLogged.add(notice);
        log.appendLine(`Notice: ${notice}`);
      }

      const shellPids = new Set((await windowShellPids()).keys());
      const procs = shellPids.size > 0 ? await listProcesses() : new Map();
      const untracked = claudeProcessesUnderShells(procs, shellPids).filter((pid) => !this.tracker.trackedPids.has(pid));
      const counts = new Map<number, number>();
      for (const pid of untracked) counts.set(pid, (this.untrackedChecks.get(pid) ?? 0) + 1);
      this.untrackedChecks = counts;
      const persistent = [...counts].filter(([, n]) => n >= UNTRACKED_CHECKS_BEFORE_ALERT).map(([pid]) => pid);

      const problems = registryProblems(scan, persistent);
      for (const p of problems) this.report(p.code, "error", p.message, PERSISTENT_ISSUE_TTL_MS, claudeVersion);
      if (problems.length === 0) this.report(null, "info", "", 0, claudeVersion);

      if (fromCommand) {
        const active = readHealth()?.issues.filter((i) => i.severity === "error" && i.expiresAt > Date.now()) ?? [];
        if (active.length === 0) {
          vscode.window.showInformationMessage(
            `Claude Session Restore: no compatibility problems found (Claude Code ${claudeVersion ?? "version unknown"}, tracking ${this.tracker.trackedPids.size} session(s) in this window).`,
          );
        } else {
          log.show(true);
          vscode.window.showWarningMessage(`Claude Session Restore: ${active.length} compatibility problem(s); details are in the output log.`);
          for (const i of active) log.appendLine(`Problem [${i.code}]: ${i.message}`);
        }
      }
    } catch (err) {
      log.appendLine(`Health check failed: ${err}`);
    } finally {
      this.busy = false;
    }
  }

  /** Records a problem in the shared health file and alerts once a day per problem. Pass a null code to just refresh the file. */
  report(code: string | null, severity: Severity, message: string, ttlMs: number, claudeVersion?: string) {
    try {
      const reported = code ? [{ code, severity, message, ttlMs, claudeVersion }] : [];
      writeHealth(mergeHealth(readHealth(), reported, this.extensionVersion));
    } catch (err) {
      log.appendLine(`Could not write the health file: ${err}`);
    }
    if (!code || severity !== "error") return;
    log.appendLine(`${new Date().toLocaleTimeString()} Problem [${code}]: ${message}`);
    const alerted = this.context.globalState.get<Record<string, number>>(ALERTED_KEY, {});
    if (Date.now() - (alerted[code] ?? 0) < ALERT_REPEAT_MS) return;
    void this.context.globalState.update(ALERTED_KEY, { ...alerted, [code]: Date.now() });
    void vscode.window
      .showWarningMessage(`Claude Session Restore may not work with this Claude Code version: ${message}`, "Show Log", "Investigate with Claude")
      .then((answer) => {
        if (answer === "Show Log") log.show(true);
        if (answer === "Investigate with Claude") investigate();
      });
  }

  private noteClaudeVersion(version: string | undefined) {
    if (!version) return;
    const key = "claudeRestore.lastClaudeVersion";
    const last = this.context.globalState.get<string>(key);
    if (last === version) return;
    void this.context.globalState.update(key, version);
    if (last) log.appendLine(`Claude Code updated from ${last} to ${version}; compatibility checks will flag anything that changed.`);
  }
}

/** Opens Claude Code in the extension's source folder; the SessionStart hook hands it the problem details. */
function investigate() {
  const configured = config().get<string>("sourceFolder", "").trim().replace(/^~(?=$|[\\/])/, os.homedir());
  const folder = configured && fs.existsSync(configured) ? configured : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const terminal = vscode.window.createTerminal({ name: "claude · investigate", cwd: folder });
  terminal.sendText("claude", true);
  terminal.show();
}
