import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { safeHomedir } from "../primitives/home.ts";
import {
  createPrivateAuditFile,
  ensurePrivateAuditDirectory,
  readPrivateAuditFile,
  removePrivateAuditFile,
  replacePrivateAuditFile,
} from "./paths.ts";
import { DEFAULT_PORT } from "./collect.ts";

/**
 * The launchd declaration that keeps the OTel receiver up (#697).
 *
 * `--collect` is one process serving every session and every repo, and "one"
 * is not "always up": events emitted while nobody listens are lost, with no
 * retroactive capture. A receiver that dies at 3am — or a machine that
 * rebooted — costs the third source of every session until somebody notices,
 * and what they notice is a report saying "no manual approvals".
 *
 * This does NOT bend invariant 9. A `.plist` is a declaration the operating
 * system reads, exactly like the `settings.json` fragment spec 0021 emits for
 * Claude Code to read, or the hooks navori generates for the host to run.
 * navori declares; launchd executes. The one thing navori still never does is
 * hold the process itself — `collect.test.ts` keeps enforcing that.
 *
 * macOS only, on purpose: it is where the operator runs. `systemd` joins when
 * somebody needs it, and the platform guard is what keeps that gap honest
 * instead of writing a file Linux will silently ignore.
 */

/** The agent's label. Also the file name, and what `launchctl` addresses. */
export const LAUNCH_AGENT_LABEL = "com.navori.audit-collect";

