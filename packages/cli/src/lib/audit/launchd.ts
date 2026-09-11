import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { safeHomedir } from "../home.ts";
import { DEFAULT_PORT, SERVICE_ID } from "./collect.ts";

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

/** Whether launchd currently has the agent in the user's domain. */
export function launchAgentLoaded(): boolean {
  if (!isLaunchdPlatform()) return false;
  return launchctl(["print", `${guiDomain()}/${LAUNCH_AGENT_LABEL}`]).ok;
}

export interface InstallResult {
  plistPath: string;
  argv: string[];
  port: number;
  /** False when the file was written but `launchctl` refused to bootstrap it. */
  loaded: boolean;
  /** `launchctl`'s own words when it refused. Empty when it did not. */
  message: string;
  /** True when a plist was already there and got replaced. */
  replaced: boolean;
}

/**
 * Writes the plist and bootstraps it.
 *
 * Bootstrapping an already-loaded label fails, so an existing agent is booted
 * out FIRST: a reinstall after an upgrade is the common case, and the whole
 * reason to reinstall is to point launchd at the new command.
 */
export function installLaunchAgent(): InstallResult {
  const plistPath = launchAgentPath();
  const argv = receiverArgv();
  const replaced = existsSync(plistPath);

  if (replaced) launchctl(["bootout", `${guiDomain()}/${LAUNCH_AGENT_LABEL}`]);

  mkdirSync(dirname(plistPath), { recursive: true });
  mkdirSync(collectLogDir(), { recursive: true });
  writeFileSync(plistPath, buildLaunchAgent(argv, collectLogDir()), "utf-8");

  const boot = launchctl(["bootstrap", guiDomain(), plistPath]);
  return {
    plistPath,
    argv,
    port: DEFAULT_PORT,
    loaded: boot.ok,
    message: boot.ok ? "" : boot.message,
    replaced,
  };
}

export interface UninstallResult {
  plistPath: string;
  /** The file was there and is gone. */
  removed: boolean;
  /** launchd had it loaded and no longer does. */
  unloaded: boolean;
}

export function uninstallLaunchAgent(): UninstallResult {
  const plistPath = launchAgentPath();
  const unloaded = launchAgentLoaded()
    ? launchctl(["bootout", `${guiDomain()}/${LAUNCH_AGENT_LABEL}`]).ok
    : false;
  const removed = existsSync(plistPath);
  // `force` so a plist removed by hand between the check and here is not an
  // error: the end state the caller asked for is "not installed".
  if (removed) rmSync(plistPath, { force: true });
  return { plistPath, removed, unloaded };
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
    raw = readFileSync(plistPath, "utf-8");
  } catch {
    return null;
  }
  const array = raw.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (!array?.[1]) return null;
  return [...array[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) =>
    (m[1] ?? "").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&"),
  );
}

/**
 * Asks the receiver itself whether it is alive.
 *
 * This is the check that catches the ugly case the issue names — loaded but
 * dead — and the reason `collect.ts` answers a health route at all: a bare
 * connection proves only that SOMETHING holds the port, and the operator's own
 * OTel collector on 4318 would pass that test while dropping every event.
 */
export async function probeReceiver(port = DEFAULT_PORT): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return false;
    const body: unknown = await res.json();
    return (
      typeof body === "object" &&
      body !== null &&
      (body as { service?: unknown }).service === SERVICE_ID
    );
  } catch {
    return false;
  }
}
