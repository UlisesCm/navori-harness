import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { writeConfig, readConfig } from "../lib/config.ts";
import {
  loadPlugin,
  PluginNotFoundError,
  PluginManifestError,
  listKnownPluginIds,
} from "../lib/plugins.ts";
import { loadFeature, listFeatureIds, FeatureError } from "../lib/features.ts";
import { runRender } from "./render.ts";
import { hasBinary } from "../lib/which.ts";
import { installExternalTool, currentPlatform } from "../lib/install-tool.ts";
import { detectProject } from "../lib/detect.ts";
import { brand, dim, accent, color, sym } from "../lib/style.ts";
import { tc, resolveLang, DEFAULT_LANG, type Lang } from "../lib/i18n.ts";

export const addCommand = defineCommand({
  meta: {
    name: "add",
    description: "Register a plugin in navori.config.json and optionally install its external tool",
  },
  args: {
    plugin: {
      type: "positional",
      description: "Plugin id to add (e.g. engram), or 'feature' to add a feature. Omit with --suggest.",
      required: false,
    },
    id: {
      type: "positional",
      description: "Feature id, when the first argument is 'feature' (e.g. 'navori add feature app-builder').",
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
      p.cancel("Pasa un plugin id (ej. 'navori add engram') o usa --suggest para ver recomendaciones.");
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

    // `navori add feature <id>` — activate a feature (spec 0004) rather than a
    // plugin. The first positional is the literal "feature"; the second is the id.
    if (args.plugin === "feature") {
      await addFeature(cwd, configPath, args.id as string | undefined);
      return;
    }

    // Validated above: without --suggest a missing plugin already exited.
    const pluginId = args.plugin as string;

    let plugin;
    try {
      plugin = loadPlugin(pluginId);
    } catch (err) {
      if (err instanceof PluginNotFoundError) {
        p.cancel(`Unknown plugin '${pluginId}'. Known: ${listKnownPluginIds().join(", ") || "(none)"}`);
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

    const result = await installExternalTool(tool, { assumeYes: Boolean(args.yes) });
    switch (result.status) {
      case "no-command":
        p.log.warn(`No install command for platform '${currentPlatform()}'. Install '${tool.name}' manually.`);
        p.outro("Done");
        return;
      case "skipped":
        p.log.warn(`External tool '${tool.name}' not installed. Hooks will skip silently.`);
        p.outro("Done");
        return;
      case "failed":
        p.log.error(`${color.red(sym.fail)} Install failed: ${result.error}`);
        p.outro(dim("Plugin registered but external tool install failed. Install manually."));
        return;
      default:
        p.log.success(`${color.green(sym.ok)} Installed ${accent(tool.name)}`);
        p.outro(`${color.green("Done")} ${dim("— run 'navori render --apply' to apply")}`);
        return;
    }
  },
});

/**
 * `navori add feature <id>` — validate the id resolves to a feature bundle,
 * append it to `features[]` (preserving the raw config), and render. Spec 0004
 * §3. A bootstrap feature added to an already-initialized repo proceeds with a
 * warning: its scaffold phases self-skip by gate.
 */
async function addFeature(cwd: string, configPath: string, featureId: string | undefined): Promise<void> {
  // Route all prose through the config-language dictionary (spec: no hardcoded
  // locale). Resolve defensively so a broken config still yields a usable message.
  let lang: Lang = DEFAULT_LANG;
  try {
    lang = resolveLang(readConfig(configPath).language);
  } catch {
    // keep the default locale; the config error surfaces on the read below
  }
  const tr = tc(lang).feature;

  if (!featureId) {
    p.cancel(tr.passId);
    process.exit(1);
  }

  let loaded;
  try {
    loaded = loadFeature(featureId, cwd);
  } catch (err) {
    if (err instanceof FeatureError) {
      p.cancel(err.message);
      process.exit(1);
    }
    throw err;
  }
  if (!loaded) {
    const known = listFeatureIds(cwd).join(", ") || tr.noneKnown;
    p.cancel(tr.unknown(featureId, known));
    process.exit(1);
  }

  p.log.info(`${loaded.manifest.displayName} (${loaded.manifest.kind})`);
  p.log.message(loaded.manifest.description);

  if (loaded.manifest.kind === "bootstrap") {
    p.log.warn(tr.addBootstrapWarning(featureId));
  }

  const config = readConfig(configPath);
  const already = (config.features ?? []).includes(featureId);
  if (already) {
    p.log.warn(tr.alreadyActive(featureId));
  } else {
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    const features = Array.isArray(raw.features) ? raw.features : [];
    writeConfig(configPath, { ...raw, features: [...features, featureId] });
    p.log.success(tr.added(featureId, configPath));
  }

  // Render so the feature's SKILL.md + phases land immediately (spec 0004 §3).
  const result = runRender(cwd, false);
  if (!result.ok) {
    p.log.error(result.reason ?? tr.renderFailed);
    p.outro(dim(tr.registeredRenderFailed));
    return;
  }
  p.outro(`${color.green("Done")} ${dim(`— ${tr.activatedRendered}`)}`);
}

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
