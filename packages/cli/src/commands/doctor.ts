import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { readConfig, ConfigError, type NavoriConfig } from "../lib/config.ts";
import { loadPlugin, PluginNotFoundError, PluginManifestError } from "../lib/plugins.ts";
import { readBundledCoreVersion } from "../lib/bundled-assets.ts";
import { computeManagedHash, extractManagedContent } from "../lib/marker.ts";
import { check, dim as grey, color, sym, brand, kv, accent } from "../lib/style.ts";

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
    strict: {
      type: "boolean",
      description: "Exit 1 when drift is detected (intended for CI gates)",
    },
  },
  async run({ args }) {
    const cwd = resolve(args.cwd ?? process.cwd());
    const configPath = `${cwd}/navori.config.json`;
    const claudeMdPath = `${cwd}/CLAUDE.md`;

    if (!args.json) p.intro(brand("doctor"));

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
    const drifts = scanManagedDrift(cwd, config);
    const corruptedSettings = scanCorruptedSettings(cwd);
    const report = {
      // Drift is informational ("update available"), not an error — don't
      // flip `ok` for it. Missing plugins and corrupted settings.json ARE
      // errors: the next render will fail or silently skip the file.
      ok: missingPlugins.length === 0 && corruptedSettings.length === 0,
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
      drifts,
      corruptedSettings,
    };

    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
      // JSON consumers (CI pipelines) need the same exit-code semantics as
      // the text output so a piped check ($navori doctor --json --strict)
      // fails the build the same way the human-readable run would.
      if (missingPlugins.length > 0 || corruptedSettings.length > 0) {
        process.exit(2);
      }
      if (Boolean(args.strict) && drifts.length > 0) process.exit(1);
      return;
    }

    p.note(
      kv([
        ["name", accent(config.name)],
        ["version", config.version],
        ["workspace", config.workspace ?? grey("(none)")],
        ["engines", config.engines.join(", ")],
        ["preset", config.preset],
        ["language", config.language],
        ["branchBase", config.branchBase],
        ["commits", config.commits],
      ]),
      `Config · ${grey(configPath)}`,
    );

    p.note(
      [
        `  ${check(report.checks.claudeMdExists)} CLAUDE.md`,
        `  ${check(report.checks.agentsMdExists)} AGENTS.md`,
        `  ${check(report.checks.claudeDirExists)} .claude/`,
        `  ${check(report.checks.progressDirExists)} ${config.progress?.dir ?? "progress"}/`,
      ].join("\n"),
      "Filesystem checks",
    );

    if (markers.length > 0) {
      const lines = markers.map((m) => {
        const ver = m.version ? grey(` v${m.version}`) : grey(" (no version)");
        const src = m.source ?? grey("(unknown source)");
        return `  ${color.cyan(sym.bullet)} ${accent(m.id)}  ${grey("←")}  ${src}${ver}`;
      });
      p.note(lines.join("\n"), `Managed blocks in CLAUDE.md · ${markers.length}`);
    }

    // Skill → agent assignments report (effective: plugin recommendation + config overrides)
    const assignments = collectAssignments(config);
    if (assignments.length > 0) {
      const lines = assignments.map((a) => {
        const override = a.override ? `  ${grey("(overridden)")}` : "";
        return `  ${color.cyan(sym.bullet)} ${accent(a.id)}  ${grey("→")}  ${a.agent}${override}`;
      });
      p.note(lines.join("\n"), `Skill → agent assignments · ${assignments.length}`);
    }

    if (missingPlugins.length > 0) {
      const lines = missingPlugins.map((m) => `  ${color.red(sym.fail)} ${m.id}  ${grey(`— ${m.reason}`)}`);
      p.log.warn(`Plugins declared in config but not loadable (${missingPlugins.length}):\n${lines.join("\n")}`);
    }

    if (drifts.length > 0) {
      const lines = drifts.map((d) => {
        if (d.kind === "content") {
          return `  ${color.red(sym.conflict)} ${accent(`${d.filePath}:${d.markerId}`)}  ${grey(`hash ${d.expectedHash} ≠ ${d.actualHash}`)}  ${grey(`(${d.source}, content edited)`)}`;
        }
        return `  ${color.yellow(sym.update)} ${accent(`${d.filePath}:${d.markerId}`)}  ${grey(`${d.fromVersion} → ${d.toVersion}`)}  ${grey(`(${d.source})`)}`;
      });
      const hint =
        drifts.some((d) => d.kind === "content")
          ? "corré 'navori sync' para resolver conflicts; 'navori render --apply' para actualizar versiones"
          : "corré 'navori render --apply' o 'navori sync'";
      p.log.warn(`Drift detectado (${drifts.length}) — ${hint}:\n${lines.join("\n")}`);
    }

    if (corruptedSettings.length > 0) {
      const lines = corruptedSettings.map(
        (c) => `  ${color.red(sym.fail)} ${accent(c.path)}  ${grey(`— JSON inválido: ${c.error}`)}`,
      );
      p.log.error(
        `Settings.json corrupto (${corruptedSettings.length}) — corré 'navori render --force --apply' para regenerar desde el bundle (el archivo actual se respalda):\n${lines.join("\n")}`,
      );
    }

    const hasIssues = missingPlugins.length > 0 || corruptedSettings.length > 0;
    const strictFail = Boolean(args.strict) && drifts.length > 0;
    p.outro(
      hasIssues
        ? color.red("Issues found")
        : strictFail
          ? color.yellow("Drift detected (--strict)")
          : color.green("OK"),
    );
    // Exit codes for CI gates:
    //   0 = clean (no issues, no drift in --strict)
    //   1 = drift only, --strict mode
    //   2 = hard issues (missing plugins, corrupted settings)
    if (hasIssues) process.exit(2);
    if (strictFail) process.exit(1);
  },
});

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

