import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { readConfig, ConfigError, type NavoriConfig } from "../lib/config.ts";
import { collectMissingPlugins, scanManagedDrift, suggestNextSteps } from "../lib/health.ts";
import { brand, dim as grey, color, sym, kv, accent } from "../lib/style.ts";
import { tc, resolveLang, DEFAULT_LANG } from "../lib/i18n.ts";

/**
 * `status` — spec 0003 §3.5.3. A quick "where did this repo land?" snapshot:
 * config summary, enabled plugins, drift count, and suggested next steps.
 * Shares its health-check logic with `doctor` (lib/health.ts); `doctor` is the
 * verbose audit, `status` is the at-a-glance view.
 */
export const statusCommand = defineCommand({
  meta: {
    name: "status",
    description: "Quick snapshot: config, plugins, drift, and suggested next steps",
  },
  args: {
    cwd: { type: "string", description: "Directory to inspect (default: cwd)" },
    json: { type: "boolean", description: "Output as JSON (pipeable)" },
  },
  async run({ args }) {
    const cwd = resolve(args.cwd ?? process.cwd());
    const configPath = `${cwd}/navori.config.json`;

    if (!existsSync(configPath)) {
      if (args.json) {
        console.log(JSON.stringify({ ok: false, error: "config-missing", configPath }));
      } else {
        p.intro(brand("status"));
        p.cancel(tc(DEFAULT_LANG).common.noConfig(configPath));
      }
      process.exit(1);
    }

    let config: NavoriConfig;
    try {
      config = readConfig(configPath);
    } catch (err) {
      if (err instanceof ConfigError) {
        if (args.json) {
          console.log(JSON.stringify({ ok: false, error: "config-invalid", message: err.message }));
        } else {
          p.intro(brand("status"));
          p.cancel(err.message);
        }
        process.exit(1);
      }
      throw err;
    }

    const claudeMdExists = existsSync(`${cwd}/CLAUDE.md`);
    const missingPlugins = collectMissingPlugins(config);
    const drifts = scanManagedDrift(cwd, config);
    const enabledPlugins = Object.entries(config.plugins ?? {})
      .filter(([, v]) => v.enabled === true)
      .map(([k]) => k);

    if (args.json) {
      console.log(
        JSON.stringify(
          {
            ok: missingPlugins.length === 0,
            name: config.name,
            version: config.version,
            preset: config.preset,
            engines: config.engines,
            enabledPlugins,
            claudeMdExists,
            drift: drifts.length,
            missingPlugins: missingPlugins.map((m) => m.id),
            // Machine-readable contract: the prose stays stable in English so a
            // consumer never has to branch on config.language.
            nextSteps: suggestNextSteps({ claudeMdExists, missingPlugins, drifts }, "en"),
          },
          null,
          2,
        ),
      );
      return;
    }

    const lang = resolveLang(config.language);
    const ts = tc(lang).status;
    const nextSteps = suggestNextSteps({ claudeMdExists, missingPlugins, drifts }, lang);

    p.intro(brand("status"));
    p.note(
      kv([
        ["name", accent(config.name)],
        ["version", config.version],
        ["preset", config.preset],
        ["engines", config.engines.join(", ")],
        ["plugins", enabledPlugins.length > 0 ? enabledPlugins.join(", ") : grey(ts.none)],
        ["CLAUDE.md", claudeMdExists ? color.green(ts.present) : color.red(ts.missing)],
        ["drift", drifts.length > 0 ? color.yellow(`${drifts.length}`) : color.green("0")],
      ]),
      ts.statusTitle(grey(cwd)),
    );
    p.note(nextSteps.map((s) => `  ${color.cyan(sym.bullet)} ${s}`).join("\n"), ts.nextStepsTitle);
    p.outro(missingPlugins.length > 0 ? color.red(ts.issuesFound) : color.green(ts.ok));
  },
});
