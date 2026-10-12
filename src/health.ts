// Compatibility checks against Claude Code's undocumented session registry, and the
// shared health file that alerts both VS Code and new Claude Code sessions.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseRegistryEntry, PANEL_ENTRYPOINT, ProcInfo, ancestry } from "./tracker";

export type Severity = "error" | "info";

export interface HealthIssue {
  code: string;
  severity: Severity;
  message: string;
  /** Claude Code version in use when the issue was seen, if known. */
  claudeVersion?: string;
  firstSeen: number;
  lastSeen: number;
  /** Persistent checks keep refreshing this while the problem lasts; one-off events expire on their own. */
  expiresAt: number;
}

export interface HealthFile {
  extensionVersion: string;
  updatedAt: number;
  issues: HealthIssue[];
}

export interface RegistryScan {
  dirExists: boolean;
  files: number;
  /** Files whose JSON no longer has the fields the extension relies on (pid, sessionId, cwd). */
  invalid: string[];
  kinds: Set<string>;
  entrypoints: Set<string>;
  versions: Set<string>;
  pids: Set<number>;
}

/** Values seen in Claude Code 2.1.x. Anything else is logged so changes are noticed early. */
export const KNOWN_KINDS = new Set(["interactive", "background"]);
export const KNOWN_ENTRYPOINTS = new Set(["cli", PANEL_ENTRYPOINT, "sdk-ts", "sdk-py", "sdk-cli"]);

export const PERSISTENT_ISSUE_TTL_MS = 60 * 60 * 1000;
export const EVENT_ISSUE_TTL_MS = 3 * 24 * 60 * 60 * 1000;

export function healthFilePath(): string {
  return path.join(os.homedir(), ".claude-session-restore", "health.json");
}

export function scanRegistry(claudeDir: string): RegistryScan {
  const scan: RegistryScan = {
    dirExists: false,
    files: 0,
    invalid: [],
    kinds: new Set(),
    entrypoints: new Set(),
    versions: new Set(),
    pids: new Set(),
  };
  const dir = path.join(claudeDir, "sessions");
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    scan.dirExists = true;
  } catch {
    return scan;
  }
  for (const name of names) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, name), "utf8");
    } catch {
      continue; // removed while reading: that session just exited
    }
    scan.files++;
    const entry = parseRegistryEntry(text);
    if (!entry) {
      // A file caught mid-write is retried on the next check, so only flag files that parse as JSON.
      try {
        JSON.parse(text);
        scan.invalid.push(name);
      } catch {}
      continue;
    }
    scan.pids.add(entry.pid);
    if (entry.kind) scan.kinds.add(entry.kind);
    if (entry.entrypoint) scan.entrypoints.add(entry.entrypoint);
    try {
      const v = JSON.parse(text).version;
      if (typeof v === "string") scan.versions.add(v);
    } catch {}
  }
  return scan;
}

const CLAUDE_PROCESS = /^claude(\.exe)?$/i;

/**
 * Top-level Claude Code processes started from this window's terminals. A claude
 * process launched by another claude process (e.g. `claude -p` run as a tool) is skipped.
 */
export function claudeProcessesUnderShells(procs: Map<number, ProcInfo>, shellPids: Set<number>): number[] {
  const found: number[] = [];
  for (const [pid, info] of procs) {
    if (!CLAUDE_PROCESS.test(info.name)) continue;
    const chain = ancestry(pid, procs).slice(1);
    if (chain.some((p) => CLAUDE_PROCESS.test(procs.get(p)?.name ?? ""))) continue;
    if (chain.some((p) => shellPids.has(p))) found.push(pid);
  }
  return found;
}

/**
 * Problems that make restore silently stop working. `untrackedClaudePids` are claude
 * processes running in this window's terminals that the tracker is not recording,
 * after they have stayed that way for several checks.
 */
export function registryProblems(scan: RegistryScan, untrackedClaudePids: number[]): { code: string; message: string }[] {
  const problems: { code: string; message: string }[] = [];
  const unregistered = untrackedClaudePids.filter((p) => !scan.pids.has(p));
  const unrecognised = untrackedClaudePids.filter((p) => scan.pids.has(p));
  if (!scan.dirExists && unregistered.length > 0) {
    problems.push({
      code: "registry-dir-missing",
      message:
        "Claude Code is running in this window's terminals but ~/.claude/sessions/ does not exist. Claude Code may have moved or removed its running-session registry, so no session can be restored.",
    });
  } else if (unregistered.length > 0) {
    problems.push({
      code: "registry-missing-sessions",
      message: `Claude Code is running in ${unregistered.length} terminal(s) of this window with no entry in ~/.claude/sessions/. Claude Code may have changed how or where it records running sessions, so those sessions cannot be restored.`,
    });
  }
  if (unrecognised.length > 0) {
    problems.push({
      code: "registry-sessions-unrecognised",
      message: `${unrecognised.length} Claude Code session(s) in this window's terminals have an entry in ~/.claude/sessions/ that the extension does not recognise as an interactive terminal session (the "kind" or "entrypoint" values may have changed), so they are not being recorded.`,
    });
  }
  if (scan.invalid.length > 0) {
    problems.push({
      code: "registry-format-changed",
      message: `${scan.invalid.length} file(s) in ~/.claude/sessions/ no longer have the pid, sessionId and cwd fields this extension reads (e.g. ${scan.invalid[0]}). Claude Code has likely changed the file format.`,
    });
  }
  return problems;
}

/** Values the extension has not seen before; worth a log line, not an alert. */
export function registryNotices(scan: RegistryScan): string[] {
  const notices: string[] = [];
  for (const k of scan.kinds) if (!KNOWN_KINDS.has(k)) notices.push(`New session kind "${k}" in ~/.claude/sessions/ (only "interactive" sessions are restored).`);
  for (const e of scan.entrypoints) if (!KNOWN_ENTRYPOINTS.has(e)) notices.push(`New entrypoint "${e}" in ~/.claude/sessions/; chat panel sessions are recognised by "${PANEL_ENTRYPOINT}".`);
  return notices;
}

export function readHealth(file = healthFilePath()): HealthFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && Array.isArray(parsed.issues) ? parsed : null;
  } catch {
    return null;
  }
}

/** Adds or refreshes issues and drops expired ones. Several windows share the file, so issues are only ever refreshed, never cleared by another window. */
export function mergeHealth(
  current: HealthFile | null,
  reported: { code: string; severity: Severity; message: string; ttlMs: number; claudeVersion?: string }[],
  extensionVersion: string,
  now = Date.now(),
): HealthFile {
  const issues = new Map<string, HealthIssue>();
  for (const i of current?.issues ?? []) if (i.expiresAt > now) issues.set(i.code, i);
  for (const r of reported) {
    const prev = issues.get(r.code);
    issues.set(r.code, {
      code: r.code,
      severity: r.severity,
      message: r.message,
      claudeVersion: r.claudeVersion ?? prev?.claudeVersion,
      firstSeen: prev?.firstSeen ?? now,
      lastSeen: now,
      expiresAt: Math.max(prev?.expiresAt ?? 0, now + r.ttlMs),
    });
  }
  return { extensionVersion, updatedAt: now, issues: [...issues.values()] };
}

export function writeHealth(health: HealthFile, file = healthFilePath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(health, null, 2), "utf8");
  fs.renameSync(tmp, file);
}
