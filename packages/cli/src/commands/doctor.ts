import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { existsSync, readFileSync, readdirSync, type Dirent } from "node:fs";
import { join, resolve, relative } from "node:path";
import { readConfig, ConfigError, type NavoriConfig } from "../lib/config.ts";
import { isPlaceholderName } from "../lib/detect.ts";
import { loadPlugin } from "../lib/plugins.ts";
import { hasBinary } from "../lib/which.ts";
import { loadPreset, presetExists, resolvePreset } from "../lib/presets.ts";
import { scanMonorepoWorkspaces, diffWorkspaces } from "../lib/scan.ts";
import {
  listMarkers,
  collectMissingPlugins,
  scanManagedDrift,
  scanManagedOrder,
  suggestNextSteps,
} from "../lib/health.ts";
import { check, dim as grey, color, sym, brand, kv, accent } from "../lib/style.ts";

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
    const orderReport = scanManagedOrder(cwd, config);
    const corruptedSettings = scanCorruptedSettings(cwd);
    const missingInvariants = scanMissingInvariants(cwd, config);
    const missingExternalTools = scanMissingExternalTools(config);
    const monorepoDrift = scanMonorepoDrift(cwd, config);
    // A declared preset that resolves to neither a local (.navori/presets/) nor
    // a bundled manifest renders the baseline AND warns — config points at
    // something unresolvable, same class as a missing plugin.
    const resolvedPreset = config.preset !== "custom" ? resolvePreset(config.preset, cwd) : null;
    const missingPreset =
      config.preset !== "custom" && resolvedPreset === null ? config.preset : null;
    // A local preset shadowing a bundled one of the same id: legal (it's how a
    // team overrides an official preset) but worth surfacing so it's not silent.
    const presetOverride =
      resolvedPreset?.source === "local" && presetExists(config.preset) ? config.preset : null;
    const missingPresetFiles = scanMissingPresetFiles(cwd, config);
    // Informational: a name like `temp-app` or `my-app` is almost always a
    // never-renamed scaffold (the package.json carried it through). Doesn't
    // break the render, so it's a warning, not an `ok`-flipping error.
    const placeholderName = isPlaceholderName(config.name) ? config.name : null;
    const report = {
      // Drift is informational ("update available"), not an error — don't
      // flip `ok` for it. Missing plugins, corrupted settings.json, missing
      // invariants and a phantom preset ARE errors: the next render will fail,
      // silently skip the file, or drop a load-bearing rule / preset extras.
      ok:
        missingPlugins.length === 0 &&
        corruptedSettings.length === 0 &&
        missingInvariants.length === 0 &&
        missingPreset === null &&
        missingPresetFiles.length === 0,
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
      orderReport,
      corruptedSettings,
      missingInvariants,
      missingExternalTools,
      monorepoDrift,
      missingPreset,
      presetOverride,
      missingPresetFiles,
      placeholderName,
    };

    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
      // JSON consumers (CI pipelines) need the same exit-code semantics as
      // the text output so a piped check ($navori doctor --json --strict)
      // fails the build the same way the human-readable run would.
      if (
        missingPlugins.length > 0 ||
        corruptedSettings.length > 0 ||
        missingInvariants.length > 0 ||
        missingPreset !== null ||
        missingPresetFiles.length > 0
      ) {
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

    if (missingPreset !== null) {
      p.log.warn(
        `Preset '${missingPreset}' declarado en config pero no existe (ni local en ` +
          `.navori/presets/${missingPreset}/ ni bundled) — el render cae al baseline (sin los ` +
          `extras del preset). Corre 'navori preset init ${missingPreset}', 'navori configure', ` +
          `o usa un preset válido / 'custom'.`,
      );
    }

    if (presetOverride) {
      p.log.warn(
        `Preset local '${presetOverride}' (.navori/presets/${presetOverride}/) sombrea el preset ` +
          `oficial del mismo nombre — se usa el local. Renómbralo si el override no es intencional.`,
      );
    }

    if (placeholderName) {
      p.log.warn(
        `El name '${placeholderName}' parece un placeholder de scaffold (probablemente heredado del ` +
          `package.json sin renombrar). Edita "name" en navori.config.json si no es el nombre real del repo.`,
      );
    }

    if (missingPresetFiles.length > 0) {
      const lines = missingPresetFiles.map(
        (f) => `  ${color.red(sym.fail)} ${accent(f.id)}  ${grey(`— falta ${f.path}`)}`,
      );
      p.log.warn(
        `Extras del preset '${config.preset}' sin archivo (${missingPresetFiles.length}) — el render ` +
          `fallará al leerlos; créalos o quítalos del manifest:\n${lines.join("\n")}`,
      );
    }

    // Project-local skills declared in config must have a file on disk — navori
    // indexes them but never writes their content, so a missing one is dead
    // weight in the index.
    const missingLocalSkills = (config.project?.localSkills ?? []).filter(
      (name) => !existsSync(join(cwd, ".claude/skills", `${name}.md`)),
    );
    if (missingLocalSkills.length > 0) {
      const lines = missingLocalSkills.map(
        (n) => `  ${color.red(sym.fail)} ${accent(n)}  ${grey(`— falta .claude/skills/${n}.md`)}`,
      );
      p.log.warn(
        `Skills project-local declarados sin archivo (${missingLocalSkills.length}) — crea el .md o quita el id de project.localSkills:\n${lines.join("\n")}`,
      );
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
          ? "corre 'navori sync' para resolver conflicts; 'navori render --apply' para actualizar versiones"
          : "corre 'navori render --apply' o 'navori sync'";
      p.log.warn(`Drift detectado (${drifts.length}) — ${hint}:\n${lines.join("\n")}`);
    }

    if (corruptedSettings.length > 0) {
      const lines = corruptedSettings.map(
        (c) => `  ${color.red(sym.fail)} ${accent(c.path)}  ${grey(`— JSON inválido: ${c.error}`)}`,
      );
      p.log.error(
        `Settings.json corrupto (${corruptedSettings.length}) — corre 'navori render --force --apply' para regenerar desde el bundle (el archivo actual se respalda):\n${lines.join("\n")}`,
      );
    }

    if (missingInvariants.length > 0) {
      const lines = missingInvariants.map(
        (m) => `  ${color.red(sym.fail)} ${accent(m.invariant)}  ${grey(`— declarado por ${m.source}`)}`,
      );
      p.log.error(
        `Invariantes ausentes en el output (${missingInvariants.length}) — una regla load-bearing desapareció; corre 'navori render --apply' o revisa el template:\n${lines.join("\n")}`,
      );
    }

    if (missingExternalTools.length > 0) {
      const lines = missingExternalTools.map((t) => {
        const how = t.install
          ? `${t.install}${t.postInstall ? ` && ${t.postInstall}` : ""}`
          : "instala la herramienta y reinicia Claude Code";
        return `  ${color.yellow(sym.update)} ${accent(t.pluginId)}  ${grey(`— falta '${t.binary}' en PATH; ${how}`)}`;
      });
      p.log.warn(
        `Plugins habilitados con herramienta externa no instalada (${missingExternalTools.length}) — ` +
          `su protocolo/scan referencia algo que no está disponible en esta máquina:\n${lines.join("\n")}`,
      );
    }

    if (monorepoDrift) {
      const lines: string[] = [];
      if (monorepoDrift.emptyDeclared) {
        lines.push(
          `  ${color.yellow(sym.update)} monorepo declarado pero workspaces[] vacío — corré 'navori scan' para poblarlo`,
        );
      }
      for (const path of monorepoDrift.added) {
        lines.push(`  ${color.yellow(sym.update)} ${path}  ${grey("— en disco, falta en config (corré 'navori scan')")}`);
      }
      for (const path of monorepoDrift.orphan) {
        lines.push(`  ${color.yellow(sym.update)} ${path}  ${grey("— en config, ausente en disco (quitalo del config)")}`);
      }
      if (lines.length > 0) {
        p.log.warn(`Monorepo desincronizado con el disco (${lines.length}):\n${lines.join("\n")}`);
      }
    }

    if (orderReport) {
      if (orderReport.interleaved) {
        p.log.warn(
          `Bloques managed de CLAUDE.md fuera del orden canónico — NO se pueden reordenar ` +
            `automáticamente porque hay texto tuyo entre bloques. Mueve ese texto arriba del ` +
            `primer bloque managed o abajo del último; luego corre 'navori render --apply'.\n` +
            `  orden actual:   ${orderReport.current.join(", ")}\n` +
            `  orden canónico: ${orderReport.expected.join(", ")}`,
        );
      } else {
        p.log.warn(
          `Bloques managed de CLAUDE.md fuera del orden canónico — corre 'navori render --apply' ` +
            `o 'navori sync' para reordenarlos (el primer bloque marca el centro de gravedad del ` +
            `harness).\n` +
            `  orden actual:   ${orderReport.current.join(", ")}\n` +
            `  orden canónico: ${orderReport.expected.join(", ")}`,
        );
      }
    }

    const nextSteps = suggestNextSteps({
      claudeMdExists: report.checks.claudeMdExists,
      missingPlugins,
      drifts,
      orderReport,
    });
    p.note(
      nextSteps.map((s) => `  ${color.cyan(sym.bullet)} ${s}`).join("\n"),
      "Próximos pasos",
    );

    const hasIssues =
      missingPlugins.length > 0 ||
      corruptedSettings.length > 0 ||
      missingInvariants.length > 0 ||
      missingPreset !== null ||
      missingPresetFiles.length > 0;
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

interface MissingInvariant {
  /** The load-bearing substring that should have been in the output. */
  invariant: string;
  /** Who declared it, e.g. "plugin:engram" or "preset:nextjs". */
  source: string;
}

const TEXT_EXTENSIONS = [".md", ".json", ".sh"];

/**
 * Extras a preset declares (managed/agents/skills/hooks) whose source file is
 * missing on disk. For a bundled preset these always exist; this catches a
 * LOCAL preset (.navori/presets/) whose manifest references a file the user
 * forgot to create — render would otherwise blow up on readFileSync.
 */
function scanMissingPresetFiles(
  cwd: string,
  config: NavoriConfig,
): Array<{ id: string; path: string }> {
  if (!config.preset || config.preset === "custom") return [];
  let loaded;
  try {
    loaded = loadPreset(config.preset, cwd);
  } catch {
    return []; // malformed preset surfaced via the render path
  }
  if (!loaded) return [];
  const { managed, agents, skills, hooks } = loaded.def.extras;
  const missing: Array<{ id: string; path: string }> = [];
  for (const e of [...managed, ...agents, ...skills, ...hooks]) {
    const abs = resolve(loaded.assetRoot, e.relPath);
    if (!existsSync(abs)) missing.push({ id: e.id, path: relative(cwd, abs) });
  }
  return missing;
}

interface MissingExternalTool {
  pluginId: string;
  binary: string;
  install: string | null;
  postInstall: string | null;
}

/**
 * Each enabled plugin may declare an `externalTool` (an MCP server / CLI it
 * depends on, e.g. engram, semgrep). Always-on plugins never pass through
 * `navori add`, so their `checkBinary`/`postInstall` never run — the protocol
 * ends up telling the agent to call tools (mem_save, mem_session_summary…) that
 * may not exist. Warn (non-fatal: the scan hooks self-skip and the protocol is
 * still correct once installed) with the platform install command. Issue #69.
 */
export function scanMissingExternalTools(config: NavoriConfig): MissingExternalTool[] {
  const missing: MissingExternalTool[] = [];
  const platform = process.platform;
  for (const [id, settings] of Object.entries(config.plugins ?? {})) {
    if (settings.enabled !== true) continue;
    try {
      const tool = loadPlugin(id).manifest.externalTool;
      if (!tool?.checkBinary || hasBinary(tool.checkBinary)) continue;
      missing.push({
        pluginId: id,
        binary: tool.checkBinary,
        install: tool.install?.[platform] ?? null,
        postInstall: tool.postInstall ?? null,
      });
    } catch {
      // Missing / broken plugin is reported via missingPlugins.
    }
  }
  return missing;
}

interface MonorepoDrift {
  /** Workspaces on disk not yet in config (run scan). */
  added: string[];
  /** Config workspaces whose directory is gone (prune config). */
  orphan: string[];
  /** monorepo declared but workspaces[] empty while dirs exist on disk. */
  emptyDeclared: boolean;
}

/**
 * doctor was blind to the monorepo (spec 0001 open-question #1): a config with
 * `workspaces: []` — or one that drifted from disk after an app was added /
 * removed — showed "all good" while the apps silently got no harness. Surface
 * the drift so the user runs `navori scan`. Issue #70.
 */
export function scanMonorepoDrift(cwd: string, config: NavoriConfig): MonorepoDrift | null {
  if (!config.monorepo) return null;
  const configured = config.monorepo.workspaces ?? [];
  let detected;
  try {
    detected = scanMonorepoWorkspaces(cwd);
  } catch {
    return null; // detection is best-effort; never fail doctor over it
  }
  const diff = diffWorkspaces(detected, configured);
  return {
    added: diff.added.map((d) => d.path),
    orphan: diff.orphan.map((o) => o.path),
    emptyDeclared: configured.length === 0 && detected.length > 0,
  };
}

/**
 * Spec 0003 §3.1.1 — each enabled plugin and the active preset may declare
 * `invariants[]`: load-bearing substrings that MUST survive into the rendered
 * output. We concatenate every rendered text file (CLAUDE.md + .claude/**) and
 * flag any declared invariant that no longer appears verbatim. Catches the
 * whole class of "a template refactor silently ate a load-bearing rule".
 *
 * Skipped when the repo has no rendered output yet — there is nothing to check
 * until the first `navori render --apply`.
 */
function scanMissingInvariants(cwd: string, config: NavoriConfig): MissingInvariant[] {
  const sources: Array<{ source: string; invariants: string[] }> = [];

  try {
    const loaded = loadPreset(config.preset, cwd);
    if (loaded && loaded.def.invariants.length > 0) {
      sources.push({ source: `preset:${loaded.def.id}`, invariants: loaded.def.invariants });
    }
  } catch {
    // A malformed preset is surfaced by the render path; nothing to check here.
  }

  for (const [id, settings] of Object.entries(config.plugins ?? {})) {
    if (settings.enabled !== true) continue;
    try {
      const plugin = loadPlugin(id);
      if (plugin.manifest.invariants.length > 0) {
        sources.push({ source: `plugin:${id}`, invariants: plugin.manifest.invariants });
      }
    } catch {
      // Missing / broken plugin is reported via missingPlugins.
    }
  }

  if (sources.length === 0) return [];

  const output = readRenderedText(cwd);
  if (output.trim() === "") return []; // nothing rendered yet

  const missing: MissingInvariant[] = [];
  for (const { source, invariants } of sources) {
    for (const inv of invariants) {
      if (!output.includes(inv)) missing.push({ invariant: inv, source });
    }
  }
  return missing;
}

/** Concatenate every rendered text file navori owns: CLAUDE.md + .claude/**. */
function readRenderedText(cwd: string): string {
  const parts: string[] = [];
  const claudeMd = join(cwd, "CLAUDE.md");
  if (existsSync(claudeMd)) {
    try {
      parts.push(readFileSync(claudeMd, "utf-8"));
    } catch {
      // unreadable — treat as absent
    }
  }
  const claudeDir = join(cwd, ".claude");
  if (existsSync(claudeDir)) collectText(claudeDir, parts);
  return parts.join("\n");
}

function collectText(dir: string, parts: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectText(abs, parts);
    } else if (entry.isFile() && TEXT_EXTENSIONS.some((e) => entry.name.endsWith(e))) {
      try {
        parts.push(readFileSync(abs, "utf-8"));
      } catch {
        // skip unreadable
      }
    }
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
