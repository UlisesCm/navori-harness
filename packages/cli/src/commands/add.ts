import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { writeConfig, readConfig } from "../lib/config.ts";
import { runRender, printRenderSummary } from "./render.ts";
import {
  loadPlugin,
  PluginNotFoundError,
  PluginManifestError,
  listKnownPluginIds,
  type PluginExternalTool,
} from "../lib/plugins.ts";
import { hasBinary } from "../lib/which.ts";
import { currentPlatform } from "../lib/platform.ts";
import {
  listAvailableExternalProviders,
  EXTERNAL_PROVIDER_SETUP_RECIPE_URL,
  PROVIDERS_WITH_SETUP_RECIPE,
} from "../lib/external-providers.ts";
import { InstallError } from "../lib/errors.ts";
import { detectProject } from "../lib/diagnose/detect.ts";
import { brand, dim, accent, color, sym } from "../lib/style.ts";
import { tc, resolveLang, DEFAULT_LANG, type Lang } from "../lib/i18n.ts";

/** Resolve the repo's locale for human output; DEFAULT_LANG when no config yet. */
function langFor(configPath: string): Lang {
  if (!existsSync(configPath)) return DEFAULT_LANG;
  try {
    return resolveLang(readConfig(configPath).language);
  } catch {
    return DEFAULT_LANG;
  }
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

// Cap on the stderr we attach to InstallError (#960) — enough for the real
// error line(s) from brew/npm/pnpm/curl without dumping a runaway build log
// into the terminal.
const STDERR_MAX_CHARS = 4000;

/**
 * Trim and cap captured stderr; `null` when there was nothing useful. Keeps
 * the TAIL, not the head, when it needs to cut: the actionable line — npm's
 * `EACCES` fix suggestion, brew's `Error:` after the download noise — is
 * almost always the last thing printed, not the first.
 */
function trimStderr(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  return trimmed.length > STDERR_MAX_CHARS
    ? `(start omitted) …\n${trimmed.slice(-STDERR_MAX_CHARS)}`
    : trimmed;
}

/**
 * #960 — stderr must be captured for `install` (so a failure carries the
 * real message instead of just an exit code) but NEVER for `postInstall`:
 * `gh`'s postInstall is `gh auth status || gh auth login`, which opens an
 * interactive auth prompt, and the engram linux install script pipes
 * through `curl`. Both need a real TTY on stdin/stdout/stderr — piping
 * stderr there would silently swallow the prompt. So capture only replaces
 * stderr (`pipe`); stdin AND stdout stay inherited either way — brew/npm/pnpm
 * installs can take minutes and the user still needs to see that progress
 * live, not just a spinner. When NOT capturing the whole triad stays
 * "inherit" exactly as before.
 */
function runShellCommand(
  cmd: string,
  ta: ReturnType<typeof tc>["add"],
  captureStderr: boolean,
): void {
  // `shell: true` is required here and pre-existing (see the SECURITY NOTES
  // above `INSTALL_TIMEOUT_MS`): the command is validated plugin.json content,
  // never user input, and is shown + confirmed before running.
  // nosemgrep: javascript.lang.security.audit.spawn-shell-true.spawn-shell-true
  const result = spawnSync(cmd, {
    shell: true,
    stdio: captureStderr ? ["inherit", "inherit", "pipe"] : "inherit",
    timeout: INSTALL_TIMEOUT_MS,
    encoding: "utf-8",
  });
  // spawnSync sets result.error with the killed signal when timeout fires
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    throw new InstallError(ta.installTimeout(INSTALL_TIMEOUT_MS / 1000));
  }
  if (result.signal) {
    throw new InstallError(ta.commandKilled(result.signal));
  }
  if (result.status !== 0) {
    const stderr = captureStderr ? trimStderr(result.stderr) : null;
    throw new InstallError(
      stderr ? ta.commandExitedWithStderr(result.status, stderr) : ta.commandExited(result.status),
    );
  }
}

/**
 * Best-effort cause for "the installer exited 0 but the binary isn't on
 * PATH" (#960), inferred from the install command text since
 * `PluginExternalTool` doesn't carry an installer kind. Covers the actual
 * defaults in the plugin manifests today (pnpm/npm global bin dirs,
 * Homebrew's arch-dependent prefix, engram's `$HOME/.local/bin`); falls
 * back to a generic hint for anything else.
 */
