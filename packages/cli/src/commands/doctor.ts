import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join, resolve, relative } from "node:path";
import { readConfig, ConfigError, type NavoriConfig } from "../lib/config.ts";
import { resolveHarnessPlan } from "../engines/shared/harness-plan.ts";
import { CLAUDE_COMPUTED_BLOCK_IDS } from "../engines/claude/index.ts";
import { getCoreRoot } from "../lib/bundled-assets.ts";
import { isDowngrade } from "../lib/semver.ts";
import { isPlaceholderName } from "../lib/detect.ts";
import { loadPlugin, loadEnabledPlugins } from "../lib/plugins.ts";
import { effectiveConfigForWorkspace } from "../lib/monorepo.ts";
import { hasBinary } from "../lib/which.ts";
import { loadPreset, presetExists, resolvePreset } from "../lib/presets.ts";
import { resolveLocalSkillPath } from "../lib/skill-meta.ts";
import { unknownLibraries } from "../lib/library-skills.ts";
import { EPHEMERAL_HARNESS_PATHS } from "../engines/shared/ephemeral-paths.ts";
import { scanGitignoreHarness } from "../engines/shared/gitignore-harness.ts";
import { scanMonorepoWorkspaces, diffWorkspaces } from "../lib/scan.ts";
import { loadWorkspace, canonicalPath } from "../lib/workspace.ts";
import { scanWorkspaceDrift } from "../lib/workspace-drift.ts";
import { scanQualityGateReadiness } from "../lib/gate-readiness.ts";
import { scanEmptyUserSections } from "../lib/skill-user-section.ts";
import { scanInterpolationArtifacts } from "../lib/interpolation-artifacts.ts";
import { scanDiskUsage, humanBytes } from "../lib/disk-usage.ts";
import {
  listMarkers,
  collectMissingPlugins,
  scanManagedDrift,
  scanManagedOrder,
  scanMalformedMarkers,
  scanLegacyAgents,
  scanExcludedBlocks,
  scanOrphanedEngineOutputs,
  suggestNextSteps,
  ENGINE_OUTPUTS,
  PLUGIN_BLOCK_ENGINES,
  scanDuplicateMarkers,
  type MissingPlugin,
  type DuplicateMarker,
} from "../lib/health.ts";
import { check, dim as grey, color, sym, brand, kv, accent } from "../lib/style.ts";
import { tc, resolveLang, DEFAULT_LANG } from "../lib/i18n.ts";

/**
 * Rows printed for the interpolation-artifact warning (#440) before it collapses
 * into "… and N more". A repo with no `qualityGate` publishes the soft fallback
 * 28 times (measured on a bare `init --recommended`; see lib/recommended.ts),
 * and a 28-line warning is exactly the kind of wall people learn to scroll past.
 */
