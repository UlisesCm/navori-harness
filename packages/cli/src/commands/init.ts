import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { resolve, join, dirname, relative } from "node:path";
import { existsSync, mkdirSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { writeConfig } from "../lib/config.ts";
import { writeFileAtomic } from "../lib/atomic.ts";
import { detectProject, isPlaceholderName, type ClaudeInfraInventory, type PackageManager } from "../lib/detect.ts";
import { listKnownPluginIds, loadPlugin, type AgentRole } from "../lib/plugins.ts";
import { createMigrationBackup, removeOriginals } from "../lib/migrate.ts";
import { loadWorkspace, type WorkspaceConfig, WorkspaceError } from "../lib/workspace.ts";
import { registerRepoSafe } from "../lib/registry.ts";
import { runRender } from "./render.ts";
import {
  formatInfraSummary,
  formatDetectionSummary,
  formatWorkspaceSummary,
} from "./init-format.ts";
import { color, dim, brand, kv } from "../lib/style.ts";
import { t, type Lang } from "../lib/i18n.ts";
import { loadPrompts, type LoadedPrompt } from "../engines/claude/prompts-loader.ts";
import { scanMonorepoWorkspaces, type DetectedWorkspace } from "../lib/scan.ts";
import type { MonorepoWorkspace } from "../lib/monorepo.ts";
import type { NavoriConfigInput, NavoriConfig } from "../lib/schema.ts";
import {
  buildRecommendedQualityGate,
  buildRecommendedProject,
  buildFullPlugins,
  buildFullProject,
  RECOMMENDED_MODELS,
  RECOMMENDED_EFFORT,
} from "../lib/recommended.ts";
import { scanMissingExternalTools } from "./doctor.ts";

type AdoptionMode = "fresh" | "coexist" | "replace";

const ENGINE_OPTIONS = [
  { value: "claude", label: "Claude Code (.claude/)" },
  { value: "agents-md", label: "AGENTS.md (universal — Cursor / Codex / Gemini read it)" },
  { value: "cursor", label: "Cursor (.cursor/rules/)" },
  { value: "copilot", label: "Copilot (.github/copilot-instructions.md)" },
];

type EngineId = "claude" | "agents-md" | "cursor" | "copilot";

export const initCommand = defineCommand({
  meta: {
    name: "init",
    description: "Adopt navori in the current repo (auto-detects stack, presets, quality gate)",
  },
  args: {
    yes: {
      type: "boolean",
      description: "Accept all detected values + render automatically without prompting",
    },
    cwd: {
      type: "string",
      description: "Directory to initialize (default: current working directory)",
    },
    render: {
      type: "boolean",
      default: true,
      description: "Render CLAUDE.md after writing config. Disable with --no-render.",
    },
    workspace: {
      type: "string",
      description: "Workspace to inherit defaults from (must exist via 'workspace init')",
    },
    recommended: {
      type: "boolean",
      description: "Opinionated mode: --yes + auto-enable recommended plugins (engram, +gh if GitHub repo)",
    },
    full: {
      type: "boolean",
      description:
        "Maximal mode: --recommended + all plugins + pre-commit hook + monorepo scan + strict project block",
    },
    lang: {
      type: "string",
      description: "Wizard language (es|en). Default: es. Skipped in --yes/--recommended.",
    },
    "scan-monorepo": {
      type: "boolean",
      description:
        "When a monorepo is detected, scan pnpm-workspace.yaml / package.json#workspaces and populate monorepo.workspaces[] with a preset per app",
    },
    "pre-commit-hook": {
      type: "boolean",
      description:
        "Scaffold a local pre-commit hook that runs 'navori doctor --strict'. Opt-in; in interactive mode you're asked instead.",
    },
  },
  async run({ args }) {
    const cwd = resolve(args.cwd ?? process.cwd());
    const configPath = `${cwd}/navori.config.json`;
    // --full implies --recommended, which implies --yes (skip wizard).
    const isFull = Boolean(args.full);
    const isRecommended = Boolean(args.recommended || args.full);
    const autoYes = Boolean(args.yes || args.recommended || args.full);

    p.intro(brand("init"));

    // Bootstrap-language: errors that fire before the wizard runs are shown in
    // the lang chosen via --lang (or "es" if none/invalid). The wizard itself
    // re-prompts the user for the real choice right after.
    const bootstrapLang = normalizeLang(args.lang as string | undefined) ?? "es";
    const bootstrapT = t(bootstrapLang);

    if (!existsSync(cwd)) {
      p.cancel(bootstrapT.dirNotFound(cwd));
      process.exit(1);
    }

    if (existsSync(configPath)) {
      p.cancel(bootstrapT.configExists(configPath));
      process.exit(1);
    }

    // --- Step 0 — pick wizard language (skipped in auto mode) ---
    let lang: Lang = bootstrapLang;
    if (!autoYes) {
      const explicit = normalizeLang(args.lang as string | undefined);
      if (explicit) {
        lang = explicit;
      } else {
        const picked = await p.select<Lang>({
          message: bootstrapT.pickLanguage,
          options: [
            { value: "es", label: bootstrapT.pickLanguageEs },
            { value: "en", label: bootstrapT.pickLanguageEn },
          ],
          initialValue: "es",
        });
        if (p.isCancel(picked)) return cancel(bootstrapLang);
        lang = picked;
      }
    }
    const tr = t(lang);

    const detected = detectProject(cwd);

    // Handle existing Claude infrastructure first — before showing stack detection
    const mode = await chooseAdoptionMode(cwd, detected.claudeInfra, detected.name, {
      yes: autoYes,
      lang,
    });
    if (mode === null) return cancel(lang);

    // Load workspace defaults (cascade: detection → workspace defaults → user overrides)
    let workspaceConfig: WorkspaceConfig | null = null;
    if (args.workspace) {
      try {
        workspaceConfig = loadWorkspace(args.workspace);
      } catch (err) {
        if (err instanceof WorkspaceError) {
          p.cancel(err.message);
          process.exit(1);
        }
        throw err;
      }
      if (!workspaceConfig) {
        p.cancel(tr.workspaceNotFoundInit(args.workspace));
        process.exit(1);
      }
      p.note(
        formatWorkspaceSummary(workspaceConfig, lang),
        tr.workspaceDefaultsTitle(workspaceConfig.name),
      );
    }

    p.note(formatDetectionSummary(detected, lang), tr.detectedTitle);

    // Recognized stack without a preset on disk: name the gap honestly instead
    // of letting the baseline render look like the intended outcome. Fires in
    // both --yes and interactive flows (before any branching).
    if (detected.suggestedPresetGap) {
      p.log.warn(tr.presetGapNotice(detected.suggestedPresetGap));
    }

    // A detected name like `temp-app` is almost always an un-renamed scaffold
    // carried over from package.json — surface it now so the user can fix the
    // source before the harness bakes the wrong name in.
    if (detected.name && isPlaceholderName(detected.name)) {
      p.log.warn(tr.placeholderNameNotice(detected.name));
    }

    // Cascade: workspace defaults take precedence over detection when present
    const wsDefaults = workspaceConfig?.defaults;
    const defaultEngines = (wsDefaults?.engines as EngineId[] | undefined) ??
      (detected.existingEngines.length > 0
        ? (detected.existingEngines as EngineId[])
        : (["claude"] as EngineId[]));
    const defaultBranchBase = wsDefaults?.branchBase ?? detected.branchBase ?? "main";
    // prTarget is opt-in (no auto-detection): inherited from the workspace
    // default when present, else left unset so the PR targets branchBase.
    const defaultPrTarget = wsDefaults?.prTarget;
    // Asset language defaults to the wizard language. The user can still
    // override via the "language" multi-select adjustment below.
    const defaultLanguage: "es" | "en" = wsDefaults?.language ?? lang;
    const defaultCommits = wsDefaults?.commits;

    if (autoYes) {
      if (!detected.name) {
        p.cancel(tr.detectionFailedYes);
        process.exit(1);
      }
      const wsPlugins = wsDefaults?.plugins ?? {};
      // --full turns on every *bundled* plugin (listKnownPluginIds, not the
      // static map, so we never enable an id that isn't shipped and would fail
      // doctor --strict); --recommended adds only the context-aware extras (gh
      // when GitHub). engram is always-on regardless.
      const extraPlugins = isFull
        ? buildFullPlugins(listKnownPluginIds())
        : isRecommended
        ? buildRecommendedPlugins(cwd)
        : {};
      // Merge order matters: workspace defaults are org policy and win over the
      // mode-driven extras, so a workspace that explicitly disables a plugin
      // (enabled:false) stays disabled even under --full. engram (always-on) is
      // the baseline and can likewise be overridden by an explicit workspace entry.
      const mergedPlugins = { ...ALWAYS_ON_PLUGINS, ...extraPlugins, ...wsPlugins };

      p.log.info(tr.pluginsAlwaysOn(Object.keys(ALWAYS_ON_PLUGINS).join(", ")));
      if (isFull) {
        // The full-mode banner already says "all plugins"; listing them again
        // (and re-announcing always-on engram) would be redundant/contradictory.
        p.log.info(tr.fullModeEnabled);
      } else if (isRecommended && Object.keys(extraPlugins).length > 0) {
        p.log.info(tr.recPluginsEnabled(Object.keys(extraPlugins).join(", ")));
      }

      const monorepoBlock = await buildMonorepoBlock(cwd, detected, {
        // --full always scans a detected monorepo to populate a preset per app.
        scanMonorepo: Boolean((args as { "scan-monorepo"?: boolean })["scan-monorepo"]) || isFull,
        autoYes: true,
        lang,
        rootPreset: detected.suggestedPreset,
      });

      // --recommended applies a sensible qualityGate fallback (guessed commands)
      // when none is detected; --yes plain stays conservative and never invents
      // gate commands. The `project` block is different: empty arrays invent
      // nothing, they just declare "no critical areas / legacy paths". Writing
      // it in BOTH modes keeps `<not configured: project.*>` placeholders out of
      // the rendered agents (the schema fills localSkills/etc. via .default([])).
      const fallbackQg = isRecommended
        ? detected.qualityGate ?? buildRecommendedQualityGate(detected)
        : detected.qualityGate;
      // Detected library skills and codeLanguage are facts of the stack, not
      // mode choices — merge them in both --recommended and plain --yes so the
      // cross-preset skills and the language-aware baseline (TS-only
      // tipado-fuerte) resolve without a wizard answer.
      const projectBlock = {
        ...(isFull
          ? buildFullProject(detected)
          : isRecommended
          ? buildRecommendedProject(detected)
          : {}),
        libraries: detected.libraries,
        libraryMigrations: detected.migrations,
        codeLanguage: detected.stack.language,
      };

      writeConfig(configPath, {
        name: detected.name,
        ...(args.workspace ? { workspace: args.workspace } : {}),
        engines: defaultEngines,
        preset: detected.suggestedPreset,
        language: defaultLanguage,
        branchBase: defaultBranchBase,
        ...(defaultPrTarget ? { prTarget: defaultPrTarget } : {}),
        ...(defaultCommits ? { commits: defaultCommits } : {}),
        ...(fallbackQg ? { qualityGate: fallbackQg } : {}),
        // Seed the cost-aware model + effort profile in the opinionated modes only;
        // plain `--yes` stays minimal and lets every agent inherit the session
        // model and effort.
        ...(isRecommended || isFull ? { models: RECOMMENDED_MODELS, effort: RECOMMENDED_EFFORT } : {}),
        ...(Object.keys(mergedPlugins).length > 0 ? { plugins: mergedPlugins } : {}),
        project: projectBlock,
        ...(monorepoBlock ? { monorepo: monorepoBlock } : {}),
      });
      p.log.success(tr.wroteConfig(configPath));
      // Self-register in the global registry so `navori render --all` picks this
      // repo up on the next harness bump. Best-effort — never fails init.
      registerRepoSafe(cwd, detected.name);

      if (isRecommended && !detected.qualityGate && fallbackQg) {
        p.log.info(`Quality gate fallback aplicado: ${fallbackQg.fast}`);
      }

      // --full enables plugins even when their external binary is absent. doctor
      // surfaces those as a non-fatal yellow warning (they never flip its exit
      // code), so name them up front — installing them lets the plugin's hooks
      // actually run. Reuses doctor's own externalTool scan for accuracy.
      if (isFull) {
        const missing = scanMissingExternalTools({ plugins: mergedPlugins } as NavoriConfig);
        if (missing.length > 0) {
          p.log.warn(tr.fullBinariesToInstall(missing.map((m) => m.binary).join(", ")));
        }
      }
      // Surface gaps that the user can't see otherwise — autoYes skipped the
      // wizard so they never had a chance to fill these in. Without a
      // qualityGate the render emits `<not configured: qualityGate.fast>`
      // in agent prompts and skips the pre-commit hook entirely; users
      // following `--recommended` need that hint up front.
      if (!fallbackQg) {
        p.log.warn(tr.qualityGateNotDetected);
      }

      if (mode === "coexist") {
        p.outro(tr.doneExistingUntouched);
        return;
      }
      // citty negates booleans on --no-X, so args.render === false when --no-render is passed.
      if (args.render !== false) renderInline(cwd);
      await offerPreCommitHook(cwd, {
        autoYes,
        force: Boolean(args["pre-commit-hook"]) || isFull,
        lang,
      });
      p.outro(tr.done);
      return;
    }

    // Confirm or adjust
    const accept = await p.confirm({
      message: detected.name ? tr.useTheseValues : tr.projectNameUndetectedAdjust,
      initialValue: Boolean(detected.name),
    });
    if (p.isCancel(accept)) return cancel(lang);

    let name = detected.name;
    let engines = defaultEngines;
    let branchBase = defaultBranchBase;
    let workspace: string | undefined = args.workspace as string | undefined;
    let preset = detected.suggestedPreset;
    let qualityGate = detected.qualityGate;
    let language: "es" | "en" = defaultLanguage;

    if (!accept || !detected.name) {
      const toAdjust = await p.multiselect<string>({
        message: tr.whatToChange,
        options: [
          {
            value: "name",
            label: `${tr.labelProjectName}${detected.name ? ` (${detected.name})` : ` ${tr.notDetectedParen}`}`,
          },
          { value: "language", label: `${tr.labelLanguage} (${defaultLanguage} — ${tr.defaultParen})` },
          { value: "workspace", label: tr.labelWorkspace },
          { value: "engines", label: `${tr.labelEngines} (${defaultEngines.join(", ")})` },
          { value: "preset", label: `${tr.labelPreset} (${preset})` },
          { value: "branchBase", label: `${tr.labelBranchBase} (${defaultBranchBase})` },
          {
            value: "qualityGate",
            label: qualityGate
              ? `${tr.labelQualityGate} (${qualityGate.full})`
              : `${tr.labelQualityGate} ${tr.notDetectedParen}`,
          },
        ],
        required: !detected.name,
        initialValues: detected.name ? [] : ["name"],
      });
      if (p.isCancel(toAdjust)) return cancel(lang);
      const adjustments = toAdjust as string[];

      if (adjustments.includes("name") || !name) {
        const value = await p.text({
          message: tr.projectNameKebab,
          placeholder: detected.name ?? "my-project",
          defaultValue: detected.name ?? "",
          validate(v) {
            if (!/^[a-z0-9][a-z0-9-]*$/.test(v)) return tr.mustBeKebab;
            return undefined;
          },
        });
        if (p.isCancel(value)) return cancel(lang);
        name = value as string;
      }

      if (adjustments.includes("language")) {
        const value = await p.select<"es" | "en">({
          message: tr.languageForAssets,
          options: [
            { value: "es", label: tr.assetEsLabel },
            { value: "en", label: tr.assetEnLabel },
          ],
          initialValue: defaultLanguage,
        });
        if (p.isCancel(value)) return cancel(lang);
        language = value;
      }

      if (adjustments.includes("workspace")) {
        const value = await p.text({
          message: tr.workspaceOptional,
          placeholder: tr.leaveEmpty,
        });
        if (p.isCancel(value)) return cancel(lang);
        const trimmed = (value as string).trim();
        if (trimmed) workspace = trimmed;
      }

      if (adjustments.includes("engines")) {
        const value = await p.multiselect<string>({
          message: tr.enginesToTarget,
          options: ENGINE_OPTIONS,
          required: true,
          initialValues: defaultEngines,
        });
        if (p.isCancel(value)) return cancel(lang);
        engines = value as EngineId[];
      }

      if (adjustments.includes("preset")) {
        const value = await p.text({
          message: tr.stackPresetFreeText,
          placeholder: preset,
          defaultValue: preset,
        });
        if (p.isCancel(value)) return cancel(lang);
        preset = value as string;
      }

      if (adjustments.includes("branchBase")) {
        const value = await p.text({
          message: tr.baseBranch,
          placeholder: defaultBranchBase,
          defaultValue: defaultBranchBase,
        });
        if (p.isCancel(value)) return cancel(lang);
        branchBase = value as string;
      }

      if (adjustments.includes("qualityGate")) {
        const fastVal = await p.text({
          message: tr.qualityGateFast,
          placeholder: qualityGate?.fast ?? defaultGateHint(detected.packageManager),
          defaultValue: qualityGate?.fast ?? "",
        });
        if (p.isCancel(fastVal)) return cancel(lang);
        const fullVal = await p.text({
          message: tr.qualityGateFull,
          placeholder: qualityGate?.full ?? (fastVal as string),
          defaultValue: qualityGate?.full ?? (fastVal as string),
        });
        if (p.isCancel(fullVal)) return cancel(lang);
        if ((fastVal as string).trim() && (fullVal as string).trim()) {
          qualityGate = { fast: (fastVal as string).trim(), full: (fullVal as string).trim() };
        }
      }
    }

    if (!name) {
      p.cancel(tr.projectNameRequired);
      process.exit(1);
    }

    // Plugin selection
    let pluginsToEnable = await pickPlugins(lang);
    if (pluginsToEnable === null) return cancel(lang);

    let pluginsConfig = buildPluginsConfig(pluginsToEnable);

    // Skill → agent assignments (only ask if plugins selected with recommendations)
    let agentAssignments = await pickAgentAssignments(pluginsToEnable, lang);
    if (agentAssignments === null) return cancel(lang);

    // Preview + edit loop — last chance to fix any field before writing.
    // Each edit re-runs the field's prompt; cancelling a re-prompt just
    // returns to the preview (no exit), so a typo never forces you to
    // restart from scratch.
    while (true) {
      const summary = buildConfigPreview(
        {
          name: name ?? "",
          workspace,
          engines,
          preset,
          language,
          branchBase,
          qualityGate,
          plugins: pluginsToEnable,
          agentAssignments,
        },
        lang,
      );
      p.note(summary, tr.previewTitle);

      // Confirm-first: the happy path is a single keystroke. The full field
      // list only appears if the user chooses to adjust — no 10-option wall.
      const action = await p.select<"ok" | "edit" | "cancel">({
        message: tr.previewAction,
        options: [
          { value: "ok", label: color.green(tr.saveAndContinue) },
          { value: "edit", label: tr.adjustSomething },
          { value: "cancel", label: color.red(tr.cancelAndExit) },
        ],
        initialValue: "ok",
      });
      if (p.isCancel(action) || action === "cancel") return cancel(lang);
      if (action === "ok") break;

      const choice = await p.select<string>({
        message: tr.whatToEdit,
        options: [
          { value: "name", label: tr.editField(tr.labelProjectName) },
          { value: "language", label: tr.editField(tr.labelLanguage) },
          { value: "engines", label: tr.editField(tr.labelEngines) },
          { value: "preset", label: tr.editField(tr.labelPreset) },
          { value: "branchBase", label: tr.editField(tr.labelBranchBase) },
          { value: "qualityGate", label: tr.editField(tr.labelQualityGate) },
          { value: "plugins", label: tr.editField("plugins") },
          { value: "agentAssignments", label: tr.editField("agent assignments") },
          { value: "__back", label: tr.backToPreview },
        ],
      });
      if (p.isCancel(choice) || choice === "__back") continue;

      const field = choice as string;
      switch (field) {
        case "name": {
          const v = await p.text({
            message: tr.projectNameKebab,
            placeholder: name ?? "my-project",
            defaultValue: name ?? "",
            validate: (val) => (/^[a-z0-9][a-z0-9-]*$/.test(val) ? undefined : tr.mustBeKebab),
          });
          if (!p.isCancel(v)) name = v as string;
          break;
        }
        case "language": {
          const v = await p.select<"es" | "en">({
            message: tr.languageForAssets,
            options: [
              { value: "es", label: tr.assetEsLabel },
              { value: "en", label: tr.assetEnLabel },
            ],
            initialValue: language,
          });
          if (!p.isCancel(v)) language = v;
          break;
        }
        case "engines": {
          const v = await p.multiselect<string>({
            message: tr.enginesToTarget,
            options: ENGINE_OPTIONS,
            required: true,
            initialValues: engines,
          });
          if (!p.isCancel(v)) engines = v as EngineId[];
          break;
        }
        case "preset": {
          const v = await p.text({
            message: tr.stackPresetFreeText,
            placeholder: preset,
            defaultValue: preset,
          });
          if (!p.isCancel(v)) preset = v as string;
          break;
        }
        case "branchBase": {
          const v = await p.text({
            message: tr.baseBranch,
            placeholder: branchBase,
            defaultValue: branchBase,
          });
          if (!p.isCancel(v)) branchBase = v as string;
          break;
        }
        case "qualityGate": {
          const fastVal = await p.text({
            message: tr.qualityGateFast,
            placeholder: qualityGate?.fast ?? defaultGateHint(detected.packageManager),
            defaultValue: qualityGate?.fast ?? "",
          });
          if (p.isCancel(fastVal)) break;
          const fullVal = await p.text({
            message: tr.qualityGateFull,
            placeholder: qualityGate?.full ?? (fastVal as string),
            defaultValue: qualityGate?.full ?? (fastVal as string),
          });
          if (p.isCancel(fullVal)) break;
          if ((fastVal as string).trim() && (fullVal as string).trim()) {
            qualityGate = {
              fast: (fastVal as string).trim(),
              full: (fullVal as string).trim(),
            };
          }
          break;
        }
        case "plugins": {
          const v = await pickPlugins(lang);
          if (v !== null) {
            pluginsToEnable = v;
            pluginsConfig = buildPluginsConfig(v);
            // Drop assignments whose plugin id is no longer enabled
            const enabledPluginIds = new Set(v);
            for (const skillId of Object.keys(agentAssignments)) {
              const ownerPlugin = findPluginIdForSkill(skillId);
              if (ownerPlugin && !enabledPluginIds.has(ownerPlugin)) {
                delete agentAssignments[skillId];
              }
            }
          }
          break;
        }
        case "agentAssignments": {
          const v = await pickAgentAssignments(pluginsToEnable, lang);
          if (v !== null) agentAssignments = v;
          break;
        }
      }
    }

    // Project prompts (interactive only). Collect customization answers
    // after the preview-edit loop closes so the user has confirmed the
    // base config first.
    let project: Record<string, unknown> | undefined;
    const promptsResult = loadPrompts(pluginsConfig);
    if (promptsResult.prompts.length > 0) {
      const collected = await runProjectPrompts(promptsResult.prompts, lang);
      if (collected === null) return cancel(lang);
      if (Object.keys(collected).length > 0) {
        project = collected;
      }
    }

    // engram is always-on; workspace defaults + the user's wizard picks layer on
    // top (the wizard never lists engram, so it can only add to it here).
    const wsPlugins = wsDefaults?.plugins ?? {};
    const mergedPlugins = { ...ALWAYS_ON_PLUGINS, ...wsPlugins, ...pluginsConfig };

    const monorepoBlock = await buildMonorepoBlock(cwd, detected, {
      scanMonorepo: Boolean((args as { "scan-monorepo"?: boolean })["scan-monorepo"]),
      autoYes: false,
      lang,
      rootPreset: preset,
    });

    writeConfig(configPath, {
      name,
      ...(workspace ? { workspace } : {}),
      engines,
      preset,
      language,
      branchBase,
      ...(defaultPrTarget ? { prTarget: defaultPrTarget } : {}),
      ...(defaultCommits ? { commits: defaultCommits } : {}),
      ...(qualityGate ? { qualityGate } : {}),
      // Cost-aware model + effort profile as sensible defaults (the wizard has no
      // model/effort question); the user can override any assignment in
      // navori.config.json.
      models: RECOMMENDED_MODELS,
      effort: RECOMMENDED_EFFORT,
      ...(Object.keys(mergedPlugins).length > 0 ? { plugins: mergedPlugins } : {}),
      ...(Object.keys(agentAssignments).length > 0 ? { agentAssignments } : {}),
      // Always write `project` so the schema fills empty arrays and render emits
      // no `<not configured: project.*>` placeholders (see autoYes path above).
      // Library skills and codeLanguage are auto-derived from the stack.
      project: {
        ...(project ?? {}),
        libraries: detected.libraries,
        libraryMigrations: detected.migrations,
        codeLanguage: detected.stack.language,
      },
      ...(monorepoBlock ? { monorepo: monorepoBlock } : {}),
    });

    p.log.success(tr.wroteConfig(configPath));
    // Self-register in the global registry (best-effort) so `render --all`
    // rolls future harness bumps into this repo.
    registerRepoSafe(cwd, name);

    if (mode === "coexist") {
      p.outro(tr.doneExistingUntouched);
      return;
    }

    // Final: render or not
    if (args.render === false) {
      p.outro(tr.doneSkippedRender);
      return;
    }

    const shouldRender = await p.confirm({
      message: tr.renderNow,
      initialValue: true,
    });
    if (p.isCancel(shouldRender) || !shouldRender) {
      p.outro(tr.doneRunLater);
      return;
    }

    renderInline(cwd);
    await offerPreCommitHook(cwd, { autoYes, force: Boolean(args["pre-commit-hook"]), lang });
    p.outro(tr.harnessReady);
  },
});

export function normalizeLang(raw: string | undefined): Lang | null {
  if (!raw) return null;
  const v = raw.toLowerCase().trim();
  if (v === "es" || v === "en") return v;
  return null;
}

export async function chooseAdoptionMode(
  cwd: string,
  infra: ClaudeInfraInventory,
  projectName: string | null,
  args: { yes?: boolean; lang: Lang },
): Promise<AdoptionMode | null> {
  if (!infra.present) return "fresh";

  const tr = t(args.lang);

  if (args.yes) {
    // --yes implies coexist for safety: never replaces user infra silently.
    // Surface WHAT was detected (same summary the interactive flow shows below)
    // so the coexist decision isn't a black box — otherwise a user who believes
    // they cleaned the repo can't tell what triggered it (e.g. a leftover
    // progress/ dir, which counts as infra even after .claude/CLAUDE.md are gone).
    p.log.warn(tr.existingInfraYesMode);
    p.note(formatInfraSummary(infra, args.lang), tr.filesFoundTitle);
    return "coexist";
  }

  p.log.warn(tr.existingInfraDetected);
  p.note(formatInfraSummary(infra, args.lang), tr.filesFoundTitle);

  const choice = await p.select<AdoptionMode>({
    message: tr.howToAdopt,
    options: [
      { value: "coexist", label: tr.coexistLabel, hint: tr.coexistHint },
      { value: "replace", label: tr.replaceLabel, hint: tr.replaceHint },
    ],
    initialValue: "coexist",
  });
  if (p.isCancel(choice)) return null;

  if (choice === "replace") {
    const confirm = await p.confirm({
      message: tr.replaceConfirm,
      initialValue: false,
    });
    if (p.isCancel(confirm) || !confirm) return null;

    const backup = createMigrationBackup(cwd, projectName ?? "unknown");
    p.log.success(tr.backedUp(backup.movedPaths.length, backup.path));
    removeOriginals(cwd, backup.movedPaths);
    p.log.info(tr.removedOriginals(cwd));
    return "replace";
  }

  return "coexist";
}

export async function pickPlugins(lang: Lang): Promise<string[] | null> {
  // engram is always-on (ALWAYS_ON_PLUGINS) — don't offer it as opt-in; tell the
  // user it's already included so its absence from the list isn't a surprise.
  const alwaysOn = Object.keys(ALWAYS_ON_PLUGINS);
  p.log.info(t(lang).pluginsAlwaysOn(alwaysOn.join(", ")));
  const ids = listKnownPluginIds().filter((id) => !(id in ALWAYS_ON_PLUGINS));
  if (ids.length === 0) return [];

  const options = ids.map((id) => {
    const plugin = (() => {
      try {
        return loadPlugin(id);
      } catch {
        return null;
      }
    })();
    return {
      value: id,
      label: plugin ? `${plugin.manifest.name} (${id})` : id,
      hint: plugin?.manifest.description,
    };
  });

  const selected = await p.multiselect<string>({
    message: t(lang).pluginsToEnable,
    options,
    required: false,
    initialValues: [],
  });
  if (p.isCancel(selected)) return null;
  return selected as string[];
}

/**
 * Build skill → agent assignments based on plugin recommendations, then offer
 * the user a chance to review/override. Returns user-overridden entries only
 * (defaults stay implicit and live in the plugin manifest, not in the config).
 */
async function pickAgentAssignments(
  enabledPlugins: string[],
  lang: Lang,
): Promise<Record<string, AgentRole> | null> {
  if (enabledPlugins.length === 0) return {};
  const tr = t(lang);

  type Recommendation = { id: string; pluginId: string; recommendedAgent: AgentRole };
  const recommendations: Recommendation[] = [];
  for (const pluginId of enabledPlugins) {
    let plugin;
    try {
      plugin = loadPlugin(pluginId);
    } catch {
      continue;
    }
    for (const entry of plugin.manifest.managed) {
      if (entry.recommendedAgent) {
        recommendations.push({
          id: entry.id,
          pluginId,
          recommendedAgent: entry.recommendedAgent,
        });
      }
    }
  }

  if (recommendations.length === 0) return {};

  // Show defaults
  const summary = recommendations
    .map((r) => `  · ${r.id} (${r.pluginId})  →  ${r.recommendedAgent}`)
    .join("\n");
  p.log.message(`${tr.recommendedAssignments}\n${summary}`);

  const accept = await p.confirm({
    message: tr.useAssignments,
    initialValue: true,
  });
  if (p.isCancel(accept)) return null;
  if (accept) return {};

  // Let the user override one or more
  const overrides: Record<string, AgentRole> = {};
  const agentOptions: Array<{ value: AgentRole; label: string }> = [
    { value: "leader", label: tr.roleLeader },
    { value: "implementer", label: tr.roleImplementer },
    { value: "reviewer", label: tr.roleReviewer },
    { value: "researcher", label: tr.roleResearcher },
    { value: "ticket-audit", label: tr.roleTicketAudit },
    { value: "commit-pr-pilot", label: tr.roleCommitPrPilot },
    { value: "explorer", label: tr.roleExplorer },
  ];

  for (const rec of recommendations) {
    const choice = await p.select<AgentRole>({
      message: tr.agentFor(rec.id, rec.pluginId),
      options: agentOptions,
      initialValue: rec.recommendedAgent,
    });
    if (p.isCancel(choice)) return null;
    if (choice !== rec.recommendedAgent) {
      overrides[rec.id] = choice;
    }
  }

  return overrides;
}

/**
 * Recommended plugin set for opinionated --recommended mode:
 * - engram: always (persistent memory is universally useful)
 * - gh: only if the repo's git origin points to github.com
 *
 * Intentionally conservative — semgrep/jscpd/cognitive require external tools
 * that may not be installed; users add those explicitly.
 */
/**
 * Plugins navori enables on EVERY init, in every mode (--yes, --recommended,
 * interactive). engram — persistent memory across sessions — is core to the
 * navori experience, so it ships on by default rather than opt-in. Still
 * removable by editing navori.config.json afterward; this only sets the default
 * init writes, and the wizard never offers it as a choice.
 */
const ALWAYS_ON_PLUGINS: Record<string, { enabled: boolean }> = {
  engram: { enabled: true },
};

/**
 * Context-aware plugins enabled only by `--recommended`, layered on top of the
 * always-on baseline. engram lives in ALWAYS_ON_PLUGINS now, so this only adds
 * the extras that depend on the repo (e.g. gh when there's a GitHub remote).
 */
function buildRecommendedPlugins(cwd: string): Record<string, { enabled: boolean }> {
  const result: Record<string, { enabled: boolean }> = {};
  if (isGitHubRepo(cwd)) {
    result.gh = { enabled: true };
  }
  return result;
}

function isGitHubRepo(cwd: string): boolean {
  const r = spawnSync("git", ["-C", cwd, "config", "--get", "remote.origin.url"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (r.status !== 0) return false;
  return /github\.com/i.test(r.stdout);
}

function renderInline(cwd: string): void {
  const result = runRender(cwd, false);
  if (!result.ok) {
    p.log.error(result.reason ?? "Render failed");
    return;
  }
  const counts = result.entries.reduce<Record<string, number>>((acc, e) => {
    acc[e.status] = (acc[e.status] ?? 0) + 1;
    return acc;
  }, {});
  const parts: string[] = [];
  if (counts.created) parts.push(color.green(`${counts.created} created`));
  if (counts.updated) parts.push(color.yellow(`${counts.updated} updated`));
  if (counts["user-modified-skipped"]) parts.push(color.red(`${counts["user-modified-skipped"]} conflict`));
  if (counts["removed-condition-false"]) parts.push(color.magenta(`${counts["removed-condition-false"]} removed`));
  if (counts.unchanged) parts.push(dim(`${counts.unchanged} unchanged`));
  const summary = parts.length > 0 ? ` ${dim("—")} ${parts.join(dim(", "))}` : "";
  if (result.written) {
    p.log.success(`Rendered ${result.filePath}${summary}`);
  } else {
    p.log.info(`No render needed${summary}`);
  }

  // Surface engine-tree results (agents/skills/settings/hooks + progress/).
  // The header used to say ".claude/ written:" which was misleading because
  // progress/ lives outside .claude/. "Files written" describes the union.
  if (result.engineResult) {
    const written = result.engineResult.written.filter((w) => w.path !== "CLAUDE.md");
    if (written.length > 0) {
      const lines = written
        .slice(0, 12)
        .map((w) => `  ${dim("+")} ${w.path}`)
        .join("\n");
      const more = written.length > 12 ? `\n  ${dim(`… +${written.length - 12} more`)}` : "";
      p.log.message(`${dim("Files written:")}\n${lines}${more}`);
    }
    for (const s of result.engineResult.skipped) {
      p.log.warn(`Skipped ${s.path}: ${s.reason}`);
    }
    // Engine-emitted warnings (e.g. quality-gate hook skipped because the
    // fast gate isn't set). These would otherwise be invisible to anyone
    // running `init --recommended` since the render output is the only
    // signal the user sees.
    for (const w of result.engineResult.warnings) {
      p.log.warn(w);
    }
  }
}

/**
 * Spec 0003 §3.1.7 — offer to scaffold an opt-in pre-commit hook that runs
 * `navori doctor --strict`, catching drift before it lands in a commit.
 *
 * Opt-in by design: in interactive mode we ask (default no); in auto mode
 * (--yes/--recommended) we only scaffold when --pre-commit-hook is explicit.
 * No-op outside a git repo. The hook is local (never committed) so a teammate
 * who doesn't want it simply never runs init; `git commit --no-verify` skips it.
 */
async function offerPreCommitHook(
  cwd: string,
  opts: { autoYes: boolean; force: boolean; lang: Lang },
): Promise<void> {
  if (!existsSync(join(cwd, ".git"))) return;

  let wanted = opts.force;
  if (!wanted && !opts.autoYes) {
    const answer = await p.confirm({
      message: t(opts.lang).preCommitHookPrompt,
      initialValue: false,
    });
    if (p.isCancel(answer)) return;
    wanted = answer;
  }
  if (!wanted) return;

  const result = writePreCommitHook(cwd);
  if (result.ok) {
    p.log.success(t(opts.lang).preCommitHookWritten(result.path!));
  } else {
    p.log.warn(t(opts.lang).preCommitHookExists(result.path!));
  }
}

/**
 * Write the pre-commit hook. Prefers `.husky/pre-commit` when husky is already
 * set up (versioned, shared); otherwise falls back to the native
 * `.git/hooks/pre-commit` (zero deps, local). Never clobbers an existing hook.
 */
function writePreCommitHook(cwd: string): { ok: boolean; path: string } {
  const huskyDir = join(cwd, ".husky");
  const hookPath = existsSync(huskyDir)
    ? join(huskyDir, "pre-commit")
    : join(cwd, ".git", "hooks", "pre-commit");
  const relPath = relative(cwd, hookPath);

  if (existsSync(hookPath)) return { ok: false, path: relPath };

  const body = [
    "#!/usr/bin/env sh",
    "# navori pre-commit drift gate — scaffolded by 'navori init' (opt-in).",
    "# Bypass with: git commit --no-verify",
    "if command -v navori >/dev/null 2>&1; then",
    "  navori doctor --strict || exit 1",
    "elif command -v npx >/dev/null 2>&1; then",
    "  npx --no-install navori doctor --strict || exit 1",
    "fi",
    "",
  ].join("\n");

  mkdirSync(dirname(hookPath), { recursive: true });
  writeFileAtomic(hookPath, body);
  try {
    chmodSync(hookPath, 0o755);
  } catch {
    // best-effort; some filesystems (FAT) won't grant +x
  }
  return { ok: true, path: relPath };
}

function cancel(lang: Lang): void {
  p.cancel(t(lang).cancelled);
  process.exit(0);
}

function buildPluginsConfig(ids: string[]): Record<string, { enabled: boolean }> {
  return ids.reduce<Record<string, { enabled: boolean }>>((acc, id) => {
    acc[id] = { enabled: true };
    return acc;
  }, {});
}

/**
 * Find which plugin id owns a given managed asset id. Used when the user
 * edits the plugin list in the preview loop, so assignments tied to plugins
 * that are now disabled get pruned.
 *
 * Returns null if the skill id is not owned by any known plugin (e.g. a
 * future-core skill, or stale assignment).
 */
function findPluginIdForSkill(skillId: string): string | null {
  for (const pluginId of listKnownPluginIds()) {
    try {
      const plugin = loadPlugin(pluginId);
      if (plugin.manifest.managed.some((m) => m.id === skillId)) {
        return pluginId;
      }
    } catch {
      // unknown / broken plugin — skip
    }
  }
  return null;
}

export interface PreviewState {
  name: string;
  workspace: string | undefined;
  engines: string[];
  preset: string;
  language: "es" | "en";
  branchBase: string;
  qualityGate: { fast: string; full: string } | undefined;
  plugins: string[];
  agentAssignments: Record<string, AgentRole>;
  project?: Record<string, unknown>;
}

export function buildConfigPreview(state: PreviewState, lang: Lang): string {
  const tr = t(lang);
  const rows: Array<[string, string]> = [];
  rows.push(["name", state.name || dim(tr.notDetectedParen)]);
  if (state.workspace) rows.push(["workspace", state.workspace]);
  rows.push(["language", state.language]);
  rows.push(["engines", state.engines.join(", ")]);
  rows.push(["preset", state.preset]);
  rows.push(["branchBase", state.branchBase]);
  if (state.qualityGate) {
    rows.push(["qualityGate.fast", state.qualityGate.fast]);
    rows.push(["qualityGate.full", state.qualityGate.full]);
  }
  rows.push([
    "plugins",
    state.plugins.length > 0
      ? tr.pluginsValueLabel(state.plugins.join(", "))
      : dim(tr.pluginsNone),
  ]);
  rows.push([
    "agentAssignments",
    Object.keys(state.agentAssignments).length > 0
      ? tr.assignmentsValueLabel(Object.keys(state.agentAssignments).length)
      : dim(tr.assignmentsNone),
  ]);
  if (state.project) {
    for (const [k, v] of Object.entries(state.project)) {
      rows.push([`project.${k}`, formatProjectValue(v)]);
    }
  }
  return kv(rows);
}

/**
 * Sequential prompt walk after the preview-edit loop. Asks an upfront
 * gate ("answer them now?") so users in a hurry can skip the whole batch.
 * Each prompt routes by its declared type and treats blank / optional
 * answers as "leave the key unset" (so the rendered template surfaces
 * the absence as `<not configured: ...>` instead of an empty value).
 *
 * Returns `null` only when the user actively cancels (Ctrl+C on the gate).
 * Returns `{}` when the user picks "skip" or answers nothing.
 */
export async function runProjectPrompts(
  prompts: LoadedPrompt[],
  lang: Lang,
): Promise<Record<string, unknown> | null> {
  const tr = t(lang);
  p.note(tr.projectPromptsIntro, "project");

  const choice = await p.select<"run" | "skip">({
    message: tr.projectPromptsAsk,
    options: [
      { value: "run", label: tr.projectPromptsRun },
      { value: "skip", label: tr.projectPromptsSkip },
    ],
    initialValue: "run",
  });
  if (p.isCancel(choice)) return null;
  if (choice === "skip") {
    p.log.info(tr.projectPromptsSkipNote);
    return {};
  }

  const collected: Record<string, unknown> = {};
  // Two phases: general (repo posture) first, then specific (concrete rules).
  // A prompt with no declared phase falls into the specific group.
  const phases: Array<{ header: string; group: LoadedPrompt[] }> = [
    { header: tr.phaseGeneral, group: prompts.filter((q) => (q.phase ?? "specific") === "general") },
    { header: tr.phaseSpecific, group: prompts.filter((q) => (q.phase ?? "specific") === "specific") },
  ];
  for (const { header, group } of phases) {
    if (group.length === 0) continue;
    p.note(header);
    for (const prompt of group) {
      const subKey = prompt.key.startsWith("project.")
        ? prompt.key.slice("project.".length)
        : null;
      if (!subKey) continue; // non-project keys not supported yet
      const value = await askProjectPrompt(prompt, lang);
      if (value === null) return null; // user cancelled mid-walk
      if (value === undefined) continue; // optional, skipped
      collected[subKey] = value;
    }
  }
  return collected;
}

async function askProjectPrompt(
  prompt: LoadedPrompt,
  lang: Lang,
): Promise<unknown | null | undefined> {
  const tr = t(lang);
  const question = prompt.question[lang] ?? prompt.question.es;
  const message = prompt.optional ? `${question} ${dim(tr.projectPromptsOptional)}` : question;

  switch (prompt.type) {
    case "string": {
      const v = await p.text({
        message,
        placeholder: prompt.placeholder ?? "",
        // Without defaultValue, @clack/prompts returns the placeholder text on
        // an empty submit — which would persist the hint as a real value.
        defaultValue: "",
      });
      if (p.isCancel(v)) return null;
      const trimmed = (v as string).trim();
      return trimmed ? trimmed : undefined;
    }
    case "string-list": {
      const v = await p.text({
        message,
        placeholder: prompt.placeholder ?? "",
        defaultValue: "",
      });
      if (p.isCancel(v)) return null;
      const items = (v as string)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      return items.length > 0 ? items : undefined;
    }
    case "select": {
      const opts = (prompt.options ?? []).map((o) => ({
        value: o.value,
        label: o.label[lang] ?? o.label.es,
      }));
      if (opts.length === 0) return undefined;
      // Optional selects get an explicit skip choice (you pick it, not "leave
      // empty"), so use the bare question without the "leave empty" hint.
      if (prompt.optional) opts.push({ value: "__skip__", label: tr.projectPromptSkipOption });
      const v = await p.select<string>({ message: question, options: opts });
      if (p.isCancel(v)) return null;
      return v === "__skip__" ? undefined : v;
    }
    case "boolean": {
      const v = await p.confirm({ message, initialValue: false });
      if (p.isCancel(v)) return null;
      return v;
    }
    case "number": {
      const v = await p.text({
        message,
        placeholder: prompt.placeholder ?? "",
        defaultValue: "",
        validate: (val) => {
          if (!val.trim()) return undefined;
          return /^-?\d+(\.\d+)?$/.test(val.trim()) ? undefined : "número inválido";
        },
      });
      if (p.isCancel(v)) return null;
      const trimmed = (v as string).trim();
      return trimmed ? Number(trimmed) : undefined;
    }
  }
}

/**
 * Build the `monorepo` block for the navori.config.json being written.
 *
 * Whenever the project is a monorepo, write the slot so subsequent `scan` and
 * `render` calls have a stable home for workspace metadata. With
 * `scanMonorepo: true`, also walks pnpm-workspace.yaml / package.json#workspaces,
 * runs detection per workspace, and pushes each into `workspaces[]` with a
 * preset (only stored when it differs from the root preset — workspaces inherit
 * by default to keep the config minimal).
 *
 * Returns `undefined` for single-app repos so the writeConfig spread doesn't
 * add an empty `monorepo` key.
 */
async function buildMonorepoBlock(
  cwd: string,
  detected: ReturnType<typeof detectProject>,
  opts: { scanMonorepo: boolean; autoYes: boolean; lang: Lang; rootPreset: string },
): Promise<NonNullable<NavoriConfigInput["monorepo"]> | undefined> {
  if (!detected.monorepo) return undefined;

  const block: NonNullable<NavoriConfigInput["monorepo"]> = {
    enabled: true,
    tool: detected.monorepo.tool,
    workspaces: [],
  };

  // #70: don't make `--scan-monorepo` a flag the user has to remember. In a
  // NON-interactive run (--yes) without the flag, keep workspaces empty (they
  // can run `navori scan` later). But in an INTERACTIVE run, fall through and
  // OFFER the scan below (the confirm prompt is the opt-in) whenever the
  // monorepo actually has workspaces — otherwise a monorepo like moonar silently
  // ships with workspaces:[] and its apps never get a harness.
  if (!opts.scanMonorepo && opts.autoYes) return block;

  const found = scanMonorepoWorkspaces(cwd);
  if (found.length === 0) {
    if (!opts.autoYes) {
      p.log.info(
        "Monorepo detectado pero no se encontraron workspaces en pnpm-workspace.yaml/package.json#workspaces.",
      );
    }
    return block;
  }

  if (opts.autoYes) {
    block.workspaces = found.map((d) => buildWorkspaceEntry(d, opts.rootPreset, d.suggestedPreset));
    p.log.info(
      `Detectados ${found.length} workspace(s) en monorepo: ${found.map((w) => w.path).join(", ")}`,
    );
    return block;
  }

  const overview = found
    .map((w) => {
      const fw = w.framework ? dim(` [${w.framework}]`) : "";
      return `  · ${w.path}${fw} ${dim("→")} ${w.suggestedPreset}`;
    })
    .join("\n");
  p.log.message(`${dim("Workspaces detectados en el monorepo:")}\n${overview}`);

  const addAll = await p.confirm({
    message: `¿Agregar ${found.length} workspace(s) a monorepo.workspaces[]?`,
    initialValue: true,
  });
  if (p.isCancel(addAll) || !addAll) return block;

  const useSuggested = await p.confirm({
    message: "¿Usar el preset sugerido en cada workspace?",
    initialValue: true,
  });
  if (p.isCancel(useSuggested)) return block;

  for (const d of found) {
    let preset = d.suggestedPreset;
    if (!useSuggested) {
      const value = await p.text({
        message: `Preset para ${d.path}`,
        placeholder: preset,
        defaultValue: preset,
      });
      if (!p.isCancel(value) && (value as string).trim()) {
        preset = (value as string).trim();
      }
    }
    block.workspaces!.push(buildWorkspaceEntry(d, opts.rootPreset, preset));
  }
  return block;
}

function buildWorkspaceEntry(
  detected: DetectedWorkspace,
  rootPreset: string,
  preset: string,
): MonorepoWorkspace {
  const entry: MonorepoWorkspace = { name: detected.name, path: detected.path };
  if (preset && preset !== rootPreset) {
    entry.preset = preset;
  }
  // Scope library skills + migrations to this workspace's own deps so they don't
  // leak across apps (a Stripe skill lands only in the app that ships Stripe).
  if (detected.libraries.length > 0) {
    entry.libraries = detected.libraries;
  }
  if (detected.migrations.length > 0) {
    entry.libraryMigrations = detected.migrations;
  }
  return entry;
}

function formatProjectValue(v: unknown): string {
  if (Array.isArray(v)) return v.length > 0 ? v.join(", ") : "(empty)";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v === null || v === undefined) return "(none)";
  return String(v);
}

/**
 * Placeholder shown for the "fast" quality-gate prompt when none was detected.
 * Uses the repo's real package manager so we don't suggest a `pnpm` command in
 * a bun/npm/yarn project (#88). npm can't run a bare bin (`npm tsc`), so it goes
 * through `npx`; pnpm/yarn/bun resolve `node_modules/.bin` from `<pm> tsc`.
 */
function defaultGateHint(pm: PackageManager | null): string {
  if (pm === "npm") return "npx tsc --noEmit";
  return `${pm ?? "pnpm"} tsc --noEmit`;
}