function likelyPathCause(cmd: string, ta: ReturnType<typeof tc>["add"]): string {
  if (/\bpnpm\s+add\s+-g\b/.test(cmd)) return ta.causePnpmSetup;
  if (/\bnpm\s+install\s+-g\b/.test(cmd)) return ta.causeNpmGlobalBin;
  if (/\bbrew\s+install\b/.test(cmd)) return ta.causeHomebrewPath;
  if (/\$HOME\/\.local\/bin\b/.test(cmd)) return ta.causeLocalBin;
  return ta.causeUnknownPath;
}

interface RunUnderSpinnerOptions {
  /** Capture stderr instead of inheriting it (#960) — see runShellCommand. */
  captureStderr: boolean;
  /**
   * After a successful run, reconfirm `tool.checkBinary` is actually on
   * PATH (#960) — exit 0 from the installer doesn't mean reachable. Only
   * meaningful for `install`; `postInstall` isn't about landing a binary.
   */
  verifyBinary?: boolean;
  /**
   * Skip the command entirely when `stdin` isn't a TTY (#967) — for
   * `postInstall` only. `install` commands (brew/npm/pnpm) don't need a
   * real terminal; `postInstall` commands (`gh auth login`, engram's
   * installer) do. Warns with the exact command and returns `true`: a
   * skip, not a failure — the caller (the fresh-install chain, which runs
   * `postInstall` unconditionally right after a successful `install`)
   * must not report `registeredInstallFailed` for an install that worked.
   */
  skipIfNoTty?: boolean;
}

/**
 * Run a shell command under the spinner, reusing the install/postInstall
 * success+failure copy. Returns whether it succeeded, so callers decide what
 * to do next (e.g. the install path chains postInstall only on success).
 */
function runUnderSpinner(
  cmd: string,
  startMessage: string,
  tool: PluginExternalTool,
  ta: ReturnType<typeof tc>["add"],
  options: RunUnderSpinnerOptions,
): boolean {
  // `=== true`, not truthy — see the `offerPostInstall` guard below for why.
  if (options.skipIfNoTty && process.stdin.isTTY !== true) {
    p.log.warn(ta.postInstallNoTty(cmd));
    return true;
  }

  const spin = p.spinner();
  try {
    spin.start(startMessage);
    runShellCommand(cmd, ta, options.captureStderr);
    if (options.verifyBinary && tool.checkBinary && !hasBinary(tool.checkBinary)) {
      const cause = likelyPathCause(cmd, ta);
      spin.stop(`${color.red("✗")} ${ta.installedButUnreachable(accent(tool.name), cause)}`, 1);
      return false;
    }
    spin.stop(`${color.green("✓")} ${ta.installed(accent(tool.name))}`);
    return true;
  } catch (err) {
    spin.stop(`${color.red("✗")} ${ta.installFailed((err as Error).message)}`, 1);
    return false;
  }
}

/**
 * Offer to run a plugin's postInstall independently of whether the binary
 * itself needed installing (#953): "binary is on PATH" and "setup is done"
 * are different facts — a preinstalled `gh` still needs `gh auth status`.
 * No-op when the plugin declares no postInstall, so plugins without one see
 * no new prompt.
 */
