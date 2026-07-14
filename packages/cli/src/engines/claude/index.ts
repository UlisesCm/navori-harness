import { existsSync, mkdirSync, readFileSync, chmodSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { effectiveConfig, type NavoriConfig } from "../../lib/config.ts";
import { writeFileAtomic } from "../../lib/atomic.ts";
import { createBackup, purgeOldBackups } from "../../lib/backup.ts";
import { loadEnabledPlugins, type LoadedPlugin } from "../../lib/plugins.ts";
import { computeRenderPlan, canonicalManagedOrder, type AssetPlanEntry, type UpdateAvailable } from "../../lib/render-plan.ts";
import { loadPreset, PresetError, type PresetExtraFile } from "../../lib/presets.ts";
import { librarySkillById } from "../../lib/library-skills.ts";
import { getCoreRoot, readBundledCoreVersion } from "../../lib/bundled-assets.ts";
import { injectManagedSection, removeManagedSection, reorderManagedBlocks, resolveCondition } from "../../lib/marker.ts";
import type { RenderStatus } from "../../lib/style.ts";
import { isNavoriOwnedSettings } from "./settings-detection.ts";
import { buildClaudeSettings } from "./build-settings.ts";
import { mergeCoexistSettings, isPlainObject } from "./coexist-settings.ts";
import { renderManagedFile } from "./render-managed-file.ts";
import { interpolate } from "./interpolate.ts";
import { benchMark } from "../../lib/bench.ts";
import { stripFrontmatter } from "../../lib/frontmatter.ts";
import { log } from "../../lib/log.ts";
import { RenderWriteError } from "../../lib/errors.ts";

/**
 * Claude engine adapter — entry point. Orchestrates the full render of a
 * `.claude/` tree against a NavoriConfig:
 *
 *   - CLAUDE.md          (delegated to computeRenderPlan; existing flow)
 *   - .claude/settings.json   (built from settings-base + plugins + qg hook)
 *   - .claude/agents/<role>.md  for each role enabled in config.harness
 *   - .claude/skills/<id>.md    for each core skill (always-on for now)
 *   - .claude/hooks/guard-destructive.sh        (always — defensive guard)
 *   - .claude/hooks/quality-gate-pre-commit.sh  (only if qualityGate.fast set)
 *
 * Safety:
 *   - settings.json without `$navori.managed === true` is skipped (DT-2);
 *     the user must run `navori init --replace` to adopt.
 *   - Backup of every file that will be overwritten happens BEFORE any write.
 *   - Writes are atomic (temp + fsync + rename).
 *   - Shell hooks get +x.
 */

export interface ClaudeEngineResult {
  /** Files written this render (relative to cwd). */
  written: Array<{ path: string; status: RenderStatus }>;
  /** Files navori refused to touch with a human-readable reason. */
  skipped: Array<{ path: string; reason: string }>;
  /** Informational notes for the CLI to surface. */
  warnings: string[];
  /** Backup dir (or null if nothing changed and no backup was taken). */
  backupPath: string | null;
  /** Managed-block entries inside CLAUDE.md, for the existing reporter. */
  claudeMdEntries: AssetPlanEntry[];
  /** Version drift detected anywhere (used by `update` command). */
  updatesAvailable: UpdateAvailable[];
  /** CLAUDE.md assets that fell back to Spanish because language="en" lacks them. */
  languageFallbacks: string[];
  /** Total number of destination files inspected this render. `inspected -
   * written.length - skipped.length` = how many were already up to date. */
  inspected: number;
}

const CORE_AGENTS: ReadonlyArray<{ id: string; harnessKey: keyof NonNullable<NavoriConfig["harness"]> }> = [
  { id: "leader", harnessKey: "leader" },
  { id: "implementer", harnessKey: "implementer" },
  { id: "reviewer", harnessKey: "reviewer" },
  { id: "researcher", harnessKey: "researcher" },
  { id: "ticket-audit", harnessKey: "ticketAudit" },
  { id: "commit-pr-pilot", harnessKey: "commitPrPilot" },
  { id: "explorer", harnessKey: "explorer" },
];

const CORE_SKILLS: ReadonlyArray<string> = ["verify-before-done", "loop-back-debug", "review-diff"];

const CORE_META = { source: "@navori/core" as const, version: readBundledCoreVersion() };

/** Managed-block id for the skills index injected into CLAUDE.md. */
const SKILLS_INDEX_ID = "skills-index";

/**
 * Whether a preset extra applies to this config. An extra with no `condition`
 * is always on; one with a condition is materialized only when the config path
 * resolves truthy (same semantics as CoreManagedAsset.condition). Used in BOTH
 * the skills index and the extras render loop so they never disagree.
 */
function extraConditionMet(extra: PresetExtraFile, config: NavoriConfig): boolean {
  if (!extra.condition) return true;
  return resolveCondition(config as unknown as Record<string, unknown>, extra.condition);
}

/**
 * Build the body of the skills index — a navigation map of the skills agents
 * can apply: core (navori), preset (stack), library (detected from deps), and
 * project-local (the user's own, declared in `project.localSkills`). navori
 * indexes the local ones so agents discover them, but never owns their `.md`
 * content. Returns null when there's nothing to list so the caller strips the
 * block instead of rendering an empty header (defensive — core skills are
 * always present today, so in practice it always returns content).
 */
function buildSkillsIndexBody(
  config: NavoriConfig,
  localSkills: readonly string[],
  repoRoot: string,
): string | null {
  const rows: string[] = [];
  // Track skill names already listed so the auto-detected library skills don't
  // duplicate a core/preset skill that occupies the same destination.
  const listed = new Set<string>();
  for (const id of CORE_SKILLS) {
    rows.push(`- \`${id}\` — navori`);
    listed.add(id);
  }
  if (config.preset && config.preset !== "custom") {
    try {
      const loaded = loadPreset(config.preset, repoRoot);
      for (const e of loaded?.def.extras.skills ?? []) {
        if (!extraConditionMet(e, config)) continue;
        const name = basename(e.destRelPath).replace(/\.md$/, "");
        rows.push(`- \`${name}\` — preset (\`${config.preset}\`)`);
        listed.add(name);
      }
    } catch {
      // Preset problems are surfaced elsewhere; the index degrades gracefully.
    }
  }
  for (const id of config.project?.libraries ?? []) {
    if (listed.has(id) || !librarySkillById(id)) continue;
    rows.push(`- \`${id}\` — library (detected)`);
    listed.add(id);
  }
  for (const name of localSkills) {
    rows.push(`- \`${name}\` — project-local (\`.claude/skills/${name}.md\`)`);
  }
  if (rows.length === 0) return null;
  // The project-local note only makes sense when the repo actually declares
  // local skills; otherwise it points at a category that isn't present.
  const localNote = localSkills.length > 0
    ? ["Los `project-local` son tuyos — navori los indexa pero no toca su contenido."]
    : [];
  return [
    "## Skills disponibles",
    "",
    "Skills que los agentes pueden aplicar; cada uno vive en `.claude/skills/<id>.md`.",
    ...localNote,
    "",
    ...rows,
    "",
  ].join("\n");
}

/** Managed-block id for the agents index injected into CLAUDE.md. */
const AGENTS_INDEX_ID = "agentes-disponibles";

/** When to reach for each leaf agent, keyed by CORE_AGENTS id. The leader is
 * absent on purpose: the main agent embeds that role, it does not delegate to
 * it (see the "## Rol: orquestador" block). */
const AGENT_WHEN: Record<string, string> = {
  implementer: "Escribe código y tests de UNA tarea acotada con scope claro.",
  reviewer: "Valida un diff contra spec y calidad antes de cerrar (APPROVED / CHANGES_REQUESTED).",
  researcher: "Responde una pregunta concreta del repo (¿pasa Y? ¿qué consume X?) con evidencia citada.",
  explorer: "Mapea un área o módulo amplio: estructura, entry points, dependencias.",
  "ticket-audit": "Analiza a fondo un ticket complejo (bug crítico, migración, feature multi-capa) antes de descomponer.",
  "commit-pr-pilot": "Redacta commits Conventional y abre el PR tras la aprobación del reviewer.",
};

/**
 * Build the agents index — the catalog the orchestrator (main agent) reads to
 * know which subagents exist and when to spawn each. Lists only the enabled
 * leaf agents (config.harness[key] !== false); the leader is excluded because
 * the main agent embeds that role rather than delegating to it. Returns null
 * when nothing is enabled so the block is stripped instead of rendered empty.
 */
function buildAgentsIndexBody(config: NavoriConfig): string | null {
  const rows: string[] = [];
  for (const agent of CORE_AGENTS) {
    if (agent.id === "leader") continue;
    if (!isAgentEnabled(config, agent.harnessKey)) continue;
    const when = AGENT_WHEN[agent.id];
    if (!when) continue;
    rows.push(`- \`${agent.id}\` — ${when}`);
  }
  if (rows.length === 0) return null;
  return [
    "## Agentes disponibles",
    "",
    'Subagentes que puedes lanzar vía la tool `Agent` (tú eres el orquestador; ver "## Rol: orquestador"). Investigación y review son read-only → paralelízalos sin miedo.',
    "",
    ...rows,
    "",
  ].join("\n");
}

/** Managed-block id for the project-context rules injected into CLAUDE.md. */
const CONTEXTO_PROYECTO_ID = "contexto-proyecto";

/**
 * Turn the init questionnaire answers (project.* posture, review rigor,
 * architecture rule, critical areas, tests policy) into ACTIVE rules the
 * agents follow — not user-section hints. Returns null when nothing is set so
 * the block is stripped rather than rendered empty.
 */
function buildContextoProyectoBody(config: NavoriConfig): string | null {
  const proj = config.project ?? {};
  const rows: string[] = [];

  const posture = proj.posture as string | undefined;
  if (posture === "greenfield") {
    rows.push("- **Etapa:** greenfield — prioriza velocidad y menos ceremonia, pero el quality gate igual debe pasar.");
  } else if (posture === "production") {
    rows.push("- **Etapa:** en producción — prioriza NO romper regresiones. Los cambios de blast radius alto piden validación humana antes de mergear.");
  } else if (posture === "migration") {
    rows.push("- **Etapa:** migración legacy — cuida la compatibilidad legacy↔nuevo. El reviewer marca CRÍTICO si un cambio lee de un lado y escribe en el otro.");
  }

  const rigor = proj.reviewRigor as string | undefined;
  if (rigor === "strict") {
    rows.push("- **Rigor del review:** estricto — el reviewer bloquea APPROVED también con issues de confidence 65-79, no solo ≥80.");
  } else if (rigor === "pragmatic") {
    rows.push("- **Rigor del review:** pragmático — el reviewer bloquea solo issues ≥80; lo demás queda como observación informativa.");
  }

  const arch = (proj.architectureRule as string | undefined)?.trim();
  if (arch) {
    rows.push(`- **Arquitectura:** el código nuevo DEBE seguir \`${arch}\`. El reviewer marca los desvíos como ALTO.`);
  }

  const critical = (proj.criticalAreas as string[] | undefined) ?? [];
  if (critical.length > 0) {
    rows.push(`- **Áreas críticas** (review extra, severidad +1): ${critical.join(", ")}.`);
  }

  const tests = proj.testsForNewCode as string | undefined;
  if (tests === "always") {
    rows.push("- **Tests:** el código nuevo DEBE traer tests. El reviewer bloquea APPROVED si faltan.");
  } else if (tests === "when-applicable") {
    rows.push("- **Tests:** pide tests para lógica no trivial; en código simple son opcionales.");
  } else if (tests === "none") {
    rows.push("- **Tests:** el repo no exige tests para código nuevo.");
  }

  if (rows.length === 0) return null;

  return [
    "## Contexto del proyecto",
    "",
    "Reglas activas derivadas de tu config (`project.*`). Aplican a todos los agentes.",
    "",
    ...rows,
    "",
  ].join("\n");
}

export function renderClaudeEngine(
  cwd: string,
  inputConfig: NavoriConfig,
  options: {
    dryRun?: boolean;
    force?: boolean;
    /** CLAUDE.md managed-block ids to leave untouched (keep-mine resolution). */
    skipIds?: ReadonlySet<string>;
    /** CLAUDE.md managed-block ids to overwrite even if hand-edited (accept-new). */
    forceIds?: ReadonlySet<string>;
    /**
     * Repo root where `.navori/presets/` lives. Defaults to `cwd`; in a
     * monorepo the caller passes the repo root so a workspace render resolves
     * local presets from the shared `.navori/` at the root, not `cwd/.navori/`.
     */
    repoRoot?: string;
  } = {},
): ClaudeEngineResult {
  // Fill in render-only derived defaults (e.g. prTarget ?? branchBase) so
  // templates interpolate against a complete config without persisting it.
  const config = effectiveConfig(inputConfig);
  const dryRun = options.dryRun === true;
  const force = options.force === true;
  const repoRoot = options.repoRoot ?? cwd;
  // A workspace render (repoRoot points elsewhere than cwd) omits the root-only
  // global blocks — Claude Code already loads them from the parent CLAUDE.md.
  // Issue #70.
  const isWorkspace = options.repoRoot != null && resolve(options.repoRoot) !== resolve(cwd);
  // Root the bundled core assets resolve against (vs a local preset's folder).
  const coreAssets = resolve(getCoreRoot(), "core-assets");
  const skipped: Array<{ path: string; reason: string }> = [];
  const warnings: string[] = [];
  const pending: Array<{ path: string; content: string; status: RenderStatus; chmodExec?: boolean }> = [];
  // `inspected` counts every destination file the adapter looked at this
  // render (whether it changed or not). The render command uses it to
  // surface "n unchanged" so a no-op render doesn't look like the engine
  // never ran.
  let inspected = 0;

  // 1. CLAUDE.md — delegated to existing planner
  const claudeMdPath = join(cwd, "CLAUDE.md");
  const claudeMdExisting = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, "utf-8") : "";
  const claudeMdPlan = computeRenderPlan(claudeMdExisting, config, repoRoot, {
    skipIds: options.skipIds,
    forceIds: options.forceIds,
    omitRootOnly: isWorkspace,
  });
  inspected += 1;

  // 1b. Skills index — a managed block in CLAUDE.md listing the skills agents
  // can apply: core (always) + preset + library (detected from deps) +
  // project-local. Rendered whenever there's anything to list (core skills are
  // always present), so detected library/preset skills are discoverable even
  // when the repo declares no project-local skills. The block is stripped only
  // when the body comes back empty.
  const localSkills = config.project?.localSkills ?? [];
  let claudeMdContent = claudeMdPlan.next;
  const skillsIndexBody = buildSkillsIndexBody(config, localSkills, repoRoot);
  if (skillsIndexBody !== null) {
    const result = injectManagedSection(
      claudeMdContent,
      SKILLS_INDEX_ID,
      skillsIndexBody,
      CORE_META,
      "html",
      options.forceIds?.has(SKILLS_INDEX_ID) ?? false,
    );
    claudeMdContent = result.output;
    claudeMdPlan.entries.push({
      asset: { id: SKILLS_INDEX_ID, relPath: "(computed)" },
      source: "core",
      status: result.status,
      newContent: null,
    });
  } else {
    claudeMdContent = removeManagedSection(claudeMdContent, SKILLS_INDEX_ID);
  }

  // 1b-bis. Agents index — the catalog of leaf subagents the orchestrator (main
  // agent) can spawn, referenced by the "## Rol: orquestador" block. Claude-only
  // (subagents are a Claude Code capability); the agents-md engine drops it.
  const agentsIndexBody = buildAgentsIndexBody(config);
  if (agentsIndexBody !== null) {
    const result = injectManagedSection(
      claudeMdContent,
      AGENTS_INDEX_ID,
      agentsIndexBody,
      CORE_META,
      "html",
      options.forceIds?.has(AGENTS_INDEX_ID) ?? false,
    );
    claudeMdContent = result.output;
    claudeMdPlan.entries.push({
      asset: { id: AGENTS_INDEX_ID, relPath: "(computed)" },
      source: "core",
      status: result.status,
      newContent: null,
    });
  } else {
    claudeMdContent = removeManagedSection(claudeMdContent, AGENTS_INDEX_ID);
  }

  // 1c. Project context — the init questionnaire answers turned into active
  // rules (posture, rigor, architecture, critical areas, tests). Stripped when
  // nothing is set. Replaces the old user-section comment hints.
  const contextoBody = buildContextoProyectoBody(config);
  if (contextoBody !== null) {
    const result = injectManagedSection(
      claudeMdContent,
      CONTEXTO_PROYECTO_ID,
      contextoBody,
      CORE_META,
      "html",
      options.forceIds?.has(CONTEXTO_PROYECTO_ID) ?? false,
    );
    claudeMdContent = result.output;
    claudeMdPlan.entries.push({
      asset: { id: CONTEXTO_PROYECTO_ID, relPath: "(computed)" },
      source: "core",
      status: result.status,
      newContent: null,
    });
  } else {
    claudeMdContent = removeManagedSection(claudeMdContent, CONTEXTO_PROYECTO_ID);
  }

  // 1d. Canonical order. injectManagedSection appends a NEW block at the end of
  // an existing file, so a block introduced in a later release (or moved by
  // hand) lands out of its canonical slot — e.g. the orchestrator "centre of
  // gravity" block that must lead the file. Restore canonical order. No-op when
  // already ordered (so no spurious diff); skipped, with a warning, when the
  // user wove prose between blocks (moving them would orphan it).
  const reorder = reorderManagedBlocks(claudeMdContent, canonicalManagedOrder(config, repoRoot, isWorkspace));
  claudeMdContent = reorder.output;
  if (reorder.blockedByInterleaving) {
    warnings.push(
      "CLAUDE.md: los bloques managed están fuera del orden canónico, pero hay texto " +
        "tuyo intercalado entre bloques, así que no los reordené. Mueve ese texto arriba " +
        "del primer bloque managed o abajo del último para que navori pueda ordenarlos.",
    );
  }

  if (claudeMdContent !== claudeMdExisting) {
    pending.push({
      path: claudeMdPath,
      content: claudeMdContent,
      status: claudeMdExisting.length === 0 ? "created" : "updated",
    });
  }

  // Load enabled plugins once and thread the result through the steps that
  // need it (settings, scripts, skill injects). Was loaded twice before — once
  // here via planSettings and again for scripts/skills (issue #10).
  const enabledPlugins = loadEnabledPlugins(config.plugins).loaded;

  // 2. .claude/settings.json
  const settingsResult = planSettings(cwd, config, enabledPlugins, force);
  inspected += 1;
  if (settingsResult.kind === "skip") {
    skipped.push({ path: relative(cwd, settingsResult.path), reason: settingsResult.reason });
  } else if (settingsResult.kind === "write") {
    pending.push({
      path: settingsResult.path,
      content: settingsResult.content,
      status: settingsResult.status,
    });
  }

  // 3. Agents
  for (const agent of CORE_AGENTS) {
    if (!isAgentEnabled(config, agent.harnessKey)) continue;
    inspected += 1;
    applyManagedFilePlan(
      planManagedFile({
        cwd,
        assetRoot: coreAssets,
        assetRelPath: `agents/${agent.id}.md`,
        destRelPath: `.claude/agents/${agent.id}.md`,
        managedId: `${agent.id}-base`,
        config,
      }),
      cwd,
      pending,
      skipped,
    );
  }

  // 4. Skills (always on for now)
  for (const skillId of CORE_SKILLS) {
    inspected += 1;
    applyManagedFilePlan(
      planManagedFile({
        cwd,
        assetRoot: coreAssets,
        assetRelPath: `skills/${skillId}.md`,
        destRelPath: `.claude/skills/${skillId}.md`,
        managedId: `${skillId}-base`,
        config,
      }),
      cwd,
      pending,
      skipped,
    );
  }

  // 5. progress/ bootstrap (one-shot, never overwritten)
  inspected += 2;
  applyBootstrapPlan(
    planBootstrapFile({
      cwd,
      assetRelPath: "progress/current.md",
      destRelPath: `${config.progress?.dir ?? "progress"}/${config.progress?.currentFile ?? "current.md"}`,
      config,
    }),
    cwd,
    pending,
  );
  applyBootstrapPlan(
    planBootstrapFile({
      cwd,
      assetRelPath: "progress/history.md",
      destRelPath: `${config.progress?.dir ?? "progress"}/${config.progress?.historyFile ?? "history.md"}`,
      config,
    }),
    cwd,
    pending,
  );

  // 6. Defensive guard hook (always rendered — no config dependency).
  inspected += 1;
  applyManagedFilePlan(
    planManagedFile({
      cwd,
      assetRoot: coreAssets,
      assetRelPath: `hooks/guard-destructive.sh`,
      destRelPath: `.claude/hooks/guard-destructive.sh`,
      managedId: "guard-destructive-base",
      config,
    }),
    cwd,
    pending,
    skipped,
    /* chmodExec */ true,
  );

  // 6.1. Hook quality-gate (only if config has a fast gate)
  if (config.qualityGate?.fast) {
    inspected += 1;
    applyManagedFilePlan(
      planManagedFile({
        cwd,
        assetRoot: coreAssets,
        assetRelPath: `hooks/quality-gate-pre-commit.sh`,
        destRelPath: `.claude/hooks/quality-gate-pre-commit.sh`,
        managedId: "qg-pre-commit-base",
        config,
      }),
      cwd,
      pending,
      skipped,
      /* chmodExec */ true,
    );
  } else {
    warnings.push("quality-gate hook skipped: config.qualityGate.fast no está set");
  }

  // 6.5. Preset extras — stack-specific agents/skills/hooks the active preset
  // contributes on top of the core baseline. Same managed-file semantics as
  // CORE_AGENTS/CORE_SKILLS; the preset's `extras.{agents,skills,hooks}[]`
  // declares its own destination paths so a preset can target either the
  // `.claude/` tree or extend specific managed sub-blocks elsewhere.
  // A malformed preset surfaces via warning. A missing preset file also
  // surfaces — silent-skip masked the medusa-v2/medusa.json mismatch in
  // moonar where the backend workspace was missing the medusa skills.
  // Destination paths already claimed by core + preset skills. Library skills
  // (step 6.6) dedup against these so a preset that ships a skill at the same
  // path always wins over the auto-detected library version.
  const renderedSkillDests = new Set<string>(
    CORE_SKILLS.map((id) => `.claude/skills/${id}.md`),
  );
  if (config.preset && config.preset !== "custom") {
    let loaded = null;
    try {
      loaded = loadPreset(config.preset, repoRoot);
    } catch (err) {
      if (err instanceof PresetError) {
        warnings.push(`preset '${config.preset}' invalid: ${err.message}`);
      } else {
        throw err;
      }
    }
    if (!loaded) {
      warnings.push(
        `preset '${config.preset}' not found (no .navori/presets/${config.preset}/ nor bundled). ` +
          `Workspace will render with the core baseline only.`,
      );
    }
    if (loaded) {
      const allFileExtras: Array<{ extra: PresetExtraFile; exec: boolean }> = [
        ...loaded.def.extras.agents.map((e) => ({ extra: e, exec: false })),
        ...loaded.def.extras.skills.map((e) => ({ extra: e, exec: false })),
        ...loaded.def.extras.hooks.map((e) => ({ extra: e, exec: true })),
      ];
      for (const { extra, exec } of allFileExtras) {
        // A conditional extra whose condition is false is not materialized —
        // it never lands on disk and isn't counted as inspected.
        if (!extraConditionMet(extra, config)) continue;
        renderedSkillDests.add(extra.destRelPath);
        inspected += 1;
        applyManagedFilePlan(
          planManagedFile({
            cwd,
            assetRoot: loaded.assetRoot,
            assetRelPath: extra.relPath,
            destRelPath: extra.destRelPath,
            managedId: extra.id,
            config,
          }),
          cwd,
          pending,
          skipped,
          exec,
        );
      }
    }
  }

  // 6.6. Library skills — modular skills injected by dependency detection
  // (config.project.libraries), orthogonal to the active preset. Same
  // managed-file semantics as preset extras; deduped by destination against
  // core + preset skills so a preset never gets overwritten by a library skill.
  for (const id of config.project?.libraries ?? []) {
    const skill = librarySkillById(id);
    // An unknown id in config (stale/hand-edited) is ignored, not fatal.
    if (!skill) continue;
    const destRelPath = `.claude/skills/${id}.md`;
    if (renderedSkillDests.has(destRelPath)) continue;
    renderedSkillDests.add(destRelPath);
    inspected += 1;
    applyManagedFilePlan(
      planManagedFile({
        cwd,
        assetRoot: coreAssets,
        assetRelPath: `lib-skills/${id}.md`,
        destRelPath,
        // The managed-block id is the bare skill id — the SAME id the
        // express-mongoose preset used to write for mongoose/zod/joi before they
        // moved to this layer. On upgrade the marker is recognized and updated
        // in place; a distinct id (e.g. `${id}-lib`) would leave the preset-era
        // block untouched and append a duplicate block in the same file.
        managedId: id,
        config,
      }),
      cwd,
      pending,
      skipped,
    );
  }

  // 7. Plugin scripts (copy + interpolate to .claude/scripts/)
  for (const plugin of enabledPlugins) {
    for (const script of plugin.scriptAssets) {
      inspected += 1;
      const plan = planPluginScript(cwd, script, config);
      if (plan.kind === "write") {
        pending.push({
          path: plan.path,
          content: plan.content,
          status: plan.status,
          chmodExec: plan.exec,
        });
      }
    }
  }

  // 8. Plugin skills with `injectInto`: append as a managed sub-block at
  // the bottom of the target file. `injectManagedSection` handles dedup
  // by id (idempotent) and surfaces user-modified conflicts the same way
  // CLAUDE.md does.
  for (const plugin of enabledPlugins) {
    for (const skill of plugin.skillAssets) {
      if (!skill.injectInto) continue;
      inspected += 1;
      applySubBlockInject({
        cwd,
        plugin,
        skill,
        config,
        pending,
        skipped,
        warnings,
      });
    }
  }

  // 9. Backup + atomic writes
  let backupPath: string | null = null;
  benchMark("plan");
  const written: Array<{ path: string; status: RenderStatus }> = [];

  if (pending.length === 0) {
    return {
      written,
      skipped,
      warnings,
      backupPath: null,
      claudeMdEntries: claudeMdPlan.entries,
      updatesAvailable: claudeMdPlan.updatesAvailable,
      languageFallbacks: claudeMdPlan.languageFallbacks,
      inspected,
    };
  }

  // The writes below are atomic per-file but not transactional across files, so
  // a crash mid-loop leaves a partial tree. Write CLAUDE.md LAST (stable sort):
  // it's the file the user actually reads, so on a crash it stays at its intact
  // prior version while only the .claude/ subtree is partial — the least
  // surprising failure mode. Issue #71 item 10.
  pending.sort((a, b) => Number(a.path === claudeMdPath) - Number(b.path === claudeMdPath));

  if (!dryRun) {
    // Backup the full pre-render state of files navori owns. Recursive over
    // .claude/ but skipping settings.local.json (per-user, gitignored) and
    // progress/ (live state, not the kind of thing a snapshot helps with).
    // The CLAUDE.md file is included explicitly; future engines will add
    // their own roots here.
    const hasExistingTarget = pending.some((p) => existsSync(p.path));
    if (hasExistingTarget) {
      const handle = createBackup(cwd, ["CLAUDE.md", ".claude"], {
        exclude: [".claude/settings.local.json", ".claude/progress"],
      });
      if (handle.files.length > 0) {
        backupPath = handle.path;
        purgeOldBackups();
      }
    }

    // Log the backup path up front as an extra breadcrumb; the user-visible
    // copies are the render reporter (result.backupPath) and, on a mid-loop
    // crash, the RenderWriteError below (#77).
    if (backupPath) log.debug("pre-write backup", { path: backupPath });

    let current: string | null = null;
    try {
      for (const p of pending) {
        current = p.path;
        mkdirSync(dirname(p.path), { recursive: true });
        writeFileAtomic(p.path, p.content);
        log.debug("wrote", { path: relative(cwd, p.path), status: p.status });
        if (p.chmodExec) {
          try {
            chmodSync(p.path, 0o755);
          } catch {
            // best-effort; some filesystems (FAT) won't grant +x
          }
        }
        written.push({ path: relative(cwd, p.path), status: p.status });
      }
    } catch (err) {
      // A crash mid-loop leaves a partial tree and the return value (with its
      // backupPath) never lands — the error the user sees must carry the
      // recovery breadcrumb itself.
      const hint = backupPath ? ` Backup pre-escritura disponible en: ${backupPath}` : "";
      throw new RenderWriteError(
        `El render falló escribiendo ${current ?? "?"}: ${err instanceof Error ? err.message : String(err)}.${hint}`,
        backupPath,
      );
    }
  } else {
    for (const p of pending) {
      written.push({ path: relative(cwd, p.path), status: p.status });
    }
  }

  benchMark("write");
  return {
    written,
    skipped,
    warnings,
    backupPath,
    claudeMdEntries: claudeMdPlan.entries,
    updatesAvailable: claudeMdPlan.updatesAvailable,
    languageFallbacks: claudeMdPlan.languageFallbacks,
    inspected,
  };
}

