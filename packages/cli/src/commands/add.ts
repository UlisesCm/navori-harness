import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { writeConfig, readConfig } from "../lib/config.ts";
import {
  loadPlugin,
  PluginNotFoundError,
  PluginManifestError,
  listKnownPluginIds,
} from "../lib/plugins.ts";
import { hasBinary } from "../lib/which.ts";

type Platform = "darwin" | "linux" | "win32";

function currentPlatform(): Platform {
  if (process.platform === "darwin") return "darwin";
  if (process.platform === "linux") return "linux";
  return "win32";
}

/**
 * Run an install command from a plugin manifest.
 *
 * SECURITY NOTES:
 * - The command string comes from the plugin's plugin.json (validated by zod),
 *   NOT from user input. There is no string interpolation.
 * - We use a shell because real-world install commands (curl|bash, brew install
 *   with sudo, etc.) require shell features (pipes, expansion, env vars).
 * - We ALWAYS show the full command to the user and require confirmation
 *   before running it. The user can abort.
 * - If the plugin itself is malicious, this is no worse than `npm install`
 *   on a malicious package: trust boundary is "plugins you choose to add".
 */
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000; // 5 min — generous for brew install + downloads

function runShellCommand(cmd: string): void {
  const result = spawnSync(cmd, {
    shell: true,
    stdio: "inherit",
    timeout: INSTALL_TIMEOUT_MS,
  });
  // spawnSync sets result.error with the killed signal when timeout fires
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    throw new Error(
      `Install command timed out after ${INSTALL_TIMEOUT_MS / 1000}s. ` +
        `It may be waiting for interactive input (run from a TTY) or hung. ` +
        `Install the tool manually and re-run navori-ai with --skip-install.`,
    );
  }
  if (result.signal) {
    throw new Error(`Command killed by signal ${result.signal}`);
  }
  if (result.status !== 0) {
    throw new Error(`Command exited with status ${result.status}`);
  }
}

export const addCommand = defineCommand({
  meta: {
    name: "add",
    description: "Register a plugin in navori.config.json and optionally install its external tool",
  },
  args: {
    plugin: {
      type: "positional",
      description: "Plugin id to add (e.g. engram)",
      required: true,
    },
    cwd: {
      type: "string",
      description: "Directory containing navori.config.json (default: cwd)",
    },
    yes: {
      type: "boolean",
      description: "Skip prompts, install external tool if needed",
    },
    "skip-install": {
      type: "boolean",
      description: "Do not install external tool (register plugin only)",
    },
  },
  async run({ args }) {
    const cwd = resolve(args.cwd ?? process.cwd());
    const configPath = `${cwd}/navori.config.json`;

    p.intro(`navori-ai add ${args.plugin}`);

    if (!existsSync(cwd)) {
      p.cancel(`Directory not found: ${cwd}`);
      process.exit(1);
    }

    if (!existsSync(configPath)) {
      p.cancel(`No navori.config.json at ${configPath}. Run 'navori-ai init' first.`);
      process.exit(1);
    }

    let plugin;
    try {
      plugin = loadPlugin(args.plugin);
    } catch (err) {
      if (err instanceof PluginNotFoundError) {
        p.cancel(`Unknown plugin '${args.plugin}'. Known: ${listKnownPluginIds().join(", ") || "(none)"}`);
        process.exit(1);
      }
      if (err instanceof PluginManifestError) {
        p.cancel(err.message);
        process.exit(1);
      }
      throw err;
    }

    p.log.info(`${plugin.manifest.name} v${plugin.manifest.version}`);
    p.log.message(plugin.manifest.description);

    const config = readConfig(configPath);
    const already = config.plugins?.[plugin.manifest.id]?.enabled === true;

    if (already) {
      p.log.warn(`'${plugin.manifest.id}' is already enabled in this config`);
    } else {
      // Update config — preserve existing values
      const updatedPlugins = {
        ...(config.plugins ?? {}),
        [plugin.manifest.id]: { enabled: true },
      };
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      writeConfig(configPath, { ...raw, plugins: updatedPlugins });
      p.log.success(`Added '${plugin.manifest.id}' to ${configPath}`);
    }

    // Handle external tool
    const tool = plugin.manifest.externalTool;
    if (!tool) {
      p.outro("Done — run 'navori-ai render' to apply");
      return;
    }

    const installed = tool.checkBinary ? hasBinary(tool.checkBinary) : true;
    if (installed) {
      p.log.success(`External tool '${tool.name}' is already installed`);
      p.outro("Done — run 'navori-ai render' to apply");
      return;
    }

    if (args["skip-install"]) {
      p.log.warn(`External tool '${tool.name}' is not installed. Skip-install requested.`);
      p.outro("Done — install manually later");
      return;
    }

    const platform = currentPlatform();
    const installCmd = tool.install?.[platform];
    if (!installCmd) {
      p.log.warn(`No install command for platform '${platform}'. Install '${tool.name}' manually.`);
      p.outro("Done");
      return;
    }

    const shouldInstall = args.yes
      ? true
      : await p.confirm({
          message: `Install '${tool.name}'? Will run: ${installCmd}`,
          initialValue: false,
        });

    if (p.isCancel(shouldInstall) || !shouldInstall) {
      p.log.warn(`External tool '${tool.name}' not installed. Hooks will skip silently.`);
      p.outro("Done");
      return;
    }

    try {
      p.log.message(`Running: ${installCmd}`);
      runShellCommand(installCmd);
      if (tool.postInstall) {
        p.log.message(`Running post-install: ${tool.postInstall}`);
        runShellCommand(tool.postInstall);
      }
      p.log.success(`Installed '${tool.name}'`);
    } catch (err) {
      p.log.error(`Install failed: ${(err as Error).message}`);
      p.outro("Plugin registered but external tool install failed. Install manually.");
      return;
    }

    p.outro("Done — run 'navori-ai render' to apply");
  },
});