const MAX_ARTIFACT_ROWS = 10;

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
    // The health verdict — every `ok`-flipping check in one place, shared with
    // `status` so the two commands can't disagree about the same repo (#244).
    const verdict = computeHealthVerdict(cwd, config);
    const {
      missingPlugins,
      corruptedSettings,
      missingInvariants,
      resolvedPreset,
      missingPreset,
      missingPresetFiles,
      codexHealth,
      duplicateMarkers,
    } = verdict;
    const drifts = scanManagedDrift(cwd, config);
    const orderReport = scanManagedOrder(cwd, config, CLAUDE_COMPUTED_BLOCK_IDS);
    const malformedMarkers = scanMalformedMarkers(cwd, config);
    const missingExternalTools = scanMissingExternalTools(config);
    const missingOptionalTools = scanMissingOptionalTools();
    const monorepoDrift = scanMonorepoDrift(cwd, config);
    const workspaceLink = scanWorkspaceLink(cwd, config);
    // #368: the gate the whole pipeline leans on, checked statically — a gate
    // that can't run makes three phases of the intake unreachable, and today
    // nothing notices until an implementer hits it mid-task.
    const gateReadiness = scanQualityGateReadiness(cwd, config);
    // #369: an installed skill whose repo-specific half is still the template
    // costs a read and buys a false sense of coverage.
    const emptyUserSections = scanEmptyUserSections(cwd, [
      ".claude/skills",
      ...(config.engines.includes("codex") ? [".agents/skills"] : []),
    ]);
    // #440: interpolation artifacts published in the rendered tree. `render`
    // rewrites the managed zone only, so a token the USER zone inherited from an
    // interpolator bug is frozen there — fixing the interpolator never reaches an
    // already-onboarded repo. Warning-level: it never flips `ok`.
    const interpolationArtifacts = scanInterpolationArtifacts(cwd, config);
    // #393: the two directories that grow with no owner — ~/.navori/backups
    // (bounded only by prune-on-write) and .claude/worktrees (bounded by
    // nobody). Two `du`s so growth is visible before the disk fills; doctor
    // reports and suggests the cleanup command, it never deletes.
    const diskUsage = scanDiskUsage(cwd);
    // Referenced hook scripts (.claude/scripts|hooks) that are missing or lost
    // their exec bit — the hook then breaks/no-ops silently on every Bash (#213).
    const claudeHookScripts = scanClaudeHookScripts(cwd, config);
    // Legacy agent files (sdd-*/deep-auditor) superseded by a canonical navori
    // agent. Informational — navori never deletes the user's files, it just
    // surfaces the redundancy so the user can archive them.
    const legacyAgents = scanLegacyAgents(cwd, config);
    // Core managed blocks the repo opted out of (blocks.exclude). Always
    // surfaced so the exclusion never becomes silent config drift; unknown ids
    // (typos) warn but don't flip `ok` — they only no-op.
    const excludedBlocks = scanExcludedBlocks(config);
    // A local preset shadowing a bundled one of the same id: legal (it's how a
    // team overrides an official preset) but worth surfacing so it's not silent.
    const presetOverride =
      resolvedPreset?.source === "local" && presetExists(config.preset) ? config.preset : null;
    const codegraphHealth = scanCodegraphHealth(cwd, config);
    // Harness `.gitignore` block drift (#313). Null in mode "off" — doctor must
    // not evaluate `.gitignore` at all then (R8/R10).
    const gitignoreHealth = scanGitignoreHarness(cwd, config);
    // The other half of #313: what MUST be versioned isn't ignored (specs/) and
    // what's ephemeral is (.claude/progress|worktrees). Null outside git. #325.
    const gitHygiene = scanGitHygiene(cwd, config);
    // Config drift against the workspace — its declared defaults and, above all,
    // the mode of its sibling repos. Informational, never auto-applied. #326.
    const workspaceDrift = scanWorkspaceDrift(cwd, config);
    const engineInventory = buildEngineInventory(config, cwd);
    // Informational: a name like `temp-app` or `my-app` is almost always a
    // never-renamed scaffold (the package.json carried it through). Doesn't
    // break the render, so it's a warning, not an `ok`-flipping error.
    const placeholderName = isPlaceholderName(config.name) ? config.name : null;
    // Informational: config.name doesn't match the repo's directory — usually a
    // harness copied from another repo whose name was never updated. Skipped
    // when the name is already a placeholder (warned above) so the hints don't
    // double up. Never flips `ok`. #315.
    const nameMismatch = scanNameMismatch(cwd, config);
    // Outputs left behind by an engine no longer in config.engines[] (e.g. a
    // stale AGENTS.md/.codex after narrowing to claude). Informational — never
    // flips `ok`; `render --prune` removes them. #312.
    const orphanedEngineOutputs = scanOrphanedEngineOutputs(cwd, config);
    // AGENTS.md is only a first-class filesystem check when an engine that emits
    // it is configured; otherwise a leftover file is surfaced as an orphan below
    // instead of a bare ✓, which contradicted the drift/orphan report (#312).
    const agentsMdEngineActive = config.engines.some((e) => e === "agents-md" || e === "codex");
    const report = {
      // Drift is informational ("update available"), not an error — don't
      // flip `ok` for it. Missing plugins, corrupted settings.json, missing
      // invariants and a phantom preset ARE errors: the next render will fail,
      // silently skip the file, or drop a load-bearing rule / preset extras.
      ok: verdict.ok,
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
      duplicateMarkers,
      missingExternalTools,
      missingOptionalTools,
      // The four warning-level checks below are serialized verbatim, in the
      // order the human output prints them: a CI pipeline (or an agent) reading
      // `--json` was blind to all of them, which defeats the purpose of #368 and
      // #440 — debt `render` cannot fix, reported only to a human who is not
      // watching. They stay warnings: none of them feeds `computeHealthVerdict`,
      // so the exit code is unchanged.
      gateReadiness,
      emptyUserSections,
      // Uncapped on purpose: MAX_ARTIFACT_ROWS is a readability cap for the
      // terminal ("… and N more"), and a machine consumer needs every row.
      interpolationArtifacts,
      // `path` is absolute because that IS the remediation target, it is not
      // derivable (NAVORI_BACKUP_ROOT can move the store), and the human output
      // already prints the same string — so the JSON leaks nothing extra, and
      // this payload already carries an absolute `configPath`.
      diskUsage,
      monorepoDrift,
      workspaceLink,
      missingPreset,
      presetOverride,
      missingPresetFiles,
      placeholderName,
      nameMismatch,
      orphanedEngineOutputs,
      legacyAgents,
      excludedBlocks,
      claudeHookScripts,
      codexHealth,
      codegraphHealth,
      gitignoreHealth,
      gitHygiene,
      workspaceDrift,
      engineInventory,
    };

    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
      // JSON consumers (CI pipelines) need the same exit-code semantics as
      // the text output so a piped check ($navori doctor --json --strict)
      // fails the build the same way the human-readable run would. `!verdict.ok`
      // is exactly the hard-issue set (#244).
      if (!verdict.ok) {
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
        // Only a first-class row when an engine that emits it is configured;
        // otherwise a leftover AGENTS.md is reported as an orphan, not a ✓ (#312).
        ...(agentsMdEngineActive ? [`  ${check(report.checks.agentsMdExists)} AGENTS.md`] : []),
        `  ${check(report.checks.claudeDirExists)} .claude/`,
        `  ${check(report.checks.progressDirExists)} ${config.progress?.dir ?? "progress"}/`,
      ].join("\n"),
      td.fsChecksTitle,
    );

    if (orphanedEngineOutputs.length > 0) {
      const total = orphanedEngineOutputs.reduce((n, o) => n + o.paths.length, 0);
      const lines = orphanedEngineOutputs.flatMap((o) =>
        o.paths.map(
          (path) =>
            `  ${color.cyan(sym.bullet)} ${accent(path)}  ${grey(td.orphanedEngineOutputRow(o.engine))}`,
        ),
      );
      p.note(lines.join("\n"), td.orphanedEngineOutputsTitle(total));
    }

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

    if (nameMismatch) {
      p.log.warn(td.nameMismatch(nameMismatch.configName, nameMismatch.dirName));
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

    // `project.libraries` ids this CLI's registry doesn't know: render skips
    // them silently and prunes their managed skill from disk, so a repo upgraded
    // without `navori update` loses its guidance with zero signal (audit A1 —
    // the socketio → socketio-server/-client split). Warn with the successor
    // skills when the id is a known retired one.
    const staleLibraries = unknownLibraries(config.project?.libraries);
    if (staleLibraries.length > 0) {
      const lines = staleLibraries.map((lib) => {
        const row = lib.removed
          ? td.unknownLibraryRemovedRow(lib.successors.join(", "))
          : td.unknownLibraryUnknownRow;
        return `  ${color.yellow(sym.update)} ${accent(lib.id)}  ${grey(row)}`;
      });
      p.log.warn(td.unknownLibraries(staleLibraries.length, lines.join("\n")));
    }

    if (drifts.length > 0) {
      const lines = drifts.map((d) => {
        if (d.kind === "content") {
          return `  ${color.red(sym.conflict)} ${accent(`${d.filePath}:${d.markerId}`)}  ${grey(`hash ${d.expectedHash} ≠ ${d.actualHash}`)}  ${grey(td.driftContentRow(d.source))}`;
        }
        const suffix =
          d.kind === "downgrade" ? td.driftDowngradeRow(d.source) : td.driftVersionSuffix(d.source);
        return `  ${color.yellow(sym.update)} ${accent(`${d.filePath}:${d.markerId}`)}  ${grey(`${d.fromVersion} → ${d.toVersion}`)}  ${grey(suffix)}`;
      });
      // One hint per block; escalate by severity of the fix that actually
      // applies: content edits (sync) > downgrade (update the CLI) > version
      // (render). A downgrade's fix is never render, so it must outrank it (#242).
      const hint = drifts.some((d) => d.kind === "content")
        ? td.driftHintContent
        : drifts.some((d) => d.kind === "downgrade")
          ? td.driftHintDowngrade
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
      const lines = malformedMarkers.map((m) => {
        const why =
          m.reason === "missing-id"
            ? td.malformedMarkerRowMissingId
            : td.malformedMarkerRowUnterminated;
        return `  ${color.yellow(sym.update)} ${accent(`${m.filePath}:${m.line}`)}  ${grey(`${why} · ${m.snippet}`)}`;
      });
      p.log.warn(td.malformedMarkers(malformedMarkers.length, lines.join("\n")));
    }

    if (duplicateMarkers.length > 0) {
      const lines = duplicateMarkers.map(
        (m) =>
          `  ${color.red(sym.fail)} ${accent(`${m.filePath}:${m.id}`)}  ${grey(td.duplicateMarkerRow(m.count))}`,
      );
      p.log.error(td.duplicateMarkers(duplicateMarkers.length, lines.join("\n")));
    }

    if (claudeHookScripts) {
      // A missing referenced script (red) is more severe than one that merely
      // lost its +x bit (yellow); both are fixed by `navori render --apply`.
      if (claudeHookScripts.missing.length > 0) {
        const lines = claudeHookScripts.missing.map(
          (path) =>
            `  ${color.red(sym.fail)} ${accent(path)}  ${grey(td.claudeHookScriptMissingRow)}`,
        );
        p.log.warn(td.claudeHookScriptsMissing(claudeHookScripts.missing.length, lines.join("\n")));
      }
      if (claudeHookScripts.notExecutable.length > 0) {
        const lines = claudeHookScripts.notExecutable.map(
          (path) =>
            `  ${color.yellow(sym.update)} ${accent(path)}  ${grey(td.claudeHookScriptNotExecutableRow)}`,
        );
        p.log.warn(
          td.claudeHookScriptsNotExecutable(
            claudeHookScripts.notExecutable.length,
            lines.join("\n"),
          ),
        );
      }
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

    if (gateReadiness.length > 0) {
      const lines = gateReadiness.map((issue) => {
        const why =
          issue.reason === "missing-binary"
            ? td.gateMissingBinaryRow(issue.detail)
            : issue.reason === "missing-deps"
              ? td.gateMissingDepsRow(issue.detail)
              : td.gateMissingScriptRow(issue.detail);
        return `  ${color.yellow(sym.update)} ${accent(`qualityGate.${issue.gate}`)}  ${grey(why)}`;
      });
      p.log.warn(td.gateNotRunnable(gateReadiness.length, lines.join("\n")));
    }

    if (emptyUserSections.length > 0) {
      const lines = emptyUserSections.map(
        (skill) =>
          `  ${color.yellow(sym.update)} ${accent(skill.id)}  ${grey(td.emptyUserSectionRow(skill.path))}`,
      );
      p.log.warn(td.emptyUserSections(emptyUserSections.length, lines.join("\n")));
    }

    if (interpolationArtifacts.length > 0) {
      // Unresolved placeholders first: a repo with no `qualityGate` publishes
      // the soft fallback 28 times, and in file order those rows would push the
      // rare, hand-fixable token past the cap — hiding the finding that needs a
      // human. Same reason within the cap: the scarce signal goes on top.
      const bySeverity = [...interpolationArtifacts].sort(
        (a, b) =>
          Number(a.reason === "unconfigured-gate") - Number(b.reason === "unconfigured-gate"),
      );
      const lines = bySeverity.slice(0, MAX_ARTIFACT_ROWS).map((artifact) => {
        const why =
          artifact.reason === "unconfigured-gate"
            ? td.interpolationArtifactGateRow
            : td.interpolationArtifactUnresolvedRow(artifact.token);
        return `  ${color.yellow(sym.update)} ${accent(`${artifact.path}:${artifact.line}`)}  ${grey(why)}`;
      });
      const hidden = interpolationArtifacts.length - lines.length;
      if (hidden > 0) lines.push(grey(td.interpolationArtifactsMore(hidden)));
      p.log.warn(td.interpolationArtifacts(interpolationArtifacts.length, lines.join("\n")));
    }

    if (diskUsage.length > 0) {
      const lines = diskUsage.map((issue) => {
        const row =
          issue.target === "backups"
            ? td.diskBackupsRow(humanBytes(issue.bytes))
            : td.diskWorktreesRow(humanBytes(issue.bytes));
        return `  ${color.yellow(sym.update)} ${accent(issue.path)}  ${grey(row)}`;
      });
      p.log.warn(td.diskUsage(diskUsage.length, lines.join("\n")));
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
      // Name the workspace when the out-of-order file is a monorepo workspace's
      // CLAUDE.md rather than the root, so the diagnostic points at the right file.
      const where = orderReport.workspacePath
        ? `${grey(`${orderReport.workspacePath}/CLAUDE.md`)}\n`
        : "";
      p.log.warn(
        where +
          (orderReport.interleaved
            ? td.orderInterleaved(current, expected, spotlight)
            : td.orderReorderable(current, expected, spotlight)),
      );
    }

    const nextSteps = suggestNextSteps(
      {
        claudeMdExists: report.checks.claudeMdExists,
        missingPlugins,
        drifts,
        orderReport,
        legacyAgents,
      },
      lang,
    );
    p.note(nextSteps.map((s) => `  ${color.cyan(sym.bullet)} ${s}`).join("\n"), td.nextStepsTitle);

    if (codexHealth) {
      const cx: string[] = [];
      if (codexHealth.configMalformed) {
        cx.push(`  ${color.red(sym.fail)} ${td.codexConfigMalformed}`);
      }
      for (const h of codexHealth.hooksNotExecutable) {
        cx.push(`  ${color.yellow(sym.update)} ${td.codexHookNotExecutable(h)}`);
      }
      if (codexHealth.versionWarning) {
        cx.push(
          `  ${color.yellow(sym.update)} ${td.codexVersionWarning(codexHealth.versionWarning.found, codexHealth.versionWarning.min)}`,
        );
      }
      if (codexHealth.hookTrustHint) {
        cx.push(`  ${color.cyan(sym.bullet)} ${td.codexHookTrustHint}`);
      }
      if (codexHealth.guardNotVersioned.length > 0) {
        cx.push(
          `  ${color.yellow(sym.update)} ${td.codexGuardNotVersioned(codexHealth.guardNotVersioned.join(", "))}`,
        );
      }
      if (cx.length > 0) p.note(cx.join("\n"), "Codex");
    }

    if (codegraphHealth) {
      const cg: string[] = [];
      // Committing the SQLite index is the worst of the git-hygiene failures
      // (constant churn + binary merge conflicts); a merely-unignored dir is a
      // lighter, preventive warning. They're mutually exclusive by construction.
      if (codegraphHealth.tracked) {
        // A yellow warning, not a red ✗: `tracked` never flips the verdict
        // (codegraph advisories are warnings), so a fail symbol that never fails
        // was contradictory UX. Aligned with the rest of this section (#270).
        cg.push(`  ${color.yellow(sym.update)} ${td.codegraphTracked}`);
      } else if (codegraphHealth.notIgnored) {
        cg.push(`  ${color.yellow(sym.update)} ${td.codegraphNotIgnored}`);
      }
      if (codegraphHealth.indexMissing) {
        cg.push(`  ${color.yellow(sym.update)} ${td.codegraphIndexMissing}`);
      }
      if (codegraphHealth.stale) {
        cg.push(`  ${color.yellow(sym.update)} ${td.codegraphStale}`);
      }
      if (cg.length > 0) p.note(cg.join("\n"), "codegraph");
    }

    // #313: harness `.gitignore` drift. Advisory (yellow), like codegraph — never
    // flips the verdict; `render --apply` reconciles it. Absent in mode "off".
    if (gitignoreHealth && (gitignoreHealth.missing || gitignoreHealth.drift)) {
      const gi = gitignoreHealth.missing ? td.gitignoreMissing : td.gitignoreDrift;
      p.note(`  ${color.yellow(sym.update)} ${gi}`, td.gitignoreTitle);
    }

    // #325: git hygiene. Advisory like the block above — the fix is the user's
    // `.gitignore` (or their SDD toggle), never something navori applies alone.
    if (gitHygiene) {
      const gh: string[] = [];
      if (gitHygiene.specsIgnored) {
        gh.push(
          `  ${color.yellow(sym.update)} ${td.gitHygieneSpecsIgnored(gitHygiene.specsIgnored)}`,
        );
      }
      for (const path of gitHygiene.ephemeralNotIgnored) {
        gh.push(`  ${color.yellow(sym.update)} ${td.gitHygieneEphemeralNotIgnored(path)}`);
      }
      if (gh.length > 0) p.note(gh.join("\n"), td.gitHygieneTitle);
    }

    // #326: config drift against the workspace. Purely informational — the
    // checked-in config stays the source of truth and adoption is an explicit act.
    if (workspaceDrift) {
      const wd = [
        ...workspaceDrift.vsDefaults.map(
          (d) =>
            `  ${color.yellow(sym.update)} ${td.workspaceDriftDefaultRow(accent(d.key), d.local, d.expected)}`,
        ),
        ...workspaceDrift.vsSiblings.map(
          (d) =>
            `  ${color.yellow(sym.update)} ${td.workspaceDriftSiblingRow(accent(d.key), d.local, d.expected, d.agree, d.total)}`,
        ),
        `  ${color.cyan(sym.bullet)} ${grey(td.workspaceDriftHint)}`,
      ];
      p.note(
        wd.join("\n"),
        td.workspaceDriftTitle(workspaceDrift.workspace, workspaceDrift.siblingsRead),
      );
    }

    const hasIssues = !verdict.ok;
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

export interface HealthVerdict {
  /**
   * The health gate shared by `doctor` and `status` (#244). True when none of
   * the hard-failure conditions hold. This is THE single source of truth for
   * "is this repo healthy?" so `status --json`'s `ok` can no longer diverge
   * from what `doctor` reports about the same state.
   */
  ok: boolean;
  missingPlugins: MissingPlugin[];
  corruptedSettings: CorruptedSettingsReport[];
  missingInvariants: MissingInvariant[];
  /** The resolved active preset (or null), so callers can derive presetOverride
   *  without resolving it a second time. */
  resolvedPreset: ReturnType<typeof resolvePreset>;
  /** A declared preset that resolves to nothing (phantom) — else null. */
  missingPreset: string | null;
  missingPresetFiles: Array<{ id: string; path: string }>;
  codexHealth: CodexHealth | null;
  /** Managed ids appearing more than once in a file — the extra copy is invisible
   *  to render/sync/doctor and may hold stale content, so it flips `ok` (#274). */
  duplicateMarkers: DuplicateMarker[];
}

/**
 * Run every check that flips `ok` / drives exit code 2, in one place, so
 * `doctor` and `status` render the SAME verdict over the SAME repo state (#244).
 * Drift is deliberately excluded: it's informational ("update available"), gated
 * only by `doctor --strict` (exit 1), and never flips `ok`.
 */
export function computeHealthVerdict(cwd: string, config: NavoriConfig): HealthVerdict {
  const missingPlugins = collectMissingPlugins(config);
  const corruptedSettings = scanCorruptedSettings(cwd);
  const missingInvariants = scanMissingInvariants(cwd, config);
  const resolvedPreset = config.preset !== "custom" ? resolvePreset(config.preset, cwd) : null;
  const missingPreset =
    config.preset !== "custom" && resolvedPreset === null ? config.preset : null;
  const missingPresetFiles = scanMissingPresetFiles(cwd, config);
  const codexHealth = scanCodexHealth(cwd, config);
  const duplicateMarkers = scanDuplicateMarkers(cwd, config);
  const ok =
    missingPlugins.length === 0 &&
    corruptedSettings.length === 0 &&
    missingInvariants.length === 0 &&
    missingPreset === null &&
    missingPresetFiles.length === 0 &&
    duplicateMarkers.length === 0 &&
    codexHealth?.configMalformed !== true;
  return {
    ok,
    missingPlugins,
    corruptedSettings,
    missingInvariants,
    resolvedPreset,
    missingPreset,
    missingPresetFiles,
    codexHealth,
    duplicateMarkers,
  };
}

export interface NameMismatch {
  /** `config.name` as declared in navori.config.json. */
  configName: string;
  /** The repo directory basename it doesn't match. */
  dirName: string;
}

/**
 * `config.name` doesn't match the repo's directory basename — the twin of the
 * placeholder-name check (#315). Usually a harness copied from another repo
 * whose `name` was never updated. Informational (never flips `ok`). Skipped when
 * the name is already a known placeholder — that's warned separately, so the two
 * hints don't double up on the same config.
 */
export function scanNameMismatch(cwd: string, config: NavoriConfig): NameMismatch | null {
  if (isPlaceholderName(config.name)) return null;
  const dirName = basename(cwd);
  if (dirName === config.name) return null;
  return { configName: config.name, dirName };
}

export interface CorruptedSettingsReport {
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

export interface ClaudeHookScriptsReport {
  /** Referenced `.claude/scripts|hooks` files that don't exist on disk. */
  missing: string[];
  /** Referenced files present but lacking the executable (+x) bit. */
  notExecutable: string[];
}

/**
 * Validate that every `.claude/scripts/*` and `.claude/hooks/*` file referenced
 * by an ACTIVE hook in `.claude/settings.json` exists and is executable — the
 * Claude-side equivalent of Codex's `hooksNotExecutable` (#213). A plugin hook
 * (semgrep/jscpd) points at `.claude/scripts/check-*.sh`; if that file is
 * missing or lost its +x bit, Claude fires it on every Bash and it breaks or
 * no-ops silently. Both failure modes are fixed by `navori render --apply`, so
 * they're warnings (they don't flip `ok`), matching Codex's treatment.
 *
 * Returns null when Claude isn't a configured engine or there's no settings
 * file (nothing rendered yet). Corrupted JSON is left to `scanCorruptedSettings`.
 */
export function scanClaudeHookScripts(
  cwd: string,
  config: NavoriConfig,
): ClaudeHookScriptsReport | null {
  if (!config.engines.includes("claude")) return null;
  const settingsPath = join(cwd, ".claude/settings.json");
  if (!existsSync(settingsPath)) return null;
  let settings: unknown;
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
  } catch {
    return null; // corrupted JSON is surfaced by scanCorruptedSettings
  }

  const refs = new Set<string>();
  collectHookScriptRefs((settings as { hooks?: unknown }).hooks, refs);

  const missing: string[] = [];
  const notExecutable: string[] = [];
  for (const rel of [...refs].sort()) {
    const abs = join(cwd, rel);
    if (!existsSync(abs)) {
      missing.push(rel);
      continue;
    }
    try {
      if ((statSync(abs).mode & 0o111) === 0) notExecutable.push(rel);
    } catch {
      // Unreadable — skip rather than guess.
    }
  }
  return { missing, notExecutable };
}

/** Repo-relative `.claude/scripts|hooks/*` paths named in any `command` string
 *  under the hooks tree. Walks the nested Claude hook shape generically so it
 *  catches core, quality-gate and plugin hooks alike. */
function collectHookScriptRefs(hooks: unknown, out: Set<string>): void {
  if (typeof hooks !== "object" || hooks === null) return;
  const re = /\.claude\/(?:scripts|hooks)\/[^\s"']+/g;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    for (const [key, val] of Object.entries(node)) {
      if (key === "command" && typeof val === "string") {
        for (const m of val.matchAll(re)) out.add(m[0]);
      } else {
        walk(val);
      }
    }
  };
  walk(hooks);
}

export interface MissingInvariant {
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
 * structural-search falls back to Grep, so doctor only warns when the binary
 * is absent.
 *
 * `sg` is NOT a valid tell for ast-grep (#495), even though Homebrew installs
 * ast-grep under that alias on macOS. On any Linux with shadow-utils
 * `/usr/bin/sg` always exists and is an unrelated program ("execute command as
 * different group ID"), so probing it made doctor report ast-grep as INSTALLED
 * on every such machine — a false OK, which is the one verdict a doctor must
 * never produce. Every ast-grep distribution channel (npm `@ast-grep/cli`,
 * Homebrew, cargo) ships the canonical `ast-grep` name, so dropping the alias
 * costs no true positive; it only stops trusting a name that means two things.
 */
export function scanMissingOptionalTools(): MissingOptionalTool[] {
  const binaries = ["ast-grep"];
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
  const missing = missingInvariantsAt(cwd, config, "");
  // Monorepo: each workspace renders its own tree with its own (possibly
  // overridden) preset, so a load-bearing rule dropped in a workspace was
  // invisible when only the root was checked (#235). The source is tagged with
  // the workspace path so the diagnostic is unambiguous.
  for (const ws of config.monorepo?.workspaces ?? []) {
    const wsCwd = resolve(cwd, ws.path);
    if (!existsSync(wsCwd)) continue; // orphaned workspace — render skips it too
    missing.push(...missingInvariantsAt(wsCwd, effectiveConfigForWorkspace(config, ws), ws.path));
  }
  return missing;
}

/** Missing invariants for the render under a single directory. `pathPrefix` (the
 *  workspace path) tags the `source` so a monorepo report names the location. */
function missingInvariantsAt(
  scanCwd: string,
  config: NavoriConfig,
  pathPrefix: string,
): MissingInvariant[] {
  const sources: Array<{ source: string; invariants: string[] }> = [];
  const tag = (s: string): string => (pathPrefix ? `${pathPrefix} · ${s}` : s);

  // Plugin blocks are only materialized by engines that emit them (claude, codex).
  // For a prose-only engine set (agents-md/cursor/copilot) the block is dropped by
  // design, so requiring its invariant would go permanently red with no remedy
  // (#269). core/preset invariants survive the prose filter, so they always apply.
  const engines = config.engines ?? ["claude"];
  const materializesPluginBlocks = engines.some((e) => PLUGIN_BLOCK_ENGINES.has(e));

  try {
    const loaded = loadPreset(config.preset, scanCwd);
    if (loaded && loaded.def.invariants.length > 0) {
      sources.push({ source: tag(`preset:${loaded.def.id}`), invariants: loaded.def.invariants });
    }
  } catch {
    // A malformed preset is surfaced by the render path; nothing to check here.
  }

  for (const [id, settings] of Object.entries(config.plugins ?? {})) {
    if (settings.enabled !== true) continue;
    if (!materializesPluginBlocks) continue; // prose-only: block isn't emitted (#269)
    try {
      const plugin = loadPlugin(id);
      if (plugin.manifest.invariants.length > 0) {
        sources.push({ source: tag(`plugin:${id}`), invariants: plugin.manifest.invariants });
      }
    } catch {
      // Missing / broken plugin is reported via missingPlugins.
    }
  }

  if (sources.length === 0) return [];

  const output = readRenderedText(scanCwd, config);
  if (output.trim() === "") return []; // nothing rendered yet

  const missing: MissingInvariant[] = [];
  for (const { source, invariants } of sources) {
    for (const inv of invariants) {
      if (!output.includes(inv)) missing.push({ invariant: inv, source });
    }
  }
  return missing;
}

/**
 * Concatenate the rendered text owned by the configured engines only. Derives
 * the per-engine output paths from the shared `ENGINE_OUTPUTS` table (#226) so
 * this scan can't drift from what `scanManagedDrift` inspects: the root prose
 * files come from the engine's `kind:"file"` markers, the asset trees from its
 * `textDirs`. `seen` dedups the AGENTS.md / `.codex` overlap.
 */
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
    const outputs = ENGINE_OUTPUTS.find((e) => e.engine === engine);
    if (!outputs) continue;
    for (const marker of outputs.markers) {
      if (marker.kind === "file") addFile(join(cwd, marker.path));
    }
    for (const dir of outputs.textDirs) addDir(join(cwd, dir));
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
      timeout: 5000, // best-effort external probe must not hang doctor (#268)
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

/** True when git ignores `relPath` (relative to `cwd`). Exit 0 ⇒ ignored. */
function isIgnoredByGit(cwd: string, relPath: string): boolean {
  try {
    execFileSync("git", ["-C", cwd, "check-ignore", "-q", relPath], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false; // exit 1 (not ignored) or git error
  }
}

/** True when git tracks at least one file under `relPath` (relative to `cwd`). */
function gitTracksPath(cwd: string, relPath: string): boolean {
  try {
    const out = execFileSync("git", ["-C", cwd, "ls-files", "--", relPath], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() !== "";
  } catch {
    return false;
  }
}

/**
 * Ephemeral agent artifacts that must never reach a commit: subagent handoffs,
 * agent worktrees, and machine-local settings. Shared with the `.gitignore`
 * cubo A and the render backup's exclusion list (#348) so the three can't drift
 * apart again. It is a SUBSET of `CUBO_A_ENTRIES` on purpose — `.codegraph/`
 * has its own, richer check in `scanCodegraphHealth`, and `.navori/`
 * legitimately holds versioned local presets, so neither belongs in a "should
 * be ignored" list.
 */
const EPHEMERAL_AGENT_PATHS = EPHEMERAL_HARNESS_PATHS;

export interface GitHygieneReport {
  /** The specs dir, when it's gitignored while the SDD block is active. */
  specsIgnored: string | null;
  /** Ephemeral agent paths present on disk that git does NOT ignore. */
  ephemeralNotIgnored: string[];
}

/**
 * Git hygiene of the harness's own directories (#325) — the other half of
 * `gitignoreHarness` (#313): that one MANAGES the harness entries, this one
 * RECONCILES that what must be versioned isn't ignored and what's ephemeral is.
 *
 * (a) `specs/` ignored while the `sdd` block is active. The block orders agents
 *     to write the feature board in exactly that directory, so ignoring it turns
 *     SDD off in silence: specs vanish on a branch switch and the `R<n>`↔test
 *     trace never reaches the PR. Nothing reported this before.
 * (b) an ephemeral agent dir that ISN'T ignored, the symmetric failure: subagent
 *     handoffs and worktrees show up as `??` in `git status` on their way into
 *     someone's commit.
 *
 * Only paths that exist on disk are reported for (b) — an absent dir carries no
 * risk yet, and warning about it would be noise on a fresh repo. Returns null
 * outside a git work tree, where `check-ignore` has nothing to answer against.
 */
export function scanGitHygiene(cwd: string, config: NavoriConfig): GitHygieneReport | null {
  if (!isGitWorkTree(cwd)) return null;

  // `sdd` renders when its condition holds AND the repo didn't opt out of the
  // block. `config` here is the raw parsed config (doctor doesn't run it through
  // effectiveConfig), so mirror that default: absent `sdd` means enabled.
  const sddActive =
    config.sdd?.enabled !== false && !(config.blocks?.exclude ?? []).includes("sdd");
  const specsDir = config.sdd?.specsDir ?? "specs";
  // Probe a synthetic child so a directory pattern (`specs/`) matches even when
  // the dir doesn't exist on disk yet — same reason as the codegraph probe (#267).
  const specsIgnored =
    sddActive && isIgnoredByGit(cwd, `${trimSlash(specsDir)}/x`) ? specsDir : null;

  const ephemeralNotIgnored = EPHEMERAL_AGENT_PATHS.filter((rel) => {
    if (!existsSync(join(cwd, rel))) return false;
    const probe = rel.endsWith("/") ? `${rel}x` : rel;
    return !isIgnoredByGit(cwd, probe);
  });

  return { specsIgnored, ephemeralNotIgnored };
}

/** Drop a trailing slash so a configured `specsDir` works with or without one. */
function trimSlash(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

/** The codegraph index directory (SQLite/FTS5 graph), relative to the repo root. */
const CODEGRAPH_DIR = ".codegraph";

export interface CodegraphHealth {
  /** `.codegraph/` is not covered by .gitignore (git work tree only). */
  notIgnored: boolean;
  /** `.codegraph/` has files tracked by git — the binary index was committed. */
  tracked: boolean;
  /** codegraph binary is in PATH but the index (`.codegraph/`) was never built. */
  indexMissing: boolean;
  /** Best-effort: `codegraph status` reported the index as stale. */
  stale: boolean;
}

/**
 * Codegraph plugin health (Spec 0009 F2). Only meaningful when the `codegraph`
 * plugin is enabled; returns null otherwise so the report omits the section.
 *
 * Scope is deliberately honest — two solid, deterministic checks plus one
 * best-effort:
 * (a) git hygiene (DETERMINISTIC): `.codegraph/` is a churning binary SQLite
 *     index that must never be committed (Spec 0009 §5). We flag it when git
 *     tracks it (already committed → merge conflicts) or when it isn't ignored
 *     (preventive). Only meaningful inside a git work tree.
 * (b) index built (DETERMINISTIC): the binary is in PATH but `.codegraph/`
 *     doesn't exist yet — `codegraph init` never ran. A missing binary is NOT
 *     reported here (scanMissingExternalTools already surfaces it with the
 *     install + `codegraph init` hint).
 * (c) freshness (BEST EFFORT): codegraph is beta and its `status` output wording
 *     is not pinned, so we run it only when the binary AND the index exist, and
 *     flag stale ONLY on an explicit stale signal. If the wording differs, or
 *     `status` errors, freshness degrades to a no-op — never a false "fresh",
 *     never a false "stale" on a normal status line.
 */
export function scanCodegraphHealth(cwd: string, config: NavoriConfig): CodegraphHealth | null {
  if (config.plugins?.codegraph?.enabled !== true) return null;

  const dirAbs = join(cwd, CODEGRAPH_DIR);
  const dirExists = existsSync(dirAbs);
  const inGit = isGitWorkTree(cwd);
  const binary = hasBinary("codegraph");

  // (a) git hygiene.
  const tracked = inGit && gitTracksPath(cwd, CODEGRAPH_DIR);
  // Probe a synthetic child, not the bare dir: `git check-ignore` matches a
  // directory pattern (`.codegraph/`) against the PATH STRING it's given, and
  // `.codegraph` (no slash) fails to resolve the pattern when the dir doesn't
  // exist on disk yet — a false "not ignored". `.codegraph/x` resolves correctly
  // in all four states (pattern with/without slash × dir present/absent). Use a
  // literal forward slash, not join(): git expects `/` on every platform (#267).
  const notIgnored = inGit && !tracked && !isIgnoredByGit(cwd, `${CODEGRAPH_DIR}/x`);

  // (b) index built (only actionable once the binary exists).
  const indexMissing = binary && !dirExists;

  // (c) freshness (best effort — see the doc comment).
  let stale = false;
  if (binary && dirExists) {
    try {
      const out = execFileSync("codegraph", ["status"], {
        cwd,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000, // codegraph is beta; a hung status must not hang doctor (#268)
      });
      stale = /\bstale\b|out[- ]?of[- ]?date|outdated/i.test(out);
    } catch {
      // status unsupported / errored — leave freshness undetermined.
    }
  }

  return { notIgnored, tracked, indexMissing, stale };
}

export interface EngineInventory {
  agents: string[];
  skills: string[];
  /** Plugin-contributed scripts (`.claude/scripts/<dest>`). Empty from the core
   *  plan alone — the core harness ships no standalone scripts. */
  scripts: string[];
  hooks: string[];
}

/** Skills/scripts/hooks a plugin contributes, which `resolveHarnessPlan` omits
 *  (it only knows core + preset assets). Both Claude and Codex materialize these,
 *  so the parity inventory must include them (#233). Keyed by a stable label:
 *  skill/script by id/dest, hook by `event:matcher`. */
function pluginInventoryAssets(config: NavoriConfig): {
  skills: string[];
  scripts: string[];
  hooks: string[];
} {
  const skills = new Set<string>();
  const scripts = new Set<string>();
  const hooks = new Set<string>();
  for (const plugin of loadEnabledPlugins(config.plugins).loaded) {
    for (const s of plugin.skillAssets) skills.add(s.id);
    for (const sc of plugin.scriptAssets) scripts.add(sc.dest);
    for (const h of plugin.manifest.hooks ?? []) hooks.add(`${h.event}:${h.matcher ?? "*"}`);
  }
  return { skills: [...skills], scripts: [...scripts], hooks: [...hooks] };
}

/**
 * Per-engine harness inventory (Spec 0007 M8) for `doctor --json`, so a repo's
 * CI can assert Claude↔Codex parity after `render --all`. Only the disk engines
 * (claude, codex) carry a distinct agents/skills/scripts/hooks set; prose engines
 * are omitted. Claude includes the leader; Codex embodies it in the main thread.
 *
 * The result is the UNION across the repo root and every monorepo workspace: a
 * workspace may override the preset (→ different extras), and render materializes
 * a tree per workspace, so a root-only inventory validated a subset (#235). It
 * also folds in each plugin's skills/scripts/hooks, which the core plan omits (#233).
 */
export function buildEngineInventory(
  config: NavoriConfig,
  cwd: string,
): Record<string, EngineInventory> {
  const diskEngines = config.engines.filter((e) => e === "claude" || e === "codex");
  if (diskEngines.length === 0) return {};
  const coreAssets = resolve(getCoreRoot(), "core-assets");

  const acc: Record<
    string,
    { agents: Set<string>; skills: Set<string>; scripts: Set<string>; hooks: Set<string> }
  > = {};
  for (const engine of diskEngines) {
    acc[engine] = { agents: new Set(), skills: new Set(), scripts: new Set(), hooks: new Set() };
  }

  const locations: Array<{ cwd: string; config: NavoriConfig }> = [{ cwd, config }];
  for (const ws of config.monorepo?.workspaces ?? []) {
    const wsCwd = resolve(cwd, ws.path);
    if (!existsSync(wsCwd)) continue; // orphaned workspace — render skips it too
    locations.push({ cwd: wsCwd, config: effectiveConfigForWorkspace(config, ws) });
  }

  for (const loc of locations) {
    let preset: ReturnType<typeof loadPreset> = null;
    if (loc.config.preset && loc.config.preset !== "custom") {
      try {
        preset = loadPreset(loc.config.preset, loc.cwd);
      } catch {
        preset = null; // a broken preset is surfaced elsewhere; inventory stays core-only
      }
    }
    const pluginAssets = pluginInventoryAssets(loc.config);
    for (const engine of diskEngines) {
      const plan = resolveHarnessPlan(loc.config, coreAssets, preset, {
        includeLeader: engine === "claude",
      });
      const bucket = acc[engine]!;
      for (const a of plan.agents) bucket.agents.add(a.id);
      for (const s of plan.skills) bucket.skills.add(s.id);
      for (const h of plan.hooks) bucket.hooks.add(h.id);
      for (const s of pluginAssets.skills) bucket.skills.add(s);
      for (const s of pluginAssets.scripts) bucket.scripts.add(s);
      for (const h of pluginAssets.hooks) bucket.hooks.add(h);
    }
  }

  const out: Record<string, EngineInventory> = {};
  for (const engine of diskEngines) {
    const b = acc[engine]!;
    out[engine] = {
      agents: [...b.agents].sort(),
      skills: [...b.skills].sort(),
      scripts: [...b.scripts].sort(),
      hooks: [...b.hooks].sort(),
    };
  }
  return out;
}
