import * as p from "@clack/prompts";
import { spawnSync } from "node:child_process";
import type { PluginExternalTool } from "./plugins.ts";
import { hasBinary } from "./which.ts";
import { InstallError } from "./errors.ts";

export type Platform = "darwin" | "linux" | "win32";

export function currentPlatform(): Platform {
  if (process.platform === "darwin") return "darwin";
  if (process.platform === "linux") return "linux";
  return "win32";
}

/** Runs a single install command string. Injectable so tests never shell out. */
export type ShellRunner = (cmd: string) => void;

const INSTALL_TIMEOUT_MS = 5 * 60 * 1000; // 5 min — generous for brew install + downloads

/**
 * Run an install command from a plugin manifest.
 *
 * SECURITY NOTES:
 * - The command string comes from the plugin's plugin.json (validated by zod),
 *   NOT from user input. There is no string interpolation.
 * - We use a shell because real-world install commands (curl|bash, brew install
 *   with sudo, etc.) require shell features (pipes, expansion, env vars).
 * - The caller ALWAYS shows the full command and (interactively) requires
 *   confirmation before running it. The user can abort.
 * - If the plugin itself is malicious, this is no worse than `npm install`
 *   on a malicious package: trust boundary is "plugins you choose to add".
 */
export const runShellCommand: ShellRunner = (cmd) => {
  const result = spawnSync(cmd, {
    shell: true,
    stdio: "inherit",
    timeout: INSTALL_TIMEOUT_MS,
  });
  // spawnSync sets result.error with the killed signal when timeout fires
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    throw new InstallError(
      `Install command timed out after ${INSTALL_TIMEOUT_MS / 1000}s. ` +
        `It may be waiting for interactive input (run from a TTY) or hung. ` +
        `Install the tool manually and re-run navori with --skip-install.`,
    );
  }
  if (result.signal) {
    throw new InstallError(`Command killed by signal ${result.signal}`);
  }
  if (result.status !== 0) {
    throw new InstallError(`Command exited with status ${result.status}`);
  }
};

export type InstallStatus = "already-present" | "installed" | "failed" | "no-command" | "skipped";

export interface InstallResult {
  tool: string;
  status: InstallStatus;
  /** The platform install command that was (or would be) run, when one exists. */
  command?: string;
  /** Failure message when status is "failed". */
  error?: string;
}

export interface InstallOptions {
  /** When true, install without an interactive confirm (headless / --yes / --recommended). */
  assumeYes: boolean;
  /** Force a platform (tests). Defaults to the current OS. */
  platform?: string;
  /** Injectable runner (tests). Defaults to the real shell runner. */
  run?: ShellRunner;
}

/**
 * Single install code path shared by `navori add` and `navori global init`.
 *
 * Never throws: every failure mode is returned as an InstallResult status so
 * callers can report it non-fatally. When not `assumeYes`, prompts the user to
 * confirm before running anything.
 */
export async function installExternalTool(
  tool: PluginExternalTool,
  opts: InstallOptions,
): Promise<InstallResult> {
  const run = opts.run ?? runShellCommand;
  const platform = opts.platform ?? currentPlatform();

  // No checkBinary declared ≈ "assume present" (matches historical `add` behavior).
  const present = tool.checkBinary ? hasBinary(tool.checkBinary) : true;
  if (present) return { tool: tool.name, status: "already-present" };

  const installCmd = tool.install?.[platform];
  if (!installCmd) return { tool: tool.name, status: "no-command" };

  if (!opts.assumeYes) {
    const confirmed = await p.confirm({
      message: `Install '${tool.name}'? Will run: ${installCmd}`,
      initialValue: false,
    });
    if (p.isCancel(confirmed) || !confirmed) {
      return { tool: tool.name, status: "skipped", command: installCmd };
    }
  }

  try {
    run(installCmd);
    if (tool.postInstall) run(tool.postInstall);
    return { tool: tool.name, status: "installed", command: installCmd };
  } catch (err) {
    return { tool: tool.name, status: "failed", command: installCmd, error: (err as Error).message };
  }
}