async function offerPostInstall(
  tool: PluginExternalTool,
  args: { yes?: boolean; "skip-install"?: boolean },
  ta: ReturnType<typeof tc>["add"],
): Promise<boolean> {
  if (!tool.postInstall) return false;
  if (args["skip-install"]) return false;

  // `=== true`, not truthy: without a TTY, `isTTY` is `undefined`, not `false`
  // (https://nodejs.org/api/tty.html). `stdin`, not `stdout`: what's needed
  // here is the ability to READ a prompt — the `postInstall` itself (e.g.
  // `gh auth login`) is just as interactive as the `p.confirm` below, so
  // this applies even with `--yes` (#967). Same predicate as
  // `initIsInteractive` (global.ts:123); duplicated rather than extracted
  // to avoid touching that file for a one-line check.
  if (process.stdin.isTTY !== true) {
    p.log.warn(ta.postInstallNoTty(tool.postInstall));
    return false;
  }

  const shouldRun = args.yes
    ? true
    : await p.confirm({
        message: ta.postInstallPrompt(tool.name, tool.postInstall),
        initialValue: false,
      });

  if (p.isCancel(shouldRun) || !shouldRun) return false;

  const ok = runUnderSpinner(tool.postInstall, ta.postInstall(dim(tool.postInstall)), tool, ta, {
    captureStderr: false,
  });
  return !ok;
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

    const lang = langFor(configPath);
    const ta = tc(lang).add;

    if (args.suggest) {
      p.intro(brand("add --suggest"));
    } else if (!args.plugin) {
      p.intro(brand("add"));
      p.cancel(ta.pluginRequired);
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
      printSuggestions(cwd, configPath, lang);
      return;
    }

    // Validated above: without --suggest a missing plugin already exited.
    const pluginId = args.plugin as string;

    let plugin;
    try {
      plugin = loadPlugin(pluginId);
    } catch (err) {
      if (err instanceof PluginNotFoundError) {
        p.cancel(ta.unknownPlugin(pluginId, listKnownPluginIds().join(", ") || ta.none));
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
      p.log.warn(ta.alreadyEnabled(plugin.manifest.id));
    } else {
      // Update config — preserve existing values
      const updatedPlugins = {
        ...(config.plugins ?? {}),
        [plugin.manifest.id]: { enabled: true },
      };
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      writeConfig(configPath, { ...raw, plugins: updatedPlugins });
      p.log.success(ta.added(plugin.manifest.id, configPath));

      // Render right away (#974) — same contract as `remove.ts`: the config
      // write alone doesn't materialize the plugin's wiring (.mcp.json entry,
      // settings permission, managed block), so without this a freshly
      // enabled plugin sits inert until someone remembers to run
      // `navori render --apply` by hand.
      let renderResult: ReturnType<typeof runRender>;
      try {
        renderResult = runRender(cwd, false);
      } catch (err) {
        p.log.error(err instanceof Error ? err.message : String(err));
        p.outro(ta.renderCrashed);
        process.exitCode = 1;
        return;
      }
      if (!renderResult.ok) {
        p.log.error(renderResult.reason ?? tc(lang).render.renderFailed);
        p.outro(ta.renderFailedConfig);
        process.exitCode = 1;
        return;
      }
      printRenderSummary(renderResult);

      // #982 — codegraph/tgrep need a setup step (index init, MCP approval)
      // beyond the binary itself; `--yes`/`--recommended` init never mentions
      // it either, so this is the first (and often only) place a user learns
      // it exists. Only on a fresh enable, not on every re-run of `add`.
      if (PROVIDERS_WITH_SETUP_RECIPE.has(plugin.manifest.id)) {
        p.log.info(ta.externalProviderSetupHint(EXTERNAL_PROVIDER_SETUP_RECIPE_URL));
      }
    }

    // Handle external tool
    const tool = plugin.manifest.externalTool;
    if (!tool) {
      p.outro(ta.done);
      return;
    }

    const installed = tool.checkBinary ? hasBinary(tool.checkBinary) : true;
    if (installed) {
      p.log.success(ta.externalAlreadyInstalled(tool.name));
      const postInstallFailed = await offerPostInstall(tool, args, ta);
      p.outro(postInstallFailed ? dim(ta.registeredInstallFailed) : ta.done);
      return;
    }

    // The branches below end with the plugin already `enabled: true` in the
    // config and its wiring already rendered (both above) while its external
    // binary is still absent. None of them need a "run render --apply" hint
    // anymore (#974) — that already happened; they only need to tell the user
    // how to get the binary installed.
    //
    // Exit code rule for them: ≠ 0 when the tool ended up unusable and nobody
    // asked for that; 0 when the user explicitly opted out. `--skip-install`
    // and declining the prompt are the opt-outs — `add` did exactly what it
    // was told, so failing the shell there would make the flag unusable in
    // scripts.
    if (args["skip-install"]) {
      p.log.warn(ta.externalSkipped(tool.name));
      printInstallDocs(tool, ta);
      p.outro(ta.doneInstallLater);
      return;
    }

    const platform = currentPlatform();
    const installCmd = platform ? tool.install?.[platform] : undefined;
    if (!installCmd) {
      p.log.warn(ta.noInstallCommand(platform ?? process.platform, tool.name));
      printInstallDocs(tool, ta);
      p.outro(dim(ta.doneNoInstall(tool.name)));
      // Nothing was installed and the binary is still missing — `add` did not
      // do what it was asked to. Exit code, not just prose, so a script can
      // tell. `exitCode` rather than `exit()` so clack's outro still flushes.
      process.exitCode = 1;
      return;
    }

    const shouldInstall = args.yes
      ? true
      : await p.confirm({
          message: ta.installPrompt(tool.name, installCmd),
          initialValue: false,
        });

    if (p.isCancel(shouldInstall) || !shouldInstall) {
      p.log.warn(ta.externalNotInstalled(tool.name));
      printInstallDocs(tool, ta);
      // Exit 0 on purpose: the user saw the command and said no (or aborted
      // the prompt). An honored explicit choice is not a command failure.
      p.outro(ta.doneInstallLater);
      return;
    }

    const installOk = runUnderSpinner(
      installCmd,
      ta.installing(accent(tool.name), dim(installCmd)),
      tool,
      ta,
      { captureStderr: true, verifyBinary: true },
    );
    if (!installOk) {
      printInstallDocs(tool, ta);
      p.outro(dim(ta.registeredInstallFailed));
      // The install ran and the binary is still not on PATH (`verifyBinary`),
      // which is the same end state as having no command at all.
      process.exitCode = 1;
      return;
    }

    if (tool.postInstall) {
      const postInstallOk = runUnderSpinner(
        tool.postInstall,
        ta.postInstall(dim(tool.postInstall)),
        tool,
        ta,
        { captureStderr: false, skipIfNoTty: true },
      );
      if (!postInstallOk) {
        p.outro(dim(ta.registeredInstallFailed));
        return;
      }
    }

    p.outro(ta.done);
  },
});

