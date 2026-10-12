// Pure logic with no VS Code dependency, so it can be unit tested with plain node.
import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** One file in ~/.claude/sessions/<pid>.json, written by every running Claude Code process. */
export interface RegistryEntry {
  pid: number;
  sessionId: string;
  cwd: string;
  name?: string;
  entrypoint?: string;
  kind?: string;
}

export type SessionKind = "terminal" | "panel";

export interface TrackedSession {
  sessionId: string;
  cwd: string;
  kind: SessionKind;
  name?: string;
  /** Position among this window's terminals (panel sessions sort after them). */
  order: number;
  /** Consecutive snapshots in which the session was not running. */
  missingTicks: number;
  lastSeen: number;
}

export interface ProcInfo {
  ppid: number;
  name: string;
}

/** The chat panel launches Claude Code with CLAUDE_CODE_ENTRYPOINT=claude-vscode. */
export const PANEL_ENTRYPOINT = "claude-vscode";

/**
 * A session that stops running is dropped only after this many snapshots, so a
 * window that is shutting down (and killing its terminals) between two
 * snapshots cannot wipe the list it should be restoring next time.
 */
export const DROP_AFTER_MISSING_TICKS = 2;

export function claudeDir(env: NodeJS.ProcessEnv = process.env): string {
  const custom = env.CLAUDE_CONFIG_DIR?.trim();
  return custom ? custom : path.join(os.homedir(), ".claude");
}

export function parseRegistryEntry(text: string): RegistryEntry | null {
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw.pid !== "number" || typeof raw.sessionId !== "string" || typeof raw.cwd !== "string") {
    return null;
  }
  return {
    pid: raw.pid,
    sessionId: raw.sessionId,
    cwd: raw.cwd,
    name: typeof raw.name === "string" ? raw.name : undefined,
    entrypoint: typeof raw.entrypoint === "string" ? raw.entrypoint : undefined,
    kind: typeof raw.kind === "string" ? raw.kind : undefined,
  };
}

export function readRegistry(dir: string = claudeDir()): RegistryEntry[] {
  const sessionsDir = path.join(dir, "sessions");
  let files: string[];
  try {
    files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const entries: RegistryEntry[] = [];
  for (const file of files) {
    try {
      const entry = parseRegistryEntry(fs.readFileSync(path.join(sessionsDir, file), "utf8"));
      if (entry) entries.push(entry);
    } catch {
      // File removed between readdir and read: the session just exited.
    }
  }
  return entries;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

/** Registry entries whose process is still running (a crash leaves stale files behind). */
export function liveEntries(entries: RegistryEntry[], alive: (pid: number) => boolean = isAlive): RegistryEntry[] {
  return entries.filter((e) => (e.kind === undefined || e.kind === "interactive") && alive(e.pid));
}

export function parseProcessTable(text: string): Map<number, ProcInfo> {
  const procs = new Map<number, ProcInfo>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s*(.*)$/.exec(line);
    if (m) procs.set(Number(m[1]), { ppid: Number(m[2]), name: m[3].trim() });
  }
  return procs;
}

export function listProcesses(): Promise<Map<number, ProcInfo>> {
  const [cmd, args] =
    process.platform === "win32"
      ? [
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.Name)" }',
          ],
        ]
      : ["ps", ["-A", "-o", "pid=,ppid=,comm="]];
  return new Promise((resolve) => {
    execFile(cmd, args as string[], { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 15000 }, (err, stdout) => {
      resolve(err ? new Map() : parseProcessTable(stdout));
    });
  });
}

/** The pid itself followed by its parent, grandparent, ... */
export function ancestry(pid: number, procs: Map<number, ProcInfo>, maxDepth = 20): number[] {
  const chain = [pid];
  let current = pid;
  for (let i = 0; i < maxDepth; i++) {
    const info = procs.get(current);
    if (!info || info.ppid === 0 || info.ppid === current || chain.includes(info.ppid)) break;
    chain.push(info.ppid);
    current = info.ppid;
  }
  return chain;
}

export type Ownership = { kind: "terminal"; shellPid: number } | { kind: "panel" } | null;

/**
 * Decides whether a running session belongs to this window: a terminal session
 * descends from one of this window's terminal shells, a chat panel session
 * descends from this window's extension host.
 */
export function ownership(
  entry: RegistryEntry,
  chain: number[],
  shellPids: Set<number>,
  extensionHostPid: number,
): Ownership {
  if (entry.entrypoint === PANEL_ENTRYPOINT) {
    return chain.includes(extensionHostPid) ? { kind: "panel" } : null;
  }
  const shell = chain.find((pid) => shellPids.has(pid));
  return shell !== undefined ? { kind: "terminal", shellPid: shell } : null;
}

/** Replaces the snapshot with what is running now, keeping recently vanished sessions for a grace period. */
export function nextSnapshot(
  previous: TrackedSession[],
  current: TrackedSession[],
  dropAfter = DROP_AFTER_MISSING_TICKS,
): TrackedSession[] {
  const next = new Map<string, TrackedSession>();
  for (const s of current) next.set(s.sessionId, { ...s, missingTicks: 0 });
  for (const s of previous) {
    if (next.has(s.sessionId)) continue;
    const missingTicks = s.missingTicks + 1;
    if (missingTicks < dropAfter) next.set(s.sessionId, { ...s, missingTicks });
  }
  return [...next.values()].sort((a, b) => a.order - b.order);
}

/** Sessions to offer after a restart: recorded last time, and not running now. */
export function sessionsToOffer(candidates: TrackedSession[], liveIds: Set<string>): TrackedSession[] {
  const seen = new Set<string>();
  return candidates.filter((s) => {
    if (liveIds.has(s.sessionId) || seen.has(s.sessionId)) return false;
    seen.add(s.sessionId);
    return true;
  });
}

/** The last prompt typed into each session, read from ~/.claude/history.jsonl, for readable labels. */
export function readLastPrompts(ids: Set<string>, dir: string = claudeDir()): Map<string, string> {
  const prompts = new Map<string, string>();
  if (ids.size === 0) return prompts;
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, "history.jsonl"), "utf8");
  } catch {
    return prompts;
  }
  for (const line of text.split("\n")) {
    if (!line.includes('"sessionId"')) continue;
    try {
      const row = JSON.parse(line);
      if (ids.has(row.sessionId) && typeof row.display === "string" && row.display.trim()) {
        prompts.set(row.sessionId, row.display.trim().replace(/\s+/g, " "));
      }
    } catch {
      continue;
    }
  }
  return prompts;
}
