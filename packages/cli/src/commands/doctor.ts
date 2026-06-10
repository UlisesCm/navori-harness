import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readConfig, ConfigError, type NavoriConfig } from "../lib/config.ts";
import { loadPlugin, PluginNotFoundError, PluginManifestError } from "../lib/plugins.ts";
import { check, dim as grey, color, sym } from "../lib/style.ts";

interface MarkerInfo {
  id: string;
  hash: string | null;
  version: string | null;
  source: string | null;
}

function listMarkers(filePath: string): MarkerInfo[] {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, "utf-8");
  const re = /<!-- navori:managed [^>]*-->/g;
  const result: MarkerInfo[] = [];
  for (const match of content.matchAll(re)) {
    const tag = match[0];
    if (tag.startsWith("<!-- /navori:managed")) continue;
    const id = tag.match(/id="([^"]+)"/)?.[1] ?? "?";
    const hash = tag.match(/hash="([^"]+)"/)?.[1] ?? null;
    const version = tag.match(/version="([^"]+)"/)?.[1] ?? null;
    const source = tag.match(/source="([^"]+)"/)?.[1] ?? null;
    result.push({ id, hash, version, source });
  }
  return result;
}

export const doctorCommand = defineCommand({
  meta: {
    name: "doctor",
    description: "Inspect navori.config.json and report resolved state + managed blocks",
  },
  args: {
    cwd: { type: "string", description: "Directory to inspect (default: cwd)" },
    json: { type: "boolean", description: "Output as JSON (pipeable)" },
  },
  async run({ args }) {
    const cwd = resolve(args.cwd ?? process.cwd());
    const configPath = `${cwd}/navori.config.json`;
    const claudeMdPath = `${cwd}/CLAUDE.md`;

    if (!args.json) p.intro("navori doctor");

    if (!existsSync(cwd)) {
      if (args.json) {
        console.log(JSON.stringify({ ok: false, error: "directory-missing", cwd }));
      } else {
        p.cancel(`Directory not found: ${cwd}`);
      }
      process.exit(1);
    }

    if (!existsSync(configPath)) {
      if (args.json) {
        console.log(JSON.stringify({ ok: false, error: "config-missing", configPath }));
      } else {
        p.cancel(`No navori.config.json at ${configPath}. Run 'navori init' first.`);
      }
      process.exit(1);
    }

    let config: NavoriConfig;
    try {
      config = readConfig(configPath);
    } catch (err) {
      if (err instanceof ConfigError) {
        if (args.json) {
          console.log(JSON.stringify({ ok: false, error: "config-invalid", message: err.message, issues: err.issues }));
        } else {
          p.cancel(err.message);
          if (err.issues) {
            for (const issue of err.issues) {
              console.error(`  - ${issue.path.join(".") || "(root)"}: ${issue.message}`);
            }
          }
        }
        process.exit(1);
      }
      throw err;
    }

    const markers = listMarkers(claudeMdPath);
    const missingPlugins = collectMissingPlugins(config);
    const report = {
      ok: missingPlugins.length === 0,
      configPath,
      config,
      checks: {
        claudeMdExists: existsSync(claudeMdPath),
        agentsMdExists: existsSync(`${cwd}/AGENTS.md`),
        claudeDirExists: existsSync(`${cwd}/.claude`),
        progressDirExists: existsSync(`${cwd}/${config.progress?.dir ?? "progress"}`),
      },
      managedBlocks: markers,
      missingPlugins,
    };

    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    p.log.message(`Config: ${configPath}`);
    p.log.message(`  name      : ${config.name}`);
    p.log.message(`  version   : ${config.version}`);
    p.log.message(`  workspace : ${config.workspace ?? "(none)"}`);
    p.log.message(`  engines   : ${config.engines.join(", ")}`);
    p.log.message(`  preset    : ${config.preset}`);
    p.log.message(`  language  : ${config.language}`);
    p.log.message(`  branchBase: ${config.branchBase}`);
    p.log.message(`  commits   : ${config.commits}`);

    p.log.message("Filesystem checks:");
    p.log.message(`  ${mark(report.checks.claudeMdExists)} CLAUDE.md`);
    p.log.message(`  ${mark(report.checks.agentsMdExists)} AGENTS.md`);
    p.log.message(`  ${mark(report.checks.claudeDirExists)} .claude/`);
    p.log.message(`  ${mark(report.checks.progressDirExists)} ${config.progress?.dir ?? "progress"}/`);

    if (markers.length > 0) {
      p.log.message(`Managed blocks in CLAUDE.md (${markers.length}):`);
      for (const m of markers) {
        const ver = m.version ? ` v${m.version}` : " (no version)";
        const src = m.source ?? "(unknown source)";
        p.log.message(`  · ${m.id}  ←  ${src}${ver}`);
      }
    }

    // Skill → agent assignments report (effective: plugin recommendation + config overrides)
    const assignments = collectAssignments(config);
    if (assignments.length > 0) {
      p.log.message(`Skill → agent assignments (${assignments.length}):`);
      for (const a of assignments) {
        const override = a.override ? `  ${grey("(overridden)")}` : "";
        p.log.message(`  · ${a.id}  →  ${a.agent}${override}`);
      }
    }

    if (missingPlugins.length > 0) {
      const lines = missingPlugins.map((m) => `  ${color.red(sym.fail)} ${m.id}  ${grey(`— ${m.reason}`)}`);
      p.log.warn(`Plugins declared in config but not loadable (${missingPlugins.length}):\n${lines.join("\n")}`);
    }

    p.outro(missingPlugins.length > 0 ? color.red("Issues found") : color.green("OK"));
  },
});

function mark(ok: boolean): string {
  return check(ok);
}

interface AssignmentRow {
  id: string;
  agent: string;
  override: boolean;
}

interface MissingPlugin {
  id: string;
  reason: string;
}

function collectMissingPlugins(config: NavoriConfig): MissingPlugin[] {
  const missing: MissingPlugin[] = [];
  for (const [id, settings] of Object.entries(config.plugins ?? {})) {
    if (settings.enabled !== true) continue;
    try {
      loadPlugin(id);
    } catch (err) {
      if (err instanceof PluginNotFoundError) {
        missing.push({ id, reason: "unknown plugin id" });
      } else if (err instanceof PluginManifestError) {
        missing.push({ id, reason: err.message });
      } else {
        missing.push({ id, reason: (err as Error).message });
      }
    }
  }
  return missing;
}

function collectAssignments(config: NavoriConfig): AssignmentRow[] {
  const overrides = config.agentAssignments ?? {};
  const out: AssignmentRow[] = [];
  for (const [pluginId, settings] of Object.entries(config.plugins ?? {})) {
    if (settings.enabled !== true) continue;
    let plugin;
    try {
      plugin = loadPlugin(pluginId);
    } catch {
      continue;
    }
    for (const entry of plugin.manifest.managed) {
      const overrideValue = overrides[entry.id];
      if (overrideValue) {
        out.push({ id: entry.id, agent: overrideValue, override: true });
      } else if (entry.recommendedAgent) {
        out.push({ id: entry.id, agent: entry.recommendedAgent, override: false });
      }
    }
  }
  return out;
}