/**
 * Print the tool's official installation page when the manifest declares one.
 *
 * Every degraded exit of `add` used to tell the user to install the tool
 * "manually" without naming a destination. `installDocs` is the honest answer
 * for a platform upstream documents no single command for — inventing a command
 * there would run shell on the user's machine (#965).
 */
function printInstallDocs(tool: PluginExternalTool, ta: ReturnType<typeof tc>["add"]): void {
  if (tool.installDocs) p.log.info(ta.installDocsHint(tool.installDocs));
}

/**
 * Spec 0003 §3.5.2 — suggest (never install) based on the detected stack:
 * the preset that fits if it differs from the current one, engram if not
 * enabled, and (#981) any other external-tool provider that's available but
 * not enabled. Skills tied to a stack (mantine, nextjs…) live in presets, so
 * the actionable suggestion is the preset, not a plugin.
 */
function printSuggestions(cwd: string, configPath: string, lang: Lang): void {
  const ta = tc(lang).add;
  const detected = detectProject(cwd);
  const config = readConfig(configPath);
  const lines: string[] = [];

  const sp = detected.suggestedPreset;
  if (sp && sp !== "custom" && sp !== config.preset) {
    const what = detected.stack.ui ?? detected.stack.framework ?? detected.stack.language;
    lines.push(
      `${color.cyan(sym.bullet)} ${ta.suggestedPreset(accent(what), accent(sp), config.preset)}`,
    );
  }

  const enabled = new Set(
    Object.entries(config.plugins ?? {})
      .filter(([, v]) => v.enabled === true)
      .map(([k]) => k),
  );
  if (!enabled.has("engram")) {
    lines.push(`${color.cyan(sym.bullet)} ${ta.suggestedEngram}`);
  }

  // #981: name external-tool providers (codegraph, tgrep, semgrep, jscpd,
  // acli, gh…) that exist but aren't enabled yet — the `--yes`/`--recommended`
  // init paths never mention them, so this is the only place a user learns
  // they exist. Offer only, never auto-enable (D04).
  for (const id of listAvailableExternalProviders(config, cwd)) {
    lines.push(`${color.cyan(sym.bullet)} ${ta.suggestedProvider(accent(id))}`);
  }

  if (lines.length === 0) {
    p.outro(color.green(ta.nothingToSuggest));
    return;
  }
  p.note(lines.join("\n"), ta.suggestionsTitle);
  p.outro(dim(ta.suggestionsOutro));
}