interface DriftReport {
  /** Repo-relative path of the file with the drifted marker. */
  filePath: string;
  markerId: string;
  source: string;
  /** "version" — the bundle moved ahead. "content" — the body of the
   * managed block no longer matches its `hash=` attribute, i.e. the user
   * edited inside the marker. */
  kind: "version" | "content";
  fromVersion?: string;
  toVersion?: string;
  expectedHash?: string;
  actualHash?: string;
}

/**
 * Walk `.claude/agents/` and `.claude/skills/` and report drift for each
 * managed marker found:
 *
 *   - **version drift** — the marker's `version=` is older than what the
 *     bundle (core or plugin) currently ships. `navori render` will bring
 *     the body up to date.
 *   - **content drift** — the body inside the markers no longer hashes to
 *     the marker's `hash=` attribute, i.e. someone edited the managed
 *     content by hand. `navori sync` will surface this as a conflict.
 *
 * Markers without `version=` or `hash=` are skipped for the respective
 * check. Unknown sources (plugin removed, marker hand-written) are
 * skipped — there's nothing to compare against.
 */
function scanManagedDrift(cwd: string, config: NavoriConfig): DriftReport[] {
  const out: DriftReport[] = [];
  const coreVersion = readBundledCoreVersion();
  const pluginVersions = new Map<string, string>();
  for (const [id, settings] of Object.entries(config.plugins ?? {})) {
    if (settings.enabled !== true) continue;
    try {
      const plugin = loadPlugin(id);
      pluginVersions.set(`@navori/plugin-${id}`, plugin.manifest.version);
    } catch {
      // unknown / broken plugin — reported elsewhere via missingPlugins
    }
  }

  for (const dir of [".claude/agents", ".claude/skills"]) {
    const absDir = join(cwd, dir);
    if (!existsSync(absDir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(absDir);
    } catch {
      continue;
    }
    for (const file of entries) {
      if (!file.endsWith(".md")) continue;
      const rel = `${dir}/${file}`;
      const abs = join(cwd, rel);
      const fileContent = (() => {
        try {
          return readFileSync(abs, "utf-8");
        } catch {
          return null;
        }
      })();
      const markers = listMarkers(abs);

      for (const m of markers) {
        if (!m.source) continue;

        // Version drift: requires version attr and a known source.
        if (m.version) {
          const expected =
            m.source === "@navori/core" ? coreVersion : pluginVersions.get(m.source);
          if (expected && expected !== m.version) {
            out.push({
              filePath: rel,
              markerId: m.id,
              source: m.source,
              kind: "version",
              fromVersion: m.version,
              toVersion: expected,
            });
          }
        }

        // Content drift: recompute the body's hash and compare against the
        // marker's `hash=` attr. Surfaces hand-edits inside the managed zone
        // that `version=`-based scan can't see.
        if (m.hash && fileContent !== null) {
          const body = extractManagedContent(fileContent, m.id, "html");
          if (body !== null) {
            const actual = computeManagedHash(body);
            if (actual !== m.hash) {
              out.push({
                filePath: rel,
                markerId: m.id,
                source: m.source,
                kind: "content",
                expectedHash: m.hash,
                actualHash: actual,
              });
            }
          }
        }
      }
    }
  }
  return out;
}

interface CorruptedSettingsReport {
  path: string;
  error: string;
}

/**
 * Detect `.claude/settings.json` files whose JSON is unparseable. The render
 * adapter (planSettings) would silently skip them today; the doctor surfaces
 * the problem so users know to run `render --force`. Issue #4.
 */
function scanCorruptedSettings(cwd: string): CorruptedSettingsReport[] {
  const path = join(cwd, ".claude/settings.json");
  if (!existsSync(path)) return [];
  try {
    JSON.parse(readFileSync(path, "utf-8"));
    return [];
  } catch (err) {
    return [{ path: ".claude/settings.json", error: (err as Error).message }];
  }
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
