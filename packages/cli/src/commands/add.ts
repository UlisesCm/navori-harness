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
import { InstallError } from "../lib/errors.ts";
import { detectProject } from "../lib/detect.ts";
import { brand, dim, accent, color, sym } from "../lib/style.ts";

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
}

export const addCommand = defineCommand({
  meta: {
    name: "add",
    description: "Register a plugin in navori.config.json and optionally install its external tool",
  },
  args: {
    plugin: {
      type: "positional",
      description: "Plugin id to add (e.g. engram). Omit with --suggest.",
      required: false,
    },
    suggest: {
      type: "boolean",
      description: "Detect the stack and suggest a preset + plugins (does not install anything).",
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

    if (args.suggest) {
      p.intro(brand("add --suggest"));
    } else if (!args.plugin) {
      p.intro(brand("add"));
      p.cancel(
        "Pasa un plugin id (ej. 'navori add engram') o usa --suggest para ver recomendaciones.",
      );
      process.exit(1);
    } else {
      p.intro(brand(`add ${accent(args.plugin)}`));
    }

    if (!existsSync(cwd)) {
      p.cancel(`Directory not found: ${cwd}`);
      process.exit(1);
    }

    if (!existsSync(configPath)) {
      p.cancel(`No navori.config.json at ${configPath}. Run 'navori init' first.`);
      process.exit(1);
    }

    if (args.suggest) {
      printSuggestions(cwd, configPath);
      return;
    }

    // Validated above: without --suggest a missing plugin already exited.
    const pluginId = args.plugin as string;

    let plugin;
    try {
      plugin = loadPlugin(pluginId);
    } catch (err) {
      if (err instanceof PluginNotFoundError) {
        p.cancel(
          `Unknown plugin '${pluginId}'. Known: ${listKnownPluginIds().join(", ") || "(none)"}`,
        );
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
      p.outro("Done — run 'navori render --apply' to apply");
      return;
    }

    const installed = tool.checkBinary ? hasBinary(tool.checkBinary) : true;
    if (installed) {
      p.log.success(`External tool '${tool.name}' is already installed`);
      p.outro("Done — run 'navori render --apply' to apply");
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

    const spin = p.spinner();
    try {
      spin.start(`Installing ${accent(tool.name)} — ${dim(installCmd)}`);
      runShellCommand(installCmd);
      if (tool.postInstall) {
        spin.message(`Post-install — ${dim(tool.postInstall)}`);
        runShellCommand(tool.postInstall);
      }
      spin.stop(`${color.green("✓")} Installed ${accent(tool.name)}`);
    } catch (err) {
      spin.stop(`${color.red("✗")} Install failed: ${(err as Error).message}`, 1);
      p.outro(dim("Plugin registered but external tool install failed. Install manually."));
      return;
    }

    p.outro(`${color.green("Done")} ${dim("— run 'navori render --apply' to apply")}`);
  },
});

/**
 * Spec 0003 §3.5.2 — suggest (never install) based on the detected stack:
 * the preset that fits if it differs from the current one, and engram if not
 * enabled. Skills tied to a stack (mantine, nextjs…) live in presets, so the
 * actionable suggestion is the preset, not a plugin.
 */
function printSuggestions(cwd: string, configPath: string): void {
  const detected = detectProject(cwd);
  const config = readConfig(configPath);
  const lines: string[] = [];

  const sp = detected.suggestedPreset;
  if (sp && sp !== "custom" && sp !== config.preset) {
    const what = detected.stack.ui ?? detected.stack.framework ?? detected.stack.language;
    lines.push(
      `${color.cyan(sym.bullet)} Preset: detecté ${accent(what)} → sugerido ${accent(sp)} ` +
        `${dim(`(actual: ${config.preset})`)} — cámbialo con 'navori configure' o edita navori.config.json.`,
    );
  }

  const enabled = new Set(
    Object.entries(config.plugins ?? {})
      .filter(([, v]) => v.enabled === true)
      .map(([k]) => k),
  );
  if (!enabled.has("engram")) {
    lines.push(
      `${color.cyan(sym.bullet)} Plugin ${accent("engram")}: memoria persistente entre sesiones — 'navori add engram'.`,
    );
  }

  if (lines.length === 0) {
    p.outro(
      `${color.green("Nada que sugerir")} ${dim("— el preset matchea el stack y engram ya está habilitado.")}`,
    );
    return;
  }
  p.note(lines.join("\n"), "Sugerencias");
  p.outro(dim("Sugerencias, no aplicadas — corre 'navori add <id>' o 'navori configure'."));
}