/** Where launchd looks for per-user agents. */
export function launchAgentPath(): string {
  return join(safeHomedir(), "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
}

/**
 * Where the receiver's stdout/stderr land.
 *
 * Under `~/.navori/` and not the audit store: these are the SUPERVISOR's logs
 * — a crash loop, a port already taken — and mixing them into the store would
 * put lines nobody parses next to the session logs that every reader does.
 */
export function collectLogDir(): string {
  return join(safeHomedir(), ".navori", "logs");
}

export function isLaunchdPlatform(): boolean {
  return process.platform === "darwin";
}

/**
 * The exact command launchd will run.
 *
 * `process.argv[1]` is the entry as it was INVOKED — for a global install that
 * is the bin symlink, which survives an upgrade that moves the real file, so
 * it is a better anchor than its `realpath`. `execPath` pins the interpreter
 * because a launchd job inherits almost no environment and certainly not the
 * `PATH` that found `node` here.
 */
export function receiverArgv(): string[] {
  return [process.execPath, process.argv[1] ?? "", "audit", "--collect"];
}

/** XML text escaping. Paths carry `&` more often than anyone expects. */
function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The plist body.
 *
 * `KeepAlive` is the whole point of the issue: launchd brings the receiver
 * back when it dies, which is the failure this file exists to remove.
 * `RunAtLoad` covers the other half — the machine that rebooted.
 */
export function buildLaunchAgent(argv: string[], logDir: string): string {
  const args = argv.map((a) => `    <string>${xml(a)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(join(logDir, "collect.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(logDir, "collect.err.log"))}</string>
</dict>
</plist>
`;
}

/** `gui/<uid>`, the domain a per-user agent is bootstrapped into. */
function guiDomain(): string {
  return `gui/${process.getuid?.() ?? 0}`;
}

function launchctl(args: string[]): { ok: boolean; message: string } {
  const result = spawnSync("launchctl", args, { encoding: "utf-8" });
  if (result.error) return { ok: false, message: result.error.message };
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return { ok: result.status === 0, message: output };
}

type Launchctl = typeof launchctl;

/** A missing service is the only print failure that proves the label is absent. */
function agentStatus(controller: Launchctl): { loaded: boolean; error?: string } {
  const result = controller(["print", `${guiDomain()}/${LAUNCH_AGENT_LABEL}`]);
  if (result.ok) return { loaded: true };
  if (/could not find service|service not found|no such process/i.test(result.message)) {
    return { loaded: false };
  }
  return { loaded: false, error: `launchctl print failed: ${result.message || "unknown error"}` };
}

/** Whether launchd currently has the agent in the user's domain. */
export function launchAgentLoaded(): boolean {
  if (!isLaunchdPlatform()) return false;
  return launchctl(["print", `${guiDomain()}/${LAUNCH_AGENT_LABEL}`]).ok;
}

export interface InstallResult {
  plistPath: string;
  argv: string[];
  port: number;
  /** True only when launchd confirms the agent is loaded after bootstrap. */
  loaded: boolean;
  /** Why query, unload, or bootstrap failed. Empty on success. */
  message: string;
  /** True when a plist was already there; on failure it may be preserved unchanged. */
  replaced: boolean;
}

/**
 * Writes the plist and bootstraps it.
 *
 * Bootstrapping an already-loaded label fails, so an existing agent is booted
 * out FIRST: a reinstall after an upgrade is the common case, and the whole
 * reason to reinstall is to point launchd at the new command.
 */
export function installLaunchAgent(controller: Launchctl = launchctl): InstallResult {
  const plistPath = launchAgentPath();
  const argv = receiverArgv();
  const replaced = existsSync(plistPath);
  const failure = (message: string): InstallResult => ({
    plistPath,
    argv,
    port: DEFAULT_PORT,
    loaded: false,
    message,
    replaced,
  });

  const before = agentStatus(controller);
  if (before.error) return failure(before.error);
  if (before.loaded) {
    const bootout = controller(["bootout", `${guiDomain()}/${LAUNCH_AGENT_LABEL}`]);
    if (!bootout.ok)
      return failure(`launchctl bootout failed: ${bootout.message || "unknown error"}`);
    const after = agentStatus(controller);
    if (after.error) return failure(after.error);
    if (after.loaded) return failure("launchctl bootout did not unload the agent");
  }

  const logDir = collectLogDir();
  const directory = ensurePrivateAuditDirectory(logDir, { ownedRoot: logDir });
  if (!directory.ok) return failure(`Collector storage refused: ${directory.reason}.`);
  for (const name of ["collect.out.log", "collect.err.log"]) {
    const path = join(logDir, name);
    const result = existsSync(path)
      ? readPrivateAuditFile(path, { ownedRoot: logDir })
      : createPrivateAuditFile(path, "", { ownedRoot: logDir });
    if (!result.ok) return failure(`Collector storage refused: ${result.reason}.`);
  }
  const plist = replacePrivateAuditFile(plistPath, buildLaunchAgent(argv, logDir), {
    ownedRoot: null,
  });
  if (!plist.ok) return failure(`Launch agent storage refused: ${plist.reason}.`);

  const boot = controller(["bootstrap", guiDomain(), plistPath]);
  const loaded = boot.ok ? agentStatus(controller) : null;
  return {
    plistPath,
    argv,
    port: DEFAULT_PORT,
    loaded: loaded?.loaded === true,
    message: !boot.ok
      ? boot.message
      : (loaded?.error ?? (loaded?.loaded ? "" : "launchctl bootstrap did not load the agent")),
    replaced,
  };
}

export interface UninstallResult {
  plistPath: string;
  /** The file was there and is gone. */
  removed: boolean;
  /** launchd had it loaded and no longer does. */
  unloaded: boolean;
  /** A query or unload failure; declaration is preserved when present. */
  error?: string;
}

/** Unload and verify absence before deleting the declaration. */
export function uninstallLaunchAgent(controller: Launchctl = launchctl): UninstallResult {
  const plistPath = launchAgentPath();
  const removed = existsSync(plistPath);
  const before = agentStatus(controller);
  if (before.error) return { plistPath, removed: false, unloaded: false, error: before.error };
  if (before.loaded) {
    const bootout = controller(["bootout", `${guiDomain()}/${LAUNCH_AGENT_LABEL}`]);
    if (!bootout.ok) {
      return {
        plistPath,
        removed: false,
        unloaded: false,
        error: `launchctl bootout failed: ${bootout.message || "unknown error"}`,
      };
    }
    const after = agentStatus(controller);
    if (after.error) return { plistPath, removed: false, unloaded: false, error: after.error };
    if (after.loaded)
      return {
        plistPath,
        removed: false,
        unloaded: false,
        error: "launchctl bootout did not unload the agent",
      };
  }
  // `force` so a plist removed by hand between the check and here is not an
  // error: the end state the caller asked for is "not installed".
  if (removed) {
    const result = removePrivateAuditFile(plistPath, { ownedRoot: null });
    if (!result.ok && result.reason !== "missing")
      return {
        plistPath,
        removed: false,
        unloaded: before.loaded,
        error: `Launch agent storage refused: ${result.reason}.`,
      };
  }
  return { plistPath, removed, unloaded: before.loaded };
}

/**
 * What the plist on disk actually runs, or null when there is none.
 *
 * Read back rather than recomputed: the question `doctor` answers is whether
 * the INSTALLED agent still points at a navori that exists, and a value
 * derived from the current process would always agree with itself.
 */
export function installedArgv(): string[] | null {
  const plistPath = launchAgentPath();
  if (!existsSync(plistPath)) return null;
  let raw: string;
  try {
    const result = readPrivateAuditFile(plistPath, { ownedRoot: null, privateFile: false });
    if (!result.ok) return null;
    raw = result.value.toString("utf-8");
  } catch {
    return null;
  }
  const array = raw.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (!array?.[1]) return null;
  return [...array[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) =>
    (m[1] ?? "").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&"),
  );
}
