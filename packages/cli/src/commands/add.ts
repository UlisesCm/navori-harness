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
import { tc, resolveLang, DEFAULT_LANG, type Lang } from "../lib/i18n.ts";

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

function runShellCommand(cmd: string, lang: Lang): void {
  const result = spawnSync(cmd, {
    shell: true,
    stdio: "inherit",
    timeout: INSTALL_TIMEOUT_MS,
  });
  // spawnSync sets result.error with the killed signal when timeout fires
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    throw new InstallError(tc(lang).add.installTimeout(INSTALL_TIMEOUT_MS / 1000));
  }
  if (result.signal) {
    throw new InstallError(tc(lang).add.commandKilled(result.signal));
  }
  if (result.status !== 0) {
    throw new InstallError(tc(lang).add.commandExited(result.status));
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
      p.cancel(tc(DEFAULT_LANG).add.pluginRequired);
      process.exit(1);
    } else {
      p.intro(brand(`add ${accent(args.plugin)}`));
    }

    if (!existsSync(cwd)) {
      p.cancel(tc(DEFAULT_LANG).common.dirNotFound(cwd));
      process.exit(1);
    }

    if (!existsSync(configPath)) {
      p.cancel(tc(DEFAULT_LANG).common.noConfig(configPath));
      process.exit(1);
    }

    if (args.suggest) {
      printSuggestions(cwd, configPath);
      return;
    }

    // Validated above: without --suggest a missing plugin already exited.
    const pluginId = args.plugin as string;
    const config = readConfig(configPath);
    const lang = resolveLang(config.language);
    const tr = tc(lang).add;

    let plugin;
    try {
      plugin = loadPlugin(pluginId);
    } catch (err) {
      if (err instanceof PluginNotFoundError) {
        p.cancel(tr.unknownPlugin(pluginId, listKnownPluginIds().join(", ") || tr.none));
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

    const already = config.plugins?.[plugin.manifest.id]?.enabled === true;

    if (already) {
      p.log.warn(tr.alreadyEnabled(plugin.manifest.id));
    } else {
      // Update config — preserve existing values
      const updatedPlugins = {
        ...(config.plugins ?? {}),
        [plugin.manifest.id]: { enabled: true },
      };
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      writeConfig(configPath, { ...raw, plugins: updatedPlugins });
      p.log.success(tr.added(plugin.manifest.id, configPath));
    }

    // Handle external tool
    const tool = plugin.manifest.externalTool;
    if (!tool) {
      p.outro(tr.doneRender);
      return;
    }

    const installed = tool.checkBinary ? hasBinary(tool.checkBinary) : true;
    if (installed) {
      p.log.success(tr.externalAlreadyInstalled(tool.name));
      p.outro(tr.doneRender);
      return;
    }

    if (args["skip-install"]) {
      p.log.warn(tr.externalSkipped(tool.name));
      p.outro(tr.doneInstallLater);
      return;
    }

    const platform = currentPlatform();
    const installCmd = tool.install?.[platform];
    if (!installCmd) {
      p.log.warn(tr.noInstallCommand(platform, tool.name));
      p.outro(tr.done);
      return;
    }

    const shouldInstall = args.yes
      ? true
      : await p.confirm({
          message: tr.installPrompt(tool.name, installCmd),
          initialValue: false,
        });

    if (p.isCancel(shouldInstall) || !shouldInstall) {
      p.log.warn(tr.externalNotInstalled(tool.name));
      p.outro(tr.done);
      return;
    }

    const spin = p.spinner();
    try {
      spin.start(tr.installing(accent(tool.name), dim(installCmd)));
      runShellCommand(installCmd, lang);
      if (tool.postInstall) {
        spin.message(tr.postInstall(dim(tool.postInstall)));
        runShellCommand(tool.postInstall, lang);
      }
      spin.stop(`${color.green("✓")} ${tr.installed(accent(tool.name))}`);
    } catch (err) {
      spin.stop(`${color.red("✗")} ${tr.installFailed((err as Error).message)}`, 1);
      p.outro(dim(tr.registeredInstallFailed));
      return;
    }

    p.outro(color.green(tr.doneRender));
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
  const tr = tc(resolveLang(config.language)).add;
  const lines: string[] = [];

  const sp = detected.suggestedPreset;
  if (sp && sp !== "custom" && sp !== config.preset) {
    const what = detected.stack.ui ?? detected.stack.framework ?? detected.stack.language;
    lines.push(
      `${color.cyan(sym.bullet)} ${tr.suggestedPreset(
        accent(what),
        accent(sp),
        dim(config.preset),
      )}`,
    );
  }

  const enabled = new Set(
    Object.entries(config.plugins ?? {})
      .filter(([, v]) => v.enabled === true)
      .map(([k]) => k),
  );
  if (!enabled.has("engram")) {
    lines.push(`${color.cyan(sym.bullet)} ${tr.suggestedEngram}`);
  }

  if (lines.length === 0) {
    p.outro(color.green(tr.nothingToSuggest));
    return;
  }
  p.note(lines.join("\n"), tr.suggestionsTitle);
  p.outro(dim(tr.suggestionsOutro));
}
