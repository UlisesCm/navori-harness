import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { existsSync, readFileSync, readdirSync, type Dirent } from "node:fs";
import { join, resolve, relative } from "node:path";
import { readConfig, ConfigError, type NavoriConfig } from "../lib/config.ts";
import { isPlaceholderName } from "../lib/detect.ts";
import { loadPlugin } from "../lib/plugins.ts";
import { hasBinary } from "../lib/which.ts";
import { loadPreset, presetExists, resolvePreset } from "../lib/presets.ts";
import { loadFeature, featureExists } from "../lib/features.ts";
import { activeSkillIds, bundledSkillIds } from "../lib/skill-catalog.ts";
import { resolveLocalSkillPath } from "../lib/skill-meta.ts";
import { scanMonorepoWorkspaces, diffWorkspaces } from "../lib/scan.ts";
import { loadWorkspace, canonicalPath } from "../lib/workspace.ts";
import {
  listMarkers,
  collectMissingPlugins,
  scanManagedDrift,
  scanManagedOrder,
  scanMalformedMarkers,
  scanLegacyAgents,
  suggestNextSteps,
} from "../lib/health.ts";
import { check, dim as grey, color, sym, brand, kv, accent } from "../lib/style.ts";
import { tc, resolveLang, DEFAULT_LANG } from "../lib/i18n.ts";

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
        p.cancel(tc(DEFAULT_LANG).common.dirNotFound(cwd));
      }
      process.exit(1);
    }

    if (!existsSync(configPath)) {
      if (args.json) {
        console.log(JSON.stringify({ ok: false, error: "config-missing", configPath }));
      } else {
        p.cancel(tc(DEFAULT_LANG).doctor.noConfigRunInit(configPath));
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
    const unknownFeatures = scanUnknownFeatures(cwd, config);
    const featureExternalSkills = scanFeatureExternalSkills(cwd, config);
    const malformedMarkers = scanMalformedMarkers(cwd);
    const missingExternalTools = scanMissingExternalTools(config);
    const monorepoDrift = scanMonorepoDrift(cwd, config);
    const workspaceLink = scanWorkspaceLink(cwd, config);
    // Legacy agent files (sdd-*/deep-auditor) superseded by a canonical navori
    // agent. Informational — navori never deletes the user's files, it just
    // surfaces the redundancy so the user can archive them.
    const legacyAgents = scanLegacyAgents(cwd, config);
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
      unknownFeatures,
      featureExternalSkills,
      drifts,
      orderReport,
      corruptedSettings,
      missingInvariants,
      malformedMarkers,
      missingExternalTools,
      monorepoDrift,
      workspaceLink,
      missingPreset,
      presetOverride,
      missingPresetFiles,
      placeholderName,
      legacyAgents,
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

    const lang = resolveLang(config.language);
    const td = tc(lang).doctor;

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
      td.configNoteTitle(grey(configPath)),
    );

    p.note(
      [
        `  ${check(report.checks.claudeMdExists)} CLAUDE.md`,
        `  ${check(report.checks.agentsMdExists)} AGENTS.md`,
        `  ${check(report.checks.claudeDirExists)} .claude/`,
        `  ${check(report.checks.progressDirExists)} ${config.progress?.dir ?? "progress"}/`,
      ].join("\n"),
      td.fsChecksTitle,
    );

    if (markers.length > 0) {
      const lines = markers.map((m) => {
        const ver = m.version ? grey(` v${m.version}`) : grey(` ${td.noVersion}`);
        const src = m.source ?? grey(td.unknownSource);
        return `  ${color.cyan(sym.bullet)} ${accent(m.id)}  ${grey("←")}  ${src}${ver}`;
      });
      p.note(lines.join("\n"), td.managedBlocksTitle(markers.length));
    }

    // Skill → agent assignments report (effective: plugin recommendation + config overrides)
    const assignments = collectAssignments(config);
    if (assignments.length > 0) {
      const lines = assignments.map((a) => {
        const override = a.override ? `  ${grey(td.overridden)}` : "";
        return `  ${color.cyan(sym.bullet)} ${accent(a.id)}  ${grey("→")}  ${a.agent}${override}`;
      });
      p.note(lines.join("\n"), td.assignmentsTitle(assignments.length));
    }

    if (missingPlugins.length > 0) {
      const lines = missingPlugins.map((m) => `  ${color.red(sym.fail)} ${m.id}  ${grey(`— ${m.reason}`)}`);
      p.log.warn(td.missingPlugins(missingPlugins.length, lines.join("\n")));
    }

    if (missingPreset !== null) {
      p.log.warn(td.missingPreset(missingPreset));
    }

    if (presetOverride) {
      p.log.warn(td.presetOverride(presetOverride));
    }

    if (placeholderName) {
      p.log.warn(td.placeholderName(placeholderName));
    }

    if (missingPresetFiles.length > 0) {
      const lines = missingPresetFiles.map(
        (f) => `  ${color.red(sym.fail)} ${accent(f.id)}  ${grey(td.missingPresetFileRow(f.path))}`,
      );
      p.log.warn(td.missingPresetFiles(config.preset, missingPresetFiles.length, lines.join("\n")));
    }

    // Project-local skills declared in config must have a file on disk — navori
    // indexes them but never writes their content, so a missing one is dead
    // weight in the index.
    const missingLocalSkills = (config.project?.localSkills ?? []).filter(
      (name) => resolveLocalSkillPath(cwd, name) === null,
    );
    if (missingLocalSkills.length > 0) {
      const lines = missingLocalSkills.map(
        (n) => `  ${color.red(sym.fail)} ${accent(n)}  ${grey(td.missingLocalSkillRow(n))}`,
      );
      p.log.warn(td.missingLocalSkills(missingLocalSkills.length, lines.join("\n")));
    }

    // Unknown feature ids: declared in config.features but no bundle resolves.
    // Warning (render skips them; the harness still works), not ok-flipping.
    if (unknownFeatures.length > 0) {
      const lines = unknownFeatures.map((id) => `  ${color.red(sym.fail)} ${accent(id)}`);
      p.log.warn(td.unknownFeatures(unknownFeatures.length, lines.join("\n")));
    }

    // Features referencing skills not present in this repo, split into two
    // buckets: truly-external (not bundled at all — a user global or external
    // CLI) as a warning, and bundled-under-an-inactive-preset as a softer note.
    // Neither flips `ok`.
    const trulyExternal = featureExternalSkills.filter((f) => f.external.length > 0);
    if (trulyExternal.length > 0) {
      const lines = trulyExternal.map(
        (f) => `  ${color.yellow(sym.update)} ${accent(f.featureId)}  ${grey(`→ ${f.external.join(", ")}`)}`,
      );
      p.log.warn(td.featureExternalSkills(trulyExternal.length, lines.join("\n")));
    }
    const inactivePresetSkills = featureExternalSkills.filter((f) => f.inactivePreset.length > 0);
    if (inactivePresetSkills.length > 0) {
      const lines = inactivePresetSkills.map(
        (f) => `  ${grey(sym.bullet)} ${accent(f.featureId)}  ${grey(`→ ${f.inactivePreset.join(", ")}`)}`,
      );
      p.log.info(td.featureInactivePresetSkills(inactivePresetSkills.length, lines.join("\n")));
    }

    if (drifts.length > 0) {
      const lines = drifts.map((d) => {
        if (d.kind === "content") {
          return `  ${color.red(sym.conflict)} ${accent(`${d.filePath}:${d.markerId}`)}  ${grey(`hash ${d.expectedHash} ≠ ${d.actualHash}`)}  ${grey(td.driftContentRow(d.source))}`;
        }
        return `  ${color.yellow(sym.update)} ${accent(`${d.filePath}:${d.markerId}`)}  ${grey(`${d.fromVersion} → ${d.toVersion}`)}  ${grey(td.driftVersionSuffix(d.source))}`;
      });
      const hint = drifts.some((d) => d.kind === "content")
        ? td.driftHintContent
        : td.driftHintVersion;
      p.log.warn(td.drift(drifts.length, hint, lines.join("\n")));
    }

    if (corruptedSettings.length > 0) {
      const lines = corruptedSettings.map(
        (c) => `  ${color.red(sym.fail)} ${accent(c.path)}  ${grey(td.corruptedSettingsRow(c.error))}`,
      );
      p.log.error(td.corruptedSettings(corruptedSettings.length, lines.join("\n")));
    }

    if (missingInvariants.length > 0) {
      const lines = missingInvariants.map(
        (m) => `  ${color.red(sym.fail)} ${accent(m.invariant)}  ${grey(td.missingInvariantRow(m.source))}`,
      );
      p.log.error(td.missingInvariants(missingInvariants.length, lines.join("\n")));
    }

    if (malformedMarkers.length > 0) {
      const lines = malformedMarkers.map(
        (m) => `  ${color.yellow(sym.update)} ${accent(`${m.filePath}:${m.line}`)}  ${grey(`— ${m.snippet}`)}`,
      );
      p.log.warn(td.malformedMarkers(malformedMarkers.length, lines.join("\n")));
    }

    if (legacyAgents.length > 0) {
      const lines = legacyAgents.map(
        (l) =>
          `  ${color.yellow(sym.update)} ${accent(`.claude/agents/${l.legacyName}.md`)}  ${grey(td.legacyAgentRow(l.canonical))}`,
      );
      p.log.warn(td.legacyAgents(legacyAgents.length, lines.join("\n")));
    }

    if (missingExternalTools.length > 0) {
      const lines = missingExternalTools.map((t) => {
        const how = t.install
          ? `${t.install}${t.postInstall ? ` && ${t.postInstall}` : ""}`
          : td.externalToolFallbackHow;
        return `  ${color.yellow(sym.update)} ${accent(t.pluginId)}  ${grey(td.externalToolRow(t.binary, how))}`;
      });
      p.log.warn(td.externalTools(missingExternalTools.length, lines.join("\n")));
    }

    if (monorepoDrift) {
      const lines: string[] = [];
      if (monorepoDrift.emptyDeclared) {
        lines.push(`  ${color.yellow(sym.update)} ${td.monorepoEmptyDeclared}`);
      }
      for (const path of monorepoDrift.added) {
        lines.push(`  ${color.yellow(sym.update)} ${path}  ${grey(td.monorepoAddedRow)}`);
      }
      for (const path of monorepoDrift.orphan) {
        lines.push(`  ${color.yellow(sym.update)} ${path}  ${grey(td.monorepoOrphanRow)}`);
      }
      if (lines.length > 0) {
        p.log.warn(td.monorepoDrift(lines.length, lines.join("\n")));
      }
    }

    if (workspaceLink) {
      p.log.warn(formatWorkspaceLinkWarning(workspaceLink, lang));
    }

    if (orderReport) {
      const spotlight = orderReport.misplacedFirst
        ? td.orderSpotlight(
            orderReport.misplacedFirst.id,
            orderReport.misplacedFirst.currentPos,
            orderReport.misplacedFirst.total,
          )
        : "";
      const current = orderReport.current.join(", ");
      const expected = orderReport.expected.join(", ");
      p.log.warn(
        orderReport.interleaved
          ? td.orderInterleaved(current, expected, spotlight)
          : td.orderReorderable(current, expected, spotlight),
      );
    }

    const nextSteps = suggestNextSteps({
      claudeMdExists: report.checks.claudeMdExists,
      missingPlugins,
      drifts,
      orderReport,
      legacyAgents,
    });
    p.note(
      nextSteps.map((s) => `  ${color.cyan(sym.bullet)} ${s}`).join("\n"),
      td.nextStepsTitle,
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
        ? color.red(td.outroIssues)
        : strictFail
          ? color.yellow(td.outroDriftStrict)
          : color.green(td.outroOk),
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

/**
 * Feature ids declared in `config.features` that resolve to no bundle (neither
 * a local `.navori/features/<id>/` nor a bundled `core-assets/features/<id>/`).
 * The render silently skips them, so surface as a warning (spec 0004 §4).
 */
export function scanUnknownFeatures(cwd: string, config: NavoriConfig): string[] {
  return (config.features ?? []).filter((id) => !featureExists(id, cwd));
}

export interface FeatureExternalSkills {
  featureId: string;
  /** Phase skill ids navori does NOT bundle under ANY preset — truly external
   * (a user global under `~/.claude/skills/`, or one from an external CLI). */
  external: string[];
  /** Phase skill ids navori DOES bundle, but only under a preset that isn't the
   * active one — present once that preset is activated (or added as a local skill). */
  inactivePreset: string[];
}

/**
 * For each active feature, classify its phase `skills` ids that aren't already
 * materialized for this repo into two buckets (spec 0004 §4):
 *   - `external`       — not bundled by navori under ANY preset. WARNING.
 *   - `inactivePreset` — bundled by navori, but under a preset that isn't active.
 *                        Softer note: activate that preset or add it as a local skill.
 * Neither is an error — a feature composes existing skills by id and MAY point at
 * ids this repo doesn't currently ship.
 */
export function scanFeatureExternalSkills(cwd: string, config: NavoriConfig): FeatureExternalSkills[] {
  const active = config.features ?? [];
  if (active.length === 0) return [];
  const activeCatalog = activeSkillIds(config, cwd);
  const bundledCatalog = bundledSkillIds(config, cwd);
  const out: FeatureExternalSkills[] = [];
  for (const id of active) {
    let loaded;
    try {
      loaded = loadFeature(id, cwd);
    } catch {
      continue; // malformed feature — surfaced via the render/unknown path
    }
    if (!loaded) continue; // unknown — surfaced by scanUnknownFeatures
    const external = new Set<string>();
    const inactivePreset = new Set<string>();
    for (const phase of loaded.manifest.phases) {
      for (const skill of phase.skills) {
        if (activeCatalog.has(skill)) continue; // already present here
        if (bundledCatalog.has(skill)) inactivePreset.add(skill);
        else external.add(skill);
      }
    }
    if (external.size > 0 || inactivePreset.size > 0) {
      out.push({ featureId: id, external: [...external], inactivePreset: [...inactivePreset] });
    }
  }
  return out;
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

export type WorkspaceLinkIssue =
  | { kind: "workspace-missing"; workspace: string }
  | { kind: "repo-not-registered"; workspace: string }
  | { kind: "path-mismatch"; workspace: string; repoName: string; registeredPath: string };

/**
 * The workspace registry (~/.navori/workspaces/) is machine-local: it never
 * travels with the repo, while `workspace` in navori.config.json does. A
 * teammate cloning the repo inherits a dangling reference — or a manifest
 * whose repos[] still holds another machine's paths — and nothing used to
 * tell them. Warning-level: render/sync work fine without the registry; only
 * workspace commands (tickets, `workspace render`) need it. Issue #76.
 */
export function scanWorkspaceLink(cwd: string, config: NavoriConfig): WorkspaceLinkIssue | null {
  const name = config.workspace;
  if (!name) return null;
  let ws;
  try {
    ws = loadWorkspace(name);
  } catch {
    // Unreadable/invalid manifest ≈ unusable registry: same remediation.
    return { kind: "workspace-missing", workspace: name };
  }
  if (!ws) return { kind: "workspace-missing", workspace: name };
  const here = canonicalPath(cwd);
  if (ws.repos.some((r) => canonicalPath(r.path) === here)) return null;
  const byName = ws.repos.find((r) => r.name === config.name);
  if (byName) {
    return { kind: "path-mismatch", workspace: name, repoName: byName.name, registeredPath: byName.path };
  }
  return { kind: "repo-not-registered", workspace: name };
}

function formatWorkspaceLinkWarning(issue: WorkspaceLinkIssue, lang = DEFAULT_LANG): string {
  const td = tc(lang).doctor;
  switch (issue.kind) {
    case "workspace-missing":
      return td.wsLinkMissing(issue.workspace);
    case "repo-not-registered":
      return td.wsLinkNotRegistered(issue.workspace);
    case "path-mismatch":
      return td.wsLinkPathMismatch(issue.repoName, issue.workspace, issue.registeredPath);
  }
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

  // Active features declare invariants too (e.g. phase ids that must survive the
  // render) — same verbatim-substring contract. Spec 0004 §4.
  for (const id of config.features ?? []) {
    try {
      const loaded = loadFeature(id, cwd);
      if (loaded && loaded.manifest.invariants.length > 0) {
        sources.push({ source: `feature:${id}`, invariants: loaded.manifest.invariants });
      }
    } catch {
      // Malformed feature is surfaced elsewhere; nothing to check here.
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