// ─────────────────────────── helpers ───────────────────────────

function isAgentEnabled(
  config: NavoriConfig,
  key: keyof NonNullable<NavoriConfig["harness"]>,
): boolean {
  const h = config.harness;
  if (!h) return true; // default: render all agents
  return h[key] !== false;
}

type SettingsPlan =
  | { kind: "noop" }
  | { kind: "skip"; path: string; reason: string }
  | { kind: "write"; path: string; content: string; status: RenderStatus };

function planSettings(
  cwd: string,
  config: NavoriConfig,
  plugins: LoadedPlugin[],
  force = false,
): SettingsPlan {
  const path = join(cwd, ".claude/settings.json");
  const newSettings = buildClaudeSettings(config, plugins);
  const newJson = JSON.stringify(newSettings, null, 2) + "\n";

  if (!existsSync(path)) {
    return { kind: "write", path, content: newJson, status: "created" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    // Issue #4: with --force, regenerate even on parse error. The pre-render
    // backup (createBackup over .claude/) still snapshots the corrupt file
    // so the user can recover by hand if needed.
    if (force) {
      return { kind: "write", path, content: newJson, status: "updated" };
    }
    return {
      kind: "skip",
      path,
      reason: `settings.json no se pudo parsear como JSON: ${(err as Error).message}. Corré 'navori render --force --apply' para regenerar.`,
    };
  }

  if (!isNavoriOwnedSettings(parsed)) {
    // Issue #4: --force lets the user fully adopt a hand-written settings.json
    // (overwrite → navori-owned henceforth).
    if (force) {
      return { kind: "write", path, content: newJson, status: "updated" };
    }
    // Issue #69: coexist. Rather than skip (which left the guard hook written
    // but unregistered → dead), inject navori's defensive layers (guard +
    // quality-gate hooks, deny/ask rules) into the user's file, preserving all
    // their keys. Idempotent; the file stays hybrid (no `$navori.managed`).
    if (!isPlainObject(parsed)) {
      return {
        kind: "skip",
        path,
        reason: "settings.json no es un objeto JSON — no se puede fusionar. Corré 'navori render --force --apply' para regenerar.",
      };
    }
    const merged = mergeCoexistSettings(parsed, newSettings);
    const mergedJson = JSON.stringify(merged, null, 2) + "\n";
    if (mergedJson === readFileSync(path, "utf-8")) return { kind: "noop" };
    return { kind: "write", path, content: mergedJson, status: "updated" };
  }

  const current = readFileSync(path, "utf-8");
  if (current === newJson) return { kind: "noop" };
  return { kind: "write", path, content: newJson, status: "updated" };
}

interface ManagedFilePlanInput {
  cwd: string;
  /** Root `assetRelPath` resolves against (core-assets/ or a local preset folder). */
  assetRoot: string;
  assetRelPath: string;     // relative to assetRoot
  destRelPath: string;      // relative to cwd
  managedId: string;
  config: NavoriConfig;
}

type ManagedFilePlan =
  | { kind: "noop" }
  | { kind: "skip"; path: string; reason: string }
  | { kind: "write"; path: string; content: string; status: RenderStatus };

function planManagedFile(input: ManagedFilePlanInput): ManagedFilePlan {
  const assetPath = resolve(input.assetRoot, input.assetRelPath);
  const destPath = join(input.cwd, input.destRelPath);
  const existing = existsSync(destPath) ? readFileSync(destPath, "utf-8") : null;
  const result = renderManagedFile({
    assetPath,
    existingContent: existing,
    managedId: input.managedId,
    meta: CORE_META,
    config: input.config,
  });
  if (result.status === "unchanged") return { kind: "noop" };
  if (result.status === "user-modified-skipped") {
    return {
      kind: "skip",
      path: destPath,
      reason: "bloque managed editado por el usuario; resuelve con 'navori sync' o ajusta el destino a mano",
    };
  }
  return { kind: "write", path: destPath, content: result.content, status: result.status };
}

function applyManagedFilePlan(
  plan: ManagedFilePlan,
  cwd: string,
  pending: Array<{ path: string; content: string; status: RenderStatus; chmodExec?: boolean }>,
  skipped: Array<{ path: string; reason: string }>,
  chmodExec = false,
): void {
  if (plan.kind === "noop") return;
  if (plan.kind === "skip") {
    skipped.push({ path: relative(cwd, plan.path), reason: plan.reason });
    return;
  }
  pending.push({ path: plan.path, content: plan.content, status: plan.status, chmodExec });
}

interface BootstrapFilePlanInput {
  cwd: string;
  assetRelPath: string;     // relative to core-assets/
  destRelPath: string;      // relative to cwd
  config: NavoriConfig;
}

type BootstrapPlan =
  | { kind: "noop" }
  | { kind: "write"; path: string; content: string };

/**
 * Bootstrap a one-shot file: copy + interpolate ONCE if the destination
 * doesn't exist; never overwrite after. Used for progress/ files whose
 * content is live state owned by the user.
 */
function planBootstrapFile(input: BootstrapFilePlanInput): BootstrapPlan {
  const destPath = join(input.cwd, input.destRelPath);
  if (existsSync(destPath)) return { kind: "noop" };
  const assetPath = resolve(getCoreRoot(), "core-assets", input.assetRelPath);
  const raw = readFileSync(assetPath, "utf-8");
  return { kind: "write", path: destPath, content: interpolate(raw, input.config) };
}

function applyBootstrapPlan(
  plan: BootstrapPlan,
  _cwd: string,
  pending: Array<{ path: string; content: string; status: RenderStatus; chmodExec?: boolean }>,
): void {
  if (plan.kind === "noop") return;
  pending.push({ path: plan.path, content: plan.content, status: "created" });
}

/**
 * Append a plugin skill (declared with `injectInto`) as a managed sub-block
 * at the end of the target file. The sub-block is its own managed section
 * with id = skill id and source = the plugin package; it lives alongside
 * the base block (e.g. `leader-base`) and is regenerated independently.
 *
 * If the target file isn't being touched this render and doesn't exist on
 * disk (e.g. the corresponding agent is disabled in config.harness), the
 * inject is skipped silently — there's nothing to inject into.
 */
function applySubBlockInject(input: {
  cwd: string;
  plugin: LoadedPlugin;
  skill: LoadedPlugin["skillAssets"][number];
  config: NavoriConfig;
  pending: Array<{ path: string; content: string; status: RenderStatus; chmodExec?: boolean }>;
  skipped: Array<{ path: string; reason: string }>;
  warnings: string[];
}): void {
  const targetAbs = join(input.cwd, input.skill.injectInto!);

  let currentContent: string;
  const pendingEntry = input.pending.find((p) => p.path === targetAbs);
  if (pendingEntry) {
    currentContent = pendingEntry.content;
  } else if (existsSync(targetAbs)) {
    currentContent = readFileSync(targetAbs, "utf-8");
  } else {
    // Target absent — typically because the agent (`leader.md` and friends)
    // is disabled in `config.harness`. Surface this so the user knows the
    // plugin contribution was dropped silently, not lost to a bug.
    input.warnings.push(
      `skill '${input.skill.id}' (de @navori/plugin-${input.plugin.manifest.id}) no inyectado: target ${input.skill.injectInto} ausente (¿agente disabled en config.harness?)`,
    );
    return;
  }

  const rawSkill = readFileSync(input.skill.absPath, "utf-8");
  const skillBody = stripFrontmatter(rawSkill);
  const interpolated = interpolate(skillBody, input.config);

  const result = injectManagedSection(
    currentContent,
    input.skill.id,
    interpolated,
    {
      source: `@navori/plugin-${input.plugin.manifest.id}`,
      version: input.plugin.manifest.version,
    },
    "html",
  );

  if (result.status === "user-modified-skipped") {
    input.skipped.push({
      path: relative(input.cwd, targetAbs),
      reason: `sub-bloque '${input.skill.id}' (de @navori/plugin-${input.plugin.manifest.id}) editado por el usuario; resuelve con 'navori sync'`,
    });
    return;
  }
  if (result.status === "unchanged") return;

  if (pendingEntry) {
    pendingEntry.content = result.output;
    return;
  }
  input.pending.push({
    path: targetAbs,
    content: result.output,
    status: result.status,
  });
}

type PluginScriptPlan =
  | { kind: "noop" }
  | {
      kind: "write";
      path: string;
      content: string;
      status: RenderStatus;
      exec: boolean;
    };

/**
 * Plan one plugin script: read from the plugin package, interpolate
 * `{{...}}` placeholders against the config, compare to current dest
 * content. Plugin scripts are navori-owned entire files (no managed
 * markers / no user-section); any user edits are overwritten on the
 * next render that changes the rendered content.
 */
function planPluginScript(
  cwd: string,
  script: { src: string; dest: string; exec: boolean },
  config: NavoriConfig,
): PluginScriptPlan {
  const destPath = join(cwd, ".claude/scripts", script.dest);
  const raw = readFileSync(script.src, "utf-8");
  const interpolated = interpolate(raw, config);
  const existing = existsSync(destPath) ? readFileSync(destPath, "utf-8") : null;
  if (existing === interpolated) return { kind: "noop" };
  return {
    kind: "write",
    path: destPath,
    content: interpolated,
    status: existing === null ? "created" : "updated",
    exec: script.exec,
  };
}
