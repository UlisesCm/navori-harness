import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve, relative } from "node:path";
import { readConfig, ConfigError, type NavoriConfig } from "../lib/config.ts";
import { resolveHarnessPlan } from "../engines/shared/harness-plan.ts";
import { getCoreRoot } from "../lib/bundled-assets.ts";
import { isDowngrade } from "../lib/semver.ts";
import { isPlaceholderName } from "../lib/detect.ts";
import { loadPlugin } from "../lib/plugins.ts";
import { hasBinary } from "../lib/which.ts";
import { loadPreset, presetExists, resolvePreset } from "../lib/presets.ts";
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
  scanExcludedBlocks,
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
          console.log(
            JSON.stringify({
              ok: false,
              error: "config-invalid",
              message: err.message,
              issues: err.issues,
            }),
          );
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
    const malformedMarkers = scanMalformedMarkers(cwd);
    const missingExternalTools = scanMissingExternalTools(config);
    const missingOptionalTools = scanMissingOptionalTools();
    const monorepoDrift = scanMonorepoDrift(cwd, config);
    const workspaceLink = scanWorkspaceLink(cwd, config);
    // Legacy agent files (sdd-*/deep-auditor) superseded by a canonical navori
    // agent. Informational — navori never deletes the user's files, it just
    // surfaces the redundancy so the user can archive them.
    const legacyAgents = scanLegacyAgents(cwd, config);
    // Core managed blocks the repo opted out of (blocks.exclude). Always
    // surfaced so the exclusion never becomes silent config drift; unknown ids
    // (typos) warn but don't flip `ok` — they only no-op.
    const excludedBlocks = scanExcludedBlocks(config);
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
    const codexHealth = scanCodexHealth(cwd, config);
    const engineInventory = buildEngineInventory(config, cwd);
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
        missingPresetFiles.length === 0 &&
        codexHealth?.configMalformed !== true,
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
      malformedMarkers,
      missingExternalTools,
      missingOptionalTools,
      monorepoDrift,
      workspaceLink,
      missingPreset,
      presetOverride,
      missingPresetFiles,
      placeholderName,
      legacyAgents,
      excludedBlocks,
      codexHealth,
      engineInventory,
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
        missingPresetFiles.length > 0 ||
        codexHealth?.configMalformed === true
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

    // Excluded core blocks (blocks.exclude): always shown when present so the
    // opt-out is visible, never silent config drift. Unknown ids warn separately.
    if (excludedBlocks) {
      if (excludedBlocks.excluded.length > 0) {
        const lines = excludedBlocks.excluded.map(
          (id) => `  ${color.cyan(sym.bullet)} ${accent(id)}  ${grey(td.excludedBlockRow(id))}`,
        );
        p.note(lines.join("\n"), td.excludedBlocksTitle(excludedBlocks.excluded.length));
      }
      // A real core id that isn't excludable had no effect — the block still
      // renders. WARN so the user knows the opt-out was silently ineffective.
      if (excludedBlocks.nonExcludable.length > 0) {
        const lines = excludedBlocks.nonExcludable.map(
          (id) =>
            `  ${color.yellow(sym.update)} ${accent(id)}  ${grey(td.nonExcludableBlockRow(id))}`,
        );
        p.log.warn(td.nonExcludableBlocks(excludedBlocks.nonExcludable.length, lines.join("\n")));
      }
      if (excludedBlocks.unknown.length > 0) {
        const lines = excludedBlocks.unknown.map(
          (id) =>
            `  ${color.yellow(sym.update)} ${accent(id)}  ${grey(td.unknownExcludedBlockRow(id))}`,
        );
        p.log.warn(td.unknownExcludedBlocks(excludedBlocks.unknown.length, lines.join("\n")));
      }
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
      const lines = missingPlugins.map(
        (m) => `  ${color.red(sym.fail)} ${m.id}  ${grey(`— ${m.reason}`)}`,
      );
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
        (c) =>
          `  ${color.red(sym.fail)} ${accent(c.path)}  ${grey(td.corruptedSettingsRow(c.error))}`,
      );
      p.log.error(td.corruptedSettings(corruptedSettings.length, lines.join("\n")));
    }

    if (missingInvariants.length > 0) {
      const lines = missingInvariants.map(
        (m) =>
          `  ${color.red(sym.fail)} ${accent(m.invariant)}  ${grey(td.missingInvariantRow(m.source))}`,
      );
      p.log.error(td.missingInvariants(missingInvariants.length, lines.join("\n")));
    }

    if (malformedMarkers.length > 0) {
      const lines = malformedMarkers.map(
        (m) =>
          `  ${color.yellow(sym.update)} ${accent(`${m.filePath}:${m.line}`)}  ${grey(`— ${m.snippet}`)}`,
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

    if (missingOptionalTools.length > 0) {
      const lines = missingOptionalTools.map(
        (tool) =>
          `  ${color.yellow(sym.update)} ${accent(tool.id)}  ${grey(
            td.optionalToolRow(
              tool.binaries.map((binary) => `'${binary}'`).join(" / "),
              tool.install,
            ),
          )}`,
      );
      p.log.warn(td.optionalTools(missingOptionalTools.length, lines.join("\n")));
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
    p.note(nextSteps.map((s) => `  ${color.cyan(sym.bullet)} ${s}`).join("\n"), td.nextStepsTitle);

    if (codexHealth) {
      const cx: string[] = [];
      if (codexHealth.configMalformed) {
        cx.push(
          `  ${color.red(sym.fail)} .codex/config.toml: bloque managed desbalanceado (corre 'navori render --apply')`,
        );
      }
      for (const h of codexHealth.hooksNotExecutable) {
        cx.push(
          `  ${color.yellow(sym.update)} ${h} sin bit ejecutable — Codex no lo dispara (chmod +x)`,
        );
      }
      if (codexHealth.versionWarning) {
        cx.push(
          `  ${color.yellow(sym.update)} codex ${codexHealth.versionWarning.found} < ${codexHealth.versionWarning.min} requerido`,
        );
      }
      if (codexHealth.hookTrustHint) {
        cx.push(
          `  ${color.cyan(sym.bullet)} Codex solo dispara hooks en repos confiables: revísalos y autorízalos con '/hooks'`,
        );
      }
      if (codexHealth.guardNotVersioned.length > 0) {
        cx.push(
          `  ${color.yellow(sym.update)} ${codexHealth.guardNotVersioned.join(", ")} sin versionar en git — en una sesión Codex abierta dentro de un git worktree el guard no corre; versiona '.codex/hooks/' (o '.codex/')`,
        );
      }
      if (cx.length > 0) p.note(cx.join("\n"), "Codex");
    }

    const hasIssues =
      missingPlugins.length > 0 ||
      corruptedSettings.length > 0 ||
      missingInvariants.length > 0 ||
      missingPreset !== null ||
      missingPresetFiles.length > 0 ||
      codexHealth?.configMalformed === true;
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

export interface MissingOptionalTool {
  id: string;
  binaries: string[];
  install: string;
}

/**
 * Optional precision tools improve the generated harness but never gate it.
 * structural-search supports both official CLI names and falls back to Grep,
 * so doctor only warns when neither binary is available.
 */
export function scanMissingOptionalTools(): MissingOptionalTool[] {
  const binaries = ["sg", "ast-grep"];
  if (binaries.some((binary) => hasBinary(binary))) return [];
  return [
    {
      id: "structural-search",
      binaries,
      install: "npm install --global @ast-grep/cli",
    },
  ];
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
    return {
      kind: "path-mismatch",
      workspace: name,
      repoName: byName.name,
      registeredPath: byName.path,
    };
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
 * output. We concatenate the native outputs for every configured engine and
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

  const output = readRenderedText(cwd, config);
  if (output.trim() === "") return []; // nothing rendered yet

  const missing: MissingInvariant[] = [];
  for (const { source, invariants } of sources) {
    for (const inv of invariants) {
      if (!output.includes(inv)) missing.push({ invariant: inv, source });
    }
  }
  return missing;
}

/** Concatenate the rendered text owned by the configured engines only. */
function readRenderedText(cwd: string, config: NavoriConfig): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  const addFile = (path: string): void => {
    if (seen.has(path) || !existsSync(path)) return;
    seen.add(path);
    try {
      parts.push(readFileSync(path, "utf-8"));
    } catch {
      // unreadable — treat as absent
    }
  };
  const addDir = (path: string): void => {
    if (seen.has(path) || !existsSync(path)) return;
    seen.add(path);
    collectText(path, parts);
  };

  for (const engine of config.engines ?? ["claude"]) {
    if (engine === "claude") {
      addFile(join(cwd, "CLAUDE.md"));
      addDir(join(cwd, ".claude"));
    } else if (engine === "codex") {
      addFile(join(cwd, "AGENTS.md"));
      addDir(join(cwd, ".agents"));
      addDir(join(cwd, ".codex"));
    } else if (engine === "agents-md") {
      addFile(join(cwd, "AGENTS.md"));
    } else if (engine === "cursor") {
      addDir(join(cwd, ".cursor"));
    } else if (engine === "copilot") {
      addFile(join(cwd, ".github/copilot-instructions.md"));
    }
  }

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

const MIN_CODEX_VERSION = "0.145.0";

export interface CodexHealth {
  /** `.codex/config.toml` has an unbalanced/malformed navori managed block. */
  configMalformed: boolean;
  /** Rendered hook scripts that lack the executable bit (Codex won't fire them). */
  hooksNotExecutable: string[];
  /** Codex CLI in PATH but older than the minimum supported version. */
  versionWarning: { found: string; min: string } | null;
  /** Whether to remind the user Codex needs the hooks trusted (`/hooks`). */
  hookTrustHint: boolean;
  /**
   * Rendered hook scripts not tracked by git. An untracked hook is absent from
   * a git worktree checkout, so a Codex session launched inside a worktree
   * loads no project `.codex/config.toml` and the destructive guard silently
   * never fires. Empty outside a git work tree (no worktrees ⇒ no exposure).
   */
  guardNotVersioned: string[];
}

/**
 * Codex-specific health (Spec 0007 M5). Only meaningful when `codex` is a
 * configured engine and its tree was rendered. Returns null otherwise so the
 * report omits the section entirely.
 *
 * (a) config.toml managed block is structurally intact — a full TOML parse
 *     would need a new dependency; the real failure mode is a hand-broken
 *     managed block, which the marker-balance check catches.
 * (b) hooks carry +x (Codex silently won't run a non-executable hook).
 * (c) `codex --version` ≥ 0.145.0 when the binary is in PATH (warning only).
 * (d) hook-trust reminder — the most treacherous failure: a rendered harness
 *     that looks active but never fires because Codex hasn't trusted `.codex/`.
 * (e) hook scripts tracked by git — an untracked guard is missing from a git
 *     worktree checkout, so a Codex session launched inside a worktree loads
 *     no project hooks and the guard silently never fires.
 */
export function scanCodexHealth(cwd: string, config: NavoriConfig): CodexHealth | null {
  if (!config.engines.includes("codex")) return null;
  const codexDir = join(cwd, ".codex");
  if (!existsSync(codexDir)) return null;

  // (a) config.toml managed-block balance.
  let configMalformed = false;
  const tomlPath = join(codexDir, "config.toml");
  if (existsSync(tomlPath)) {
    const body = readFileSync(tomlPath, "utf-8");
    const starts = (body.match(/navori:managed start/g) ?? []).length;
    const ends = (body.match(/navori:managed end/g) ?? []).length;
    configMalformed = starts !== ends;
  }

  // (b) hooks executable bit.
  const hooksNotExecutable: string[] = [];
  const hooksDir = join(codexDir, "hooks");
  if (existsSync(hooksDir)) {
    for (const entry of readdirSync(hooksDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".sh")) continue;
      try {
        const mode = statSync(join(hooksDir, entry.name)).mode;
        if ((mode & 0o111) === 0) hooksNotExecutable.push(`.codex/hooks/${entry.name}`);
      } catch {
        // Unreadable — skip rather than guess.
      }
    }
  }

  // (c) codex --version (best effort; absent binary is not an error).
  let versionWarning: CodexHealth["versionWarning"] = null;
  try {
    const raw = execFileSync("codex", ["--version"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const found = raw.match(/\d+\.\d+\.\d+/)?.[0];
    if (found && isDowngrade(found, MIN_CODEX_VERSION)) {
      versionWarning = { found, min: MIN_CODEX_VERSION };
    }
  } catch {
    // Codex not in PATH — nothing to check.
  }

  // (e) hook scripts tracked by git. Only meaningful inside a git work tree:
  // without git there are no worktrees, so no exposure and nothing to warn.
  const guardNotVersioned: string[] = [];
  if (existsSync(hooksDir) && isGitWorkTree(cwd)) {
    for (const entry of readdirSync(hooksDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".sh")) continue;
      const rel = `.codex/hooks/${entry.name}`;
      if (!isTrackedByGit(cwd, rel)) guardNotVersioned.push(rel);
    }
  }

  return {
    configMalformed,
    hooksNotExecutable,
    versionWarning,
    hookTrustHint: existsSync(hooksDir),
    guardNotVersioned,
  };
}

/** True when `cwd` sits inside a git work tree (linked worktrees included). */
function isGitWorkTree(cwd: string): boolean {
  try {
    const out = execFileSync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() === "true";
  } catch {
    return false;
  }
}

/** True when `relPath` (relative to `cwd`) is tracked by git. */
function isTrackedByGit(cwd: string, relPath: string): boolean {
  try {
    execFileSync("git", ["-C", cwd, "ls-files", "--error-unmatch", relPath], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

export interface EngineInventory {
  agents: string[];
  skills: string[];
  hooks: string[];
}

/**
 * Per-engine harness inventory (Spec 0007 M8) for `doctor --json`, so a repo's
 * CI can assert Claude↔Codex parity after `render --all`. Only the disk engines
 * (claude, codex) carry a distinct agents/skills/hooks set; prose engines are
 * omitted. Claude includes the leader; Codex embodies it in the main thread.
 */
export function buildEngineInventory(
  config: NavoriConfig,
  cwd: string,
): Record<string, EngineInventory> {
  const diskEngines = config.engines.filter((e) => e === "claude" || e === "codex");
  if (diskEngines.length === 0) return {};
  const coreAssets = resolve(getCoreRoot(), "core-assets");
  let preset: ReturnType<typeof loadPreset> = null;
  if (config.preset && config.preset !== "custom") {
    try {
      preset = loadPreset(config.preset, cwd);
    } catch {
      preset = null; // a broken preset is surfaced elsewhere; inventory stays core-only
    }
  }
  const out: Record<string, EngineInventory> = {};
  for (const engine of diskEngines) {
    const plan = resolveHarnessPlan(config, coreAssets, preset, {
      includeLeader: engine === "claude",
    });
    out[engine] = {
      agents: plan.agents.map((a) => a.id).sort(),
      skills: plan.skills.map((s) => s.id).sort(),
      hooks: plan.hooks.map((h) => h.id).sort(),
    };
  }
  return out;
}
