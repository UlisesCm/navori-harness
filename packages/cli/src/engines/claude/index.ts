import { existsSync, mkdirSync, readFileSync, readdirSync, chmodSync, rmSync, type Dirent } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { effectiveConfig, type NavoriConfig } from "../../lib/config.ts";
import type { MonorepoRenderContext } from "../../lib/monorepo.ts";
import { writeFileAtomic } from "../../lib/atomic.ts";
import { createBackup, purgeOldBackups } from "../../lib/backup.ts";
import { loadEnabledPlugins, loadDisabledPlugins, type LoadedPlugin } from "../../lib/plugins.ts";
import { computeRenderPlan, canonicalManagedOrder, type AssetPlanEntry, type UpdateAvailable, type RenderScope } from "../../lib/render-plan.ts";
import { loadPreset, PresetError, type PresetExtraFile } from "../../lib/presets.ts";
import { librarySkillById, LIBRARY_SKILLS, REMOVED_LIB_SKILLS } from "../../lib/library-skills.ts";
import {
  loadFeature,
  featureExists,
  featureSource,
  listFeatureIds,
  FeatureError,
  type FeatureManifest,
} from "../../lib/features.ts";
import { getCoreRoot, readCliVersion } from "../../lib/bundled-assets.ts";
import {
  resolveGlobalSkillAsset,
  globalSkillAuxFiles,
  globalSkillMarkerSource,
} from "../../lib/global-skills.ts";
import {
  injectManagedSection,
  removeManagedSection,
  reorderManagedBlocks,
  resolveCondition,
  splitUserSection,
  emitUserSection,
} from "../../lib/marker.ts";
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
  /** Managed blocks written by a NEWER navori and preserved, not overwritten
   * (anti-retroceso, #79). Surfaced so `update`/`render` warn the user their
   * CLI is behind. */
  downgrades: UpdateAvailable[];
  /** CLAUDE.md assets that fell back to Spanish because language="en" lacks them. */
  languageFallbacks: string[];
  /** Total number of destination files inspected this render. `inspected -
   * written.length - skipped.length` = how many were already up to date. */
  inspected: number;
  /** Output-style activation outcome (global scope only; undefined otherwise or
   * when settings.json was skipped). Surfaces what happened to settings.json's
   * `outputStyle` key so the command reporter can tell the user whether navori
   * was activated, an existing style was preserved, or activation was opted out. */
  outputStyle?: OutputStyleOutcome;
}

/**
 * What a render did to settings.json's `outputStyle` key (spec: global persona
 * output style). `existing` carries the prior style name when it's relevant to
 * the message (a preserved non-navori style, so the reporter can tell the user
 * which one and how to switch).
 */
export type OutputStyleOutcome =
  | { kind: "activated"; existing?: string }
  | { kind: "already-active" }
  | { kind: "preserved-existing"; existing: string }
  | { kind: "opted-out"; existing?: string }
  | { kind: "deactivated" }
  | { kind: "unmanaged"; existing?: string };

/** Per-render output-style policy the global command computes from config+flags. */
interface OutputStyleOptions {
  /** Manage the navori style file at all (config.outputStyle). false → cleanup. */
  manage: boolean;
  /** `--recommended`/`--yes`: activate navori even over an existing other style. */
  forceActivate: boolean;
  /** `--no-output-style`: never activate this run (file may still be written). */
  optOut: boolean;
}

const CORE_AGENTS: ReadonlyArray<{ id: string; harnessKey: keyof NonNullable<NavoriConfig["harness"]> }> = [
  { id: "leader", harnessKey: "leader" },
  { id: "implementer", harnessKey: "implementer" },
  { id: "reviewer", harnessKey: "reviewer" },
  { id: "researcher", harnessKey: "researcher" },
  { id: "ticket-audit", harnessKey: "ticketAudit" },
  { id: "commit-pr-pilot", harnessKey: "commitPrPilot" },
  { id: "explorer", harnessKey: "explorer" },
  { id: "auditor", harnessKey: "auditor" },
  // Review lenses (R1-R4) — single-lens read-only reviewers that complement
  // `reviewer` on high-risk diffs. They reuse the `reviewer` harness toggle
  // (and its models/effort config keys) rather than getting their own
  // config surface: turning `reviewer` off turns the lenses off too.
  { id: "review-risk", harnessKey: "reviewer" },
  { id: "review-resilience", harnessKey: "reviewer" },
  { id: "review-readability", harnessKey: "reviewer" },
  { id: "review-reliability", harnessKey: "reviewer" },
];

const CORE_SKILLS: ReadonlyArray<string> = ["verify-before-done", "loop-back-debug", "review-diff"];

/**
 * Workflow skills — always-on process skills (ticket pipeline, PR flow) that are
 * stack-agnostic, so they render for every preset, not just backend ones. Unlike
 * CORE_SKILLS they keep a BARE managed-id (matching the id the express preset
 * wrote before they were promoted here), so an `update` recognizes the existing
 * block in place instead of orphaning it and appending a duplicate.
 */
const WORKFLOW_SKILLS: ReadonlyArray<string> = ["ticket-intake", "pr-create", "spec-bootstrap"];

// Managed blocks stamp the navori release version (bumps every release) so the
// anti-retroceso guard has a per-release signal — not @navori/core's static
// version. `source` still records provenance. See render-plan NAVORI_VERSION (#79).
const NAVORI_VERSION = readCliVersion();
const CORE_META = { source: "@navori/core" as const, version: NAVORI_VERSION };

/** Managed-block id for the skills index injected into CLAUDE.md. */
const SKILLS_INDEX_ID = "skills-index";

/**
 * Neutral defaults for the repo-flavored `{{...}}` template vars the 6 core
 * skills reference (pr-create's `{{prTarget}}`/`{{branchBase}}`,
 * verify-before-done's `{{qualityGate.fast}}`, …). At REPO scope these
 * resolve against the actual project config (effectiveConfig() derives
 * prTarget from branchBase; qualityGate.* come straight from config). At
 * GLOBAL scope there is no repo to read — the persona skill loads into
 * whatever repo the agent happens to be working in — so `interpolate()`
 * would otherwise fall back to generic `<not configured: x>` / a
 * "run 'navori configure quality-gate'" prompt that doesn't make sense
 * outside a repo. These extraVars override that with phrasing that reads
 * correctly regardless of which repo is open, without inventing per-repo
 * values the persona can't actually know. Single source so no globally
 * rendered skill ever ships a literal unresolved `{{...}}` (interpolate()
 * always substitutes SOMETHING, but the default fallback text is repo-scope
 * phrasing — this is what makes it read right at global scope too).
 */
const GLOBAL_SKILL_TEMPLATE_DEFAULTS: Record<string, string> = {
  prTarget: "main",
  branchBase: "main",
  "qualityGate.fast": "run the repo quality gate",
  "qualityGate.full": "run the repo quality gate",
};

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
  for (const id of WORKFLOW_SKILLS) {
    rows.push(`- \`${id}\` — navori (workflow)`);
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
  // Active features render as mother skills under `.claude/skills/<id>/SKILL.md`;
  // list the ones that resolve so agents discover them (Claude Code autoloads the
  // dir regardless, this is the navigation aid). Unknown ids are surfaced by
  // doctor, not listed here.
  for (const id of config.features ?? []) {
    if (listed.has(id) || !featureExists(id, repoRoot)) continue;
    rows.push(`- \`${id}\` — feature`);
    listed.add(id);
  }
  for (const name of localSkills) {
    // Deterministic from config: point at the skills root, not a concrete file —
    // whether the skill is a flat `<id>.md` or a `<id>/SKILL.md` directory is an
    // on-disk detail (the header explains both forms). Resolving it here would
    // make the managed block depend on filesystem state and drift between
    // checkouts. doctor is where the on-disk existence check belongs.
    rows.push(`- \`${name}\` — project-local (\`.claude/skills/${name}\`)`);
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
    "Skills que los agentes pueden aplicar; cada uno vive en `.claude/skills/` (un `<id>.md` o un directorio `<id>/SKILL.md`).",
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
  auditor: "Auditoría read-only a fondo de código existente (seguridad, performance, SOLID, edge cases). Escribe reporte + plan priorizado a disco.",
  // Review lenses (R1-R4) — selección por perfil de riesgo documentada en la
  // tabla 4R de "orquestacion.md" (§ Lentes de review 4R).
  "review-risk": "Lente read-only de seguridad, permisos, datos y dependencias sobre un diff de riesgo; selección en la tabla 4R de orquestación.",
  "review-readability": "Lente read-only de naming, complejidad y mantenibilidad sobre un diff; selección en la tabla 4R de orquestación.",
  "review-reliability": "Lente read-only de tests, comportamiento y regresiones sobre un diff; selección en la tabla 4R de orquestación.",
  "review-resilience": "Lente read-only de fallas, retries y degradación sobre un diff; selección en la tabla 4R de orquestación.",
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

/** Managed-block id for the monorepo map (workspace tree) injected into CLAUDE.md. */
const CONTEXTO_MONOREPO_ID = "contexto-monorepo";

/**
 * The "## Monorepo" map block. At the ROOT it lists every workspace so the
 * orchestrator routes each task to the owning app; inside a WORKSPACE it names
 * the current app and its siblings. Returns null (block stripped) when the repo
 * is not a monorepo — no workspaces at root, no context in a workspace.
 */
function buildContextoMonorepoBody(
  config: NavoriConfig,
  mono: MonorepoRenderContext | undefined,
  isWorkspace: boolean,
): string | null {
  if (isWorkspace) {
    if (!mono) return null;
    const tool = mono.tool ?? "pnpm";
    const lines: string[] = [
      `## Monorepo — workspace \`${mono.currentName}\``,
      "",
      `Eres el workspace **\`${mono.currentName}\`** (\`${mono.currentPath}\`) de un monorepo \`${tool}\`. Tienes tu propio harness (este \`CLAUDE.md\` + \`.claude/\`); la config raíz y los archivos transversales (\`turbo.json\`, \`pnpm-workspace.yaml\`, tsconfig/eslint base) viven en el repo root.`,
      "",
    ];
    if (mono.siblings.length > 0) {
      lines.push("Workspaces hermanos — no los edites desde aquí; el trabajo en un hermano se hace desde su propio harness:");
      for (const s of mono.siblings) {
        lines.push(`- \`${s.name}\` — \`${s.path}\`${s.preset ? ` (${s.preset})` : ""}`);
      }
    } else {
      lines.push("Por ahora es el único workspace declarado.");
    }
    lines.push("");
    lines.push(
      `Corre tareas scopeadas con \`--filter=${mono.currentName}\`. No importes código de un hermano por ruta relativa; consúmelo como paquete (\`workspace:*\`).`,
    );
    lines.push("");
    return lines.join("\n");
  }

  // Root render: read the workspace list straight off the config.
  const workspaces = config.monorepo?.workspaces ?? [];
  if (workspaces.length === 0) return null;
  const tool = config.monorepo?.tool ?? "pnpm";
  const lines: string[] = [
    "## Monorepo — raíz",
    "",
    `Este repo es un monorepo \`${tool}\`. El código real vive en los workspaces, cada uno con su propio harness (\`CLAUDE.md\` + \`.claude/\`). Al orquestar, **enruta cada tarea al workspace dueño** y trabaja desde su \`CLAUDE.md\`, no desde aquí.`,
    "",
    "Workspaces:",
  ];
  for (const w of workspaces) {
    lines.push(`- \`${w.name}\` — \`${w.path}\`${w.preset ? ` (${w.preset})` : ""}`);
  }
  lines.push("");
  return lines.join("\n");
}

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

  const migrations =
    (proj.libraryMigrations as Array<{ legacy: string; preferred: string; domain: string }> | undefined) ?? [];
  for (const m of migrations) {
    rows.push(
      `- **${m.domain} (migración):** en código nuevo usa \`${m.preferred}\`. \`${m.legacy}\` es legacy — no lo agregues; si tocas un módulo que lo usa, migra ese módulo completo (no mezcles ambos en el mismo archivo). El reviewer marca ALTO el uso nuevo de \`${m.legacy}\`.`,
    );
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
    /**
     * Monorepo facts for a WORKSPACE render, so the workspace's "## Monorepo"
     * block can name the current app + its siblings. Only set by the workspace
     * loop in `render`; absent at the root (the root reads `config.monorepo`).
     */
    monorepoContext?: MonorepoRenderContext;
    /**
     * Render target (spec 0005). `repo` (default) writes the project harness
     * into `<cwd>/CLAUDE.md` + `<cwd>/.claude/…`. `global` writes the persona
     * identity into `<cwd>/CLAUDE.md` + `<cwd>/…` (flat, no nested `.claude/`) —
     * ONLY the scope global/both CLAUDE.md blocks plus permissions; no agents,
     * skills, hooks, scripts, preset extras or progress. For a global render the
     * caller passes the global config dir as `cwd`.
     */
    scope?: RenderScope;
    /** Skip writing settings.json entirely (global target with permissions off). */
    omitSettings?: boolean;
    /**
     * Output-style policy (global scope only; ignored for repo). Drives whether
     * `<dotDir>/output-styles/navori.md` is written/removed and whether navori is
     * activated in settings.json. Defaults to `{ manage: true, forceActivate:
     * false, optOut: false }` at global scope when omitted.
     */
    outputStyle?: OutputStyleOptions;
    /**
     * Global skills catalog selection (spec 0005 — `navori global init`'s
     * skills multiselect; global scope only, ignored for repo). Keyed by
     * catalog id (`lib/global-skills.ts`); an id outside the catalog or with
     * `enabled !== true` is skipped. Renders as `skills/<id>/SKILL.md` (+ any
     * aux files) through the same managed-file pipeline as the bootstrap
     * launchers above.
     */
    globalSkills?: Record<string, { enabled: boolean }>;
  } = {},
): ClaudeEngineResult {
  // Fill in render-only derived defaults (e.g. prTarget ?? branchBase) so
  // templates interpolate against a complete config without persisting it.
  const config = effectiveConfig(inputConfig);
  const dryRun = options.dryRun === true;
  const force = options.force === true;
  const scope: RenderScope = options.scope ?? "repo";
  // Target layout (spec 0005): repo nests `.claude/` under cwd; the user-level
  // global layout is flat (agents/skills/settings sit directly under cwd, which
  // for a global render is the global config dir). `dotDir` is the ONLY path
  // that differs between targets — CLAUDE.md is `<cwd>/CLAUDE.md` for both.
  const dotDir = scope === "global" ? cwd : join(cwd, ".claude");
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
  // Carve off the user-authored zone BEFORE any managed-block work so inject/
  // reorder operate on the managed region alone and can never reubicate or
  // swallow the user's domain (the positional-preservation bug). It's re-emitted
  // verbatim, wrapped in explicit markers, at the very end (step 1e). Repos
  // onboarded before the markers existed get their trailing prose auto-migrated.
  const { managed: claudeMdManaged, userBody, hadMarkers: hadUserSection } = splitUserSection(claudeMdExisting);
  const claudeMdPlan = computeRenderPlan(claudeMdManaged, config, repoRoot, {
    skipIds: options.skipIds,
    forceIds: options.forceIds,
    omitRootOnly: isWorkspace,
    scope,
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
  // The computed identity blocks below (skills index, agents catalog, project +
  // monorepo context) are repo-scope only — the global persona target carries
  // none of them. At global scope each body is null, so the existing else branch
  // strips the id if a scope violation left one behind (spec 0005 §2.4).
  const skillsIndexBody = scope === "repo" ? buildSkillsIndexBody(config, localSkills, repoRoot) : null;
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
  const agentsIndexBody = scope === "repo" ? buildAgentsIndexBody(config) : null;
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
  const contextoBody = scope === "repo" ? buildContextoProyectoBody(config) : null;
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

  // 1c-bis. Monorepo map. At the root it lists the workspaces so the
  // orchestrator routes work to the owning app; inside a workspace it names the
  // current app + its siblings. Stripped for a non-monorepo repo.
  const monorepoBody = scope === "repo" ? buildContextoMonorepoBody(config, options.monorepoContext, isWorkspace) : null;
  if (monorepoBody !== null) {
    const result = injectManagedSection(
      claudeMdContent,
      CONTEXTO_MONOREPO_ID,
      monorepoBody,
      CORE_META,
      "html",
      options.forceIds?.has(CONTEXTO_MONOREPO_ID) ?? false,
    );
    claudeMdContent = result.output;
    claudeMdPlan.entries.push({
      asset: { id: CONTEXTO_MONOREPO_ID, relPath: "(computed)" },
      source: "core",
      status: result.status,
      newContent: null,
    });
  } else {
    claudeMdContent = removeManagedSection(claudeMdContent, CONTEXTO_MONOREPO_ID);
  }

  // 1d. Canonical order. injectManagedSection appends a NEW block at the end of
  // an existing file, so a block introduced in a later release (or moved by
  // hand) lands out of its canonical slot — e.g. the orchestrator "centre of
  // gravity" block that must lead the file. Restore canonical order. No-op when
  // already ordered (so no spurious diff); skipped, with a warning, when the
  // user wove prose between blocks (moving them would orphan it).
  const reorder = reorderManagedBlocks(claudeMdContent, canonicalManagedOrder(config, repoRoot, isWorkspace, scope));
  claudeMdContent = reorder.output;
  if (reorder.blockedByInterleaving) {
    warnings.push(
      "CLAUDE.md: los bloques managed están fuera del orden canónico, pero hay texto " +
        "tuyo intercalado entre bloques, así que no los reordené. Mueve ese texto arriba " +
        "del primer bloque managed o abajo del último para que navori pueda ordenarlos.",
    );
  }

  // 1e. Re-attach the user-authored zone, wrapped in explicit markers, after the
  // managed region. Emitted when there's domain to preserve, the file already had
  // the markers (keeps an already-delimited file idempotent), OR the file is new
  // (fresh CLAUDE.md ships the zone + a placeholder so the contract is visible);
  // a managed repo with no domain and no markers stays untouched (no spurious diff).
  if (userBody !== null || hadUserSection || claudeMdExisting.length === 0) {
    claudeMdContent = emitUserSection(claudeMdContent, userBody);
  } else if (claudeMdContent.length > 0 && !claudeMdContent.endsWith("\n")) {
    // Carving the user zone off left `managed` without the file's trailing
    // newline; with nothing re-emitted, restore it so a no-op render doesn't
    // strip the final "\n" (spurious one-time rewrite).
    claudeMdContent += "\n";
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

  // The output-style policy is global-scope only; repo renders never touch it.
  // Resolve the default here so both the activation (settings.json) and the file
  // write below read the same object.
  const outputStyleOpts: OutputStyleOptions | undefined =
    scope === "global"
      ? (options.outputStyle ?? { manage: true, forceActivate: false, optOut: false })
      : undefined;
  let outputStyleOutcome: OutputStyleOutcome | undefined;

  // 2. settings.json — repo: `.claude/settings.json`; global: `<dir>/settings.json`
  // (flat user layout). The global target ships permissions only (omitHooks): no
  // guard/quality-gate/plugin hooks, since it renders no `.claude/hooks/` scripts
  // and the ambient hook layer is P1. `omitSettings` skips it entirely (global
  // config with permissions off). At global scope the outputStyle policy also
  // sets/preserves the `outputStyle` key here (safety rules in planSettings).
  if (!options.omitSettings) {
    const settingsResult = planSettings(
      join(dotDir, "settings.json"),
      config,
      scope === "global" ? [] : enabledPlugins,
      force,
      { omitHooks: scope === "global", outputStyle: outputStyleOpts },
    );
    inspected += 1;
    // Only surface the outcome at global scope; repo renders don't manage an
    // output style (outputStyleOpts is undefined there → a "unmanaged" outcome
    // we must not leak).
    if (outputStyleOpts) outputStyleOutcome = settingsResult.outputStyleOutcome;
    if (settingsResult.kind === "skip") {
      skipped.push({ path: relative(cwd, settingsResult.path), reason: settingsResult.reason });
    } else if (settingsResult.kind === "write") {
      pending.push({
        path: settingsResult.path,
        content: settingsResult.content,
        status: settingsResult.status,
      });
    }
  }

  // Steps 3–8.7 build the repo project harness (agents, skills, hooks, scripts,
  // preset extras, progress, plugin sub-blocks). The global persona target has
  // none of them (spec 0005 P0) — only CLAUDE.md identity blocks + permissions —
  // so the whole block is repo-scope only. `scriptRemovals` is hoisted because
  // the write phase (step 9) reads it.
  const scriptRemovals: string[] = [];
  // Hoisted out of the repo-scope block (§8.8) because the write phase (step 9)
  // reads it to prune now-empty feature dirs — same reason `scriptRemovals` is
  // hoisted. At global scope it stays empty (no feature reconciler runs).
  const featureDirsToPrune: string[] = [];
  if (scope === "repo") {

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

  // 4b. Workflow skills — always-on, stack-agnostic process skills. Bare
  // managed-id (not `-base`) to match the block the express preset wrote before
  // these were promoted, so `update` refreshes in place instead of duplicating.
  for (const skillId of WORKFLOW_SKILLS) {
    inspected += 1;
    applyManagedFilePlan(
      planManagedFile({
        cwd,
        assetRoot: coreAssets,
        assetRelPath: `skills/${skillId}.md`,
        destRelPath: `.claude/skills/${skillId}.md`,
        managedId: skillId,
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
    [...CORE_SKILLS, ...WORKFLOW_SKILLS].map((id) => `.claude/skills/${id}.md`),
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

  // 6.7. Features — multi-phase workflows (spec 0004) rendered into the SKILLS
  // namespace as managed content: `.claude/skills/<id>/SKILL.md` (the FEATURE.md
  // orchestration doc as a mother skill, with manifest-derived frontmatter
  // carrying the triggers) + `.claude/skills/<id>/phases/<n>-<slug>.md` (each
  // phase doc, managed). Same managed-file machinery as core/preset/library
  // skills; the marker source is `@navori/feature-<id>` so drift and ownership
  // are attributed to the feature. An unknown/malformed feature id degrades to a
  // warning (doctor reports it) — never a hard failure.
  const activeFeatures = new Set<string>(config.features ?? []);
  for (const id of config.features ?? []) {
    let loaded;
    try {
      loaded = loadFeature(id, repoRoot);
    } catch (err) {
      if (err instanceof FeatureError) {
        warnings.push(`feature '${id}' invalid: ${err.message}`);
        continue;
      }
      throw err;
    }
    if (!loaded) {
      warnings.push(
        `feature '${id}' not found (no .navori/features/${id}/ nor bundled core-assets/features/${id}/). ` +
          `Skipped — 'navori doctor' lists it.`,
      );
      continue;
    }
    const meta = { source: featureSource(id), version: NAVORI_VERSION };
    // SKILL.md — FEATURE.md body wrapped with manifest-derived frontmatter.
    const featureMdPath = join(loaded.dir, "FEATURE.md");
    if (!existsSync(featureMdPath)) {
      warnings.push(`feature '${id}': FEATURE.md missing in ${loaded.dir}; SKILL.md not rendered`);
    } else {
      inspected += 1;
      applyManagedFilePlan(
        planManagedFile({
          cwd,
          assetRoot: loaded.dir,
          assetRelPath: "SKILL.md", // style inference only (rawContent wins)
          destRelPath: `.claude/skills/${id}/SKILL.md`,
          managedId: id,
          config,
          meta,
          rawContent: composeFeatureSkillMd(loaded.manifest, readFileSync(featureMdPath, "utf-8")),
        }),
        cwd,
        pending,
        skipped,
      );
    }
    // Phases — one managed reference doc per manifest phase, loaded on-demand
    // when that phase runs. Source filename convention is `<n>-<slug>.md`.
    for (const phase of loaded.manifest.phases) {
      const rel = `phases/${phase.n}-${phase.slug}.md`;
      const phaseAbs = join(loaded.dir, rel);
      if (!existsSync(phaseAbs)) {
        warnings.push(`feature '${id}': phase file ${rel} missing; not rendered`);
        continue;
      }
      inspected += 1;
      applyManagedFilePlan(
        planManagedFile({
          cwd,
          assetRoot: loaded.dir,
          assetRelPath: rel,
          destRelPath: `.claude/skills/${id}/${rel}`,
          managedId: `${id}-${phase.n}-${phase.slug}`,
          config,
          meta,
        }),
        cwd,
        pending,
        skipped,
      );
    }
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

  // 8. Plugin skills. Two shapes:
  //   - `injectInto` set: append as a managed sub-block at the bottom of the
  //     target file. `injectManagedSection` handles dedup by id (idempotent)
  //     and surfaces user-modified conflicts the same way CLAUDE.md does.
  //   - `injectInto` absent: a STANDALONE skill, written to its own
  //     `.claude/skills/<id>.md` — the same managed-file treatment library
  //     skills get (§6 above), but with plugin provenance in the marker
  //     (source `@navori/plugin-<id>`) instead of `@navori/core`, matching
  //     what applySubBlockInject stamps for this plugin's injectInto skills.
  for (const plugin of enabledPlugins) {
    for (const skill of plugin.skillAssets) {
      if (skill.injectInto) {
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
        continue;
      }
      inspected += 1;
      applyManagedFilePlan(
        planManagedFile({
          cwd,
          assetRoot: dirname(skill.absPath),
          assetRelPath: basename(skill.absPath),
          destRelPath: `.claude/skills/${skill.id}.md`,
          managedId: skill.id,
          config,
          meta: { source: `@navori/plugin-${plugin.manifest.id}`, version: NAVORI_VERSION },
        }),
        cwd,
        pending,
        skipped,
      );
    }
  }

  // 8.5. Reconcile DISABLED plugins. A plugin turned off (via `configure
  // plugins` or `navori remove`) still has its managed CLAUDE.md blocks stripped
  // by computeRenderPlan, but its injectInto sub-blocks (e.g. leader.md) and its
  // .claude/scripts/* were only ever touched on the enabled path — so they'd
  // orphan. Strip them here so disabling a plugin fully cleans up (#80).
  for (const plugin of loadDisabledPlugins(config.plugins).loaded) {
    for (const skill of plugin.skillAssets) {
      if (skill.injectInto) {
        inspected += 1;
        removeSubBlock({ cwd, skill, pending });
        continue;
      }
      // Standalone skill (no injectInto) — mirror §8.6's ownership check
      // before deleting: only remove a file carrying navori's OWN marker
      // for this id, never a user's hand-written skill of the same name.
      const destPath = join(cwd, ".claude/skills", `${skill.id}.md`);
      if (!existsSync(destPath)) continue;
      let content: string;
      try {
        content = readFileSync(destPath, "utf-8");
      } catch {
        continue; // unreadable — leave it rather than guess
      }
      if (!content.includes(`navori:managed id="${skill.id}"`)) continue;
      inspected += 1;
      scriptRemovals.push(destPath);
    }
    for (const script of plugin.scriptAssets) {
      const destPath = join(cwd, ".claude/scripts", script.dest);
      if (existsSync(destPath)) {
        inspected += 1;
        scriptRemovals.push(destPath);
      }
    }
  }

  // 8.6. Reconcile REMOVED library skills. A skill dropped from the registry
  // (a legacy lib we no longer teach) leaves a stale managed file on disk in
  // repos rendered before the removal. Delete ours — but only files carrying
  // navori's own marker for that id, never a user's hand-written skill of the
  // same name.
  for (const id of REMOVED_LIB_SKILLS) {
    const destPath = join(cwd, ".claude/skills", `${id}.md`);
    if (!existsSync(destPath)) continue;
    let content: string;
    try {
      content = readFileSync(destPath, "utf-8");
    } catch {
      continue; // unreadable — leave it rather than guess
    }
    if (!content.includes(`navori:managed id="${id}"`)) continue; // user's own — keep
    inspected += 1;
    scriptRemovals.push(destPath);
  }

  // 8.7. Reconcile ORPHANED library skills. A library skill navori materialized
  // in a PRIOR render — deselected from config.project.libraries, or shipped by
  // an older preset that has since moved it to this layer (e.g. express-mongoose
  // once shipped `zod-validation`) — lingers as a managed file navori no longer
  // renders, surfacing as permanent `doctor` drift. §8.5 (disabled-plugin assets)
  // and §8.6 (registry-removed libs) don't cover it.
  //
  // Scope is deliberately narrow — the KNOWN library-skill registry, NOT a
  // directory scan against `renderedSkillDests`. That set is only complete when
  // the render fully succeeded: a preset that fails to load, or a config library
  // id this binary's registry doesn't know, leaves valid destinations out of it,
  // and a dir-scan would then hard-delete still-valid managed files on a
  // recoverable error. Iterating LIBRARY_SKILLS instead means: preset extras and
  // core skills are never candidates (so a preset-load failure can't trigger a
  // false-positive deletion); a library still selected (even if unknown to this
  // binary — it stays in config.libraries) is never deleted; and basename == the
  // managed id by construction, so the marker check is exact. REMOVED ids aren't
  // in this registry — §8.6 owns those.
  const selectedLibs = new Set(config.project?.libraries ?? []);
  const localSkillIds = new Set(config.project?.localSkills ?? []);
  for (const { id } of LIBRARY_SKILLS) {
    if (selectedLibs.has(id)) continue; // currently selected — keep
    if (localSkillIds.has(id)) continue; // user reclaimed the id as a local skill — keep
    const abs = join(cwd, ".claude/skills", `${id}.md`);
    if (!existsSync(abs)) continue;
    let content: string;
    try {
      content = readFileSync(abs, "utf-8");
    } catch {
      continue; // unreadable — leave it rather than guess
    }
    if (!content.includes(`navori:managed id="${id}"`)) continue; // user's own — keep
    inspected += 1;
    scriptRemovals.push(abs);
  }

  // 8.8. Reconcile DEACTIVATED features. A feature removed from `config.features`
  // (or whose bundle was deleted) leaves its rendered `.claude/skills/<id>/` tree
  // on disk. Delete OURS — every file under the dir carrying the feature's marker
  // source — but never a user's hand-authored file (no navori marker) in the same
  // dir. Ownership is decided by scanning ALL `.md` files in the dir (recursive)
  // for `source="@navori/feature-<id>"`: SKILL.md is NOT special, so a feature
  // whose SKILL.md was hand-deleted while marked phase files remain is still
  // reconciled instead of orphaned forever. Disk-scan (not a static registry) so
  // deactivation works even when the source bundle is gone. Empty phase/feature
  // dirs are pruned after the file removals (a surviving user file keeps the dir).
  const skillsRoot = join(cwd, ".claude/skills");
  if (existsSync(skillsRoot)) {
    let entries: Dirent[];
    try {
      entries = readdirSync(skillsRoot, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const id = entry.name;
      if (activeFeatures.has(id)) continue; // active — rendered/updated above
      const featureDir = join(skillsRoot, id);
      const owned = collectFeatureOwnedFiles(featureDir, featureSource(id));
      if (owned.length === 0) continue; // none of ours here — keep (user's own dir)
      for (const abs of owned) {
        inspected += 1;
        scriptRemovals.push(abs);
      }
      featureDirsToPrune.push(featureDir);
    }
  }
  } // end repo-scope project harness (steps 3–8.8)

  // 8.85. Bootstrap feature launchers (GLOBAL scope only). A `kind: "bootstrap"`
  // feature (spec 0004, e.g. app-builder) CREATES the project — its phased
  // workflow can't be discovered from a repo render because no repo exists yet.
  // So the persona target renders one tiny launcher skill per bootstrap feature,
  // directory form (`skills/<id>/SKILL.md`), so a chat-only agent (spec 0005 —
  // e.g. Claude Code driven through OpenClaw on a VPS) can discover and offer
  // it before any repo exists. The launcher carries the manifest description
  // verbatim as its frontmatter `description` (same trigger-loading contract as
  // a repo feature skill) and tells the agent how to bootstrap — never the
  // mother skill or phase files, which only exist after a repo render. An
  // `in-repo` feature stays repo-scoped: no launcher. Same managed-file
  // machinery as a repo feature skill (marker-based, idempotent), so it
  // participates in `result.written` / preview like everything else.
  if (scope === "global") {
    for (const id of listFeatureIds(repoRoot)) {
      let loaded;
      try {
        loaded = loadFeature(id, repoRoot);
      } catch (err) {
        if (err instanceof FeatureError) {
          warnings.push(`feature '${id}' invalid: ${err.message}`);
          continue;
        }
        throw err;
      }
      if (!loaded || loaded.manifest.kind !== "bootstrap") continue;
      inspected += 1;
      applyManagedFilePlan(
        planManagedFile({
          cwd,
          assetRoot: loaded.dir,
          assetRelPath: "SKILL.md", // style inference only (rawContent wins)
          destRelPath: `skills/${id}/SKILL.md`,
          managedId: id,
          config,
          meta: { source: featureSource(id), version: NAVORI_VERSION },
          rawContent: composeBootstrapLauncherMd(loaded.manifest),
        }),
        cwd,
        pending,
        skipped,
      );
    }
  }

  // 8.86. Global skills catalog (GLOBAL scope only). Selected entries from
  // `lib/global-skills.ts` (`navori global init`'s skills multiselect) render
  // as `skills/<id>/SKILL.md`, dir form — same managed-file machinery as the
  // bootstrap launchers just above. Two provenances:
  //   - "core-skill": the flat `.md` files also used at repo scope
  //     (verify-before-done, pr-create, …), rendered here in DIR form since
  //     the persona target has no flat-skill convention.
  //   - "global-skill-dir": a skill promoted from the maintainer's personal
  //     `~/.claude/skills/<id>/`, content kept verbatim; any aux files
  //     (references/, assets/) ride alongside through their OWN managed-file
  //     entry (own managedId) so drift/status is reported per file, same
  //     pattern as a feature's phase docs (§6.7 above).
  // An id absent from the catalog (stale config from a removed skill, or a
  // typo) is silently skipped — `resolveGlobalSkillAsset` returns null — never
  // a hard failure; nothing here removes a PREVIOUSLY rendered skill when it's
  // disabled (no reconciler like §8.8's feature deactivation), so a disabled
  // skill's old files are left in place as documented orphans.
  if (scope === "global") {
    for (const [id, settings] of Object.entries(options.globalSkills ?? {})) {
      if (settings.enabled !== true) continue;
      const loc = resolveGlobalSkillAsset(id);
      if (!loc) continue; // unknown/stale id — config strips these on next init
      const meta = { source: globalSkillMarkerSource(id), version: NAVORI_VERSION };
      inspected += 1;
      applyManagedFilePlan(
        planManagedFile({
          cwd,
          assetRoot: loc.dir,
          assetRelPath: loc.entryFile,
          destRelPath: `skills/${id}/SKILL.md`,
          managedId: id,
          config,
          meta,
          extraVars: GLOBAL_SKILL_TEMPLATE_DEFAULTS,
        }),
        cwd,
        pending,
        skipped,
      );
      for (const rel of globalSkillAuxFiles(id)) {
        inspected += 1;
        applyManagedFilePlan(
          planManagedFile({
            cwd,
            assetRoot: loc.dir,
            assetRelPath: rel,
            destRelPath: `skills/${id}/${rel}`,
            managedId: `${id}-aux-${rel.replace(/[\\/]/g, "-")}`,
            config,
            meta,
            extraVars: GLOBAL_SKILL_TEMPLATE_DEFAULTS,
          }),
          cwd,
          pending,
          skipped,
        );
      }
    }
  }

  // 8.9. Output style (GLOBAL scope only). Write `<dotDir>/output-styles/navori.md`
  // VERBATIM from core-assets: the file's own YAML frontmatter (name / description
  // / keep-coding-instructions) must be the very first thing so Claude Code's
  // output-style loader parses it — so we do NOT run it through the managed-file
  // pipeline (which would drop the hyphenated `keep-coding-instructions` key and
  // wrap the body in markers). Ownership is by CONTENT HASH, no in-file marker:
  //   - manage=true: write when missing, refresh when the on-disk bytes differ
  //     from the bundled source (drift → re-sync), no-op when identical
  //     (idempotent). navori owns the `navori` style; fork it under another name
  //     to customize.
  //   - manage=false: remove ONLY a copy byte-identical to the bundled source —
  //     provably navori's own untouched output. A user's same-named style, or an
  //     edited one, never matches and is left in place (conservative on delete).
  if (scope === "global" && outputStyleOpts) {
    const stylePath = join(dotDir, "output-styles", "navori.md");
    const sourcePath = resolve(coreAssets, "output-styles", "navori.md");
    const source = readFileSync(sourcePath, "utf-8");
    const existing = existsSync(stylePath) ? readFileSync(stylePath, "utf-8") : null;
    inspected += 1;
    if (outputStyleOpts.manage) {
      if (existing === null) {
        pending.push({ path: stylePath, content: source, status: "created" });
      } else if (existing !== source) {
        pending.push({ path: stylePath, content: source, status: "updated" });
      }
    } else if (existing !== null && existing === source) {
      scriptRemovals.push(stylePath);
    }
  }

  // 9. Backup + atomic writes
  let backupPath: string | null = null;
  benchMark("plan");
  const written: Array<{ path: string; status: RenderStatus }> = [];

  if (pending.length === 0 && scriptRemovals.length === 0) {
    return {
      written,
      skipped,
      warnings,
      backupPath: null,
      claudeMdEntries: claudeMdPlan.entries,
      updatesAvailable: claudeMdPlan.updatesAvailable,
      downgrades: claudeMdPlan.downgrades,
      languageFallbacks: claudeMdPlan.languageFallbacks,
      inspected,
      outputStyle: outputStyleOutcome,
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
    const hasExistingTarget = pending.some((p) => existsSync(p.path)) || scriptRemovals.length > 0;
    if (hasExistingTarget) {
      // navori.config.json is the source of truth; snapshot it alongside the
      // rendered tree so a backup is a complete picture of the harness state
      // (#79/#82). It's checked into git too, but the backup keeps restore
      // self-contained.
      // The global target's layout is flat (CLAUDE.md + settings.json directly
      // under the dir); the repo target snapshots the whole `.claude/` tree +
      // the config source of truth (#79/#82). Both land under ~/.navori/backups.
      const handle =
        scope === "global"
          ? createBackup(cwd, ["CLAUDE.md", "settings.json", "output-styles"])
          : createBackup(cwd, ["CLAUDE.md", ".claude", "navori.config.json"], {
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
    // Delete disabled-plugin scripts (already captured in the backup above).
    for (const abs of scriptRemovals) {
      try {
        rmSync(abs, { force: true });
      } catch {
        // best-effort — a scripts dir the user chmod'd read-only shouldn't crash
      }
      written.push({ path: relative(cwd, abs), status: "removed-condition-false" });
    }
    // Prune now-empty feature dirs left by the deactivation reconciler (8.8).
    // Only rmdir when empty so a user file dropped inside is never destroyed.
    pruneEmptyFeatureDirs(featureDirsToPrune);
  } else {
    for (const p of pending) {
      written.push({ path: relative(cwd, p.path), status: p.status });
    }
    for (const abs of scriptRemovals) {
      written.push({ path: relative(cwd, abs), status: "removed-condition-false" });
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
    downgrades: claudeMdPlan.downgrades,
    languageFallbacks: claudeMdPlan.languageFallbacks,
    inspected,
    outputStyle: outputStyleOutcome,
  };
}

// ─────────────────────────── helpers ───────────────────────────

/**
 * Compose the source of a feature's `SKILL.md`: the FEATURE.md orchestration doc
 * (frontmatter, if any, stripped) under a fresh frontmatter block derived from
 * the manifest — `name` (feature id), `description` (carries the triggers Claude
 * Code loads the mother skill on), `type: feature`. The result flows through the
 * normal managed-file renderer (marker + frontmatter merge) like any skill.
 */
function composeFeatureSkillMd(manifest: FeatureManifest, featureMd: string): string {
  const body = stripFrontmatter(featureMd).trim();
  const fm = [
    "---",
    `name: ${manifest.id}`,
    `description: ${yamlScalar(manifest.description)}`,
    "type: feature",
    "---",
  ].join("\n");
  return `${fm}\n\n${body}\n`;
}

/**
 * Serialize a manifest string as a single-line double-quoted YAML flow scalar
 * (JSON string syntax is valid YAML). The frontmatter pipeline is line-based
 * (parse/merge/serialize per `key: value` line), so a raw multi-line value —
 * the manifest schema allows newlines, even a literal `---` line — would get
 * truncated at the first newline or leak past the closing fence into the body.
 * JSON.stringify escapes newlines/quotes and keeps the value on one line.
 */
function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

/**
 * Compose the source of a bootstrap feature's GLOBAL launcher `SKILL.md`
 * (spec 0005 bootstrap discovery). Frontmatter carries only `name` + the
 * manifest `description` verbatim (the triggers Claude Code loads it on) —
 * no `type` key, since this is a launcher, not the mother skill. The body
 * tells a chat-only agent how to bootstrap: create/choose a fresh project
 * directory, run `navori init --feature <id> --recommended` there, then follow
 * the feature skill THAT render produces for the phased workflow. The user's
 * conversational request is the consent (spec 0005 §2.1 — detection is
 * automatic, writes always require consent); `navori init` writes only inside
 * the new project directory, never here.
 */
function composeBootstrapLauncherMd(manifest: FeatureManifest): string {
  const fm = ["---", `name: ${manifest.id}`, `description: ${yamlScalar(manifest.description)}`, "---"].join("\n");
  const body = `# ${manifest.displayName}

${manifest.displayName} is a bootstrap feature: it creates a brand-new project end-to-end, phase by phase, behind a quality gate between phases. It has no repo yet — this launcher is how you discover and start it.

## Before running anything

The user's conversational request for this deliverable IS the consent. Do not run \`navori init\` speculatively, and never outside a project directory the user chose for this.

## How to bootstrap

1. Create or pick a fresh, empty project directory for the new project — never the directory this launcher lives in.
2. Inside that new directory, run: \`navori init --feature ${manifest.id} --recommended\`. This writes ONLY inside that new project directory.
3. Once init finishes, follow the feature skill it rendered into the new repo (\`.claude/skills/${manifest.id}/SKILL.md\`) for the full phased workflow.
`;
  return `${fm}\n\n${body}`;
}

/**
 * Every `.md` file under a feature's rendered directory that carries the given
 * marker source — the ownership-guarded set safe to delete when the feature is
 * deactivated. A sibling file the user dropped in (no navori marker) is left out.
 */
function collectFeatureOwnedFiles(featureDir: string, source: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        try {
          if (readFileSync(abs, "utf-8").includes(`source="${source}"`)) out.push(abs);
        } catch {
          // unreadable — skip (leave on disk rather than guess)
        }
      }
    }
  };
  walk(featureDir);
  return out;
}

/** rmdir each feature dir (and its `phases/` subdir) when empty, after the
 * ownership-guarded file removals. Never recursive — a user file left inside
 * keeps the dir alive. */
function pruneEmptyFeatureDirs(featureDirs: readonly string[]): void {
  for (const dir of featureDirs) {
    for (const sub of [join(dir, "phases"), dir]) {
      try {
        // Only rmdir when empty (verified here) — a user file left inside keeps
        // the dir alive. `recursive` is harmless on a dir already known empty.
        if (existsSync(sub) && readdirSync(sub).length === 0) rmSync(sub, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  }
}

function isAgentEnabled(
  config: NavoriConfig,
  key: keyof NonNullable<NavoriConfig["harness"]>,
): boolean {
  const h = config.harness;
  if (!h) return true; // default: render all agents
  return h[key] !== false;
}

type SettingsPlan =
  | { kind: "noop"; outputStyleOutcome?: OutputStyleOutcome }
  | { kind: "skip"; path: string; reason: string; outputStyleOutcome?: OutputStyleOutcome }
  | { kind: "write"; path: string; content: string; status: RenderStatus; outputStyleOutcome?: OutputStyleOutcome };

/**
 * Read the current top-level `outputStyle` name from a parsed settings.json.
 * Returns undefined when absent, empty, or not a string.
 */
function readOutputStyle(parsed: unknown): string | undefined {
  if (!isPlainObject(parsed)) return undefined;
  const v = parsed.outputStyle;
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Decide what to do with settings.json's `outputStyle` key given the current
 * value + policy. Pure — returns the outcome; the caller mutates the settings
 * object. Safety rules (spec: global persona output style):
 *   - no output style set        → activate navori (fresh profile adopts it).
 *   - already "navori"           → keep (idempotent).
 *   - another style + --recommended/--yes → activate navori (headless opt-in).
 *   - another style + normal run → PRESERVE it, report how to switch.
 *   - --no-output-style          → never activate (preserve whatever exists).
 *   - manage=false               → drop navori if we set it; else preserve.
 */
function decideOutputStyle(
  existing: string | undefined,
  opts: OutputStyleOptions | undefined,
): OutputStyleOutcome {
  if (!opts || !opts.manage) {
    if (existing === "navori") return { kind: "deactivated" };
    return { kind: "unmanaged", existing };
  }
  if (opts.optOut) return { kind: "opted-out", existing };
  if (existing === "navori") return { kind: "already-active" };
  if (existing === undefined) return { kind: "activated" };
  // existing is some OTHER style — only override under an explicit opt-in.
  if (opts.forceActivate) return { kind: "activated", existing };
  return { kind: "preserved-existing", existing };
}

/**
 * Apply the outputStyle decision to a settings object being fully (re)written.
 * Sets `outputStyle: "navori"` when activating, preserves an existing non-navori
 * value when we must NOT override it (so a full rewrite never silently drops the
 * user's style), and removes it on deactivation. Returns the outcome.
 */
function applyOutputStyleToFullSettings(
  settings: Record<string, unknown>,
  existing: string | undefined,
  opts: OutputStyleOptions | undefined,
): OutputStyleOutcome {
  const outcome = decideOutputStyle(existing, opts);
  switch (outcome.kind) {
    case "activated":
    case "already-active":
      settings.outputStyle = "navori";
      break;
    case "preserved-existing":
    case "opted-out":
    case "unmanaged":
      if (existing !== undefined) settings.outputStyle = existing;
      break;
    case "deactivated":
      delete settings.outputStyle;
      break;
  }
  return outcome;
}

function planSettings(
  path: string,
  config: NavoriConfig,
  plugins: LoadedPlugin[],
  force = false,
  options: { omitHooks?: boolean; outputStyle?: OutputStyleOptions } = {},
): SettingsPlan {
  const newSettings = buildClaudeSettings(config, plugins, { omitHooks: options.omitHooks });
  const os = options.outputStyle;

  if (!existsSync(path)) {
    const outputStyleOutcome = applyOutputStyleToFullSettings(newSettings, undefined, os);
    const newJson = JSON.stringify(newSettings, null, 2) + "\n";
    return { kind: "write", path, content: newJson, status: "created", outputStyleOutcome };
  }

  const rawExisting = readFileSync(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawExisting);
  } catch (err) {
    // Issue #4: with --force, regenerate even on parse error. The pre-render
    // backup (createBackup over .claude/) still snapshots the corrupt file
    // so the user can recover by hand if needed.
    if (force) {
      const outputStyleOutcome = applyOutputStyleToFullSettings(newSettings, undefined, os);
      return { kind: "write", path, content: JSON.stringify(newSettings, null, 2) + "\n", status: "updated", outputStyleOutcome };
    }
    return {
      kind: "skip",
      path,
      reason: `settings.json no se pudo parsear como JSON: ${(err as Error).message}. Corre 'navori render --force --apply' para regenerar.`,
    };
  }

  const existingStyle = readOutputStyle(parsed);

  if (!isNavoriOwnedSettings(parsed)) {
    // Issue #4: --force lets the user fully adopt a hand-written settings.json
    // (overwrite → navori-owned henceforth).
    if (force) {
      const outputStyleOutcome = applyOutputStyleToFullSettings(newSettings, existingStyle, os);
      return { kind: "write", path, content: JSON.stringify(newSettings, null, 2) + "\n", status: "updated", outputStyleOutcome };
    }
    // Issue #69: coexist. Rather than skip (which left the guard hook written
    // but unregistered → dead), inject navori's defensive layers (guard +
    // quality-gate hooks, deny/ask rules) into the user's file, preserving all
    // their keys. Idempotent; the file stays hybrid (no `$navori.managed`).
    if (!isPlainObject(parsed)) {
      return {
        kind: "skip",
        path,
        reason: "settings.json no es un objeto JSON — no se puede fusionar. Corre 'navori render --force --apply' para regenerar.",
      };
    }
    const merged = mergeCoexistSettings(parsed, newSettings);
    // mergeCoexistSettings preserves every user key (incl. an existing
    // outputStyle). Only mutate outputStyle when the decision changes it.
    const outputStyleOutcome = decideOutputStyle(existingStyle, os);
    if (outputStyleOutcome.kind === "activated" || outputStyleOutcome.kind === "already-active") {
      merged.outputStyle = "navori";
    } else if (outputStyleOutcome.kind === "deactivated") {
      delete merged.outputStyle;
    }
    const mergedJson = JSON.stringify(merged, null, 2) + "\n";
    if (mergedJson === rawExisting) return { kind: "noop", outputStyleOutcome };
    return { kind: "write", path, content: mergedJson, status: "updated", outputStyleOutcome };
  }

  const outputStyleOutcome = applyOutputStyleToFullSettings(newSettings, existingStyle, os);
  const newJson = JSON.stringify(newSettings, null, 2) + "\n";
  if (rawExisting === newJson) return { kind: "noop", outputStyleOutcome };
  return { kind: "write", path, content: newJson, status: "updated", outputStyleOutcome };
}

interface ManagedFilePlanInput {
  cwd: string;
  /** Root `assetRelPath` resolves against (core-assets/ or a local preset folder). */
  assetRoot: string;
  assetRelPath: string;     // relative to assetRoot
  destRelPath: string;      // relative to cwd
  managedId: string;
  config: NavoriConfig;
  /** Open-marker provenance / marker metadata to stamp. Defaults to CORE_META
   * (core/library assets). A plugin-owned standalone skill passes its own
   * `@navori/plugin-<id>` source so the marker matches the one
   * applySubBlockInject stamps for injectInto skills of the same plugin;
   * features pass their own `@navori/feature-<id>` source so drift/ownership is
   * attributed correctly. */
  meta?: { source: string; version: string };
  /** Pre-composed source content — when set, the asset is rendered from this
   * string instead of read from `assetPath` (features synthesize the SKILL.md
   * source from the manifest + FEATURE.md). `assetRelPath` still drives comment
   * style inference (keep it a `.md` path). */
  rawContent?: string;
  /** Extra `{{path}}` substitutions consulted before the config (see
   * `interpolate()`). Used by the global skills catalog to give repo-flavored
   * vars (`{{prTarget}}`, `{{qualityGate.fast}}`, …) a neutral, scope-appropriate
   * value instead of the repo-oriented fallback prose. */
  extraVars?: Record<string, string>;
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
    rawContent: input.rawContent,
    existingContent: existing,
    managedId: input.managedId,
    meta: input.meta ?? CORE_META,
    config: input.config,
    extraVars: input.extraVars,
  });
  if (result.status === "unchanged") return { kind: "noop" };
  if (result.status === "user-modified-skipped") {
    return {
      kind: "skip",
      path: destPath,
      reason: "bloque managed editado por el usuario; resuelve con 'navori sync' o ajusta el destino a mano",
    };
  }
  if (result.status === "downgrade-skipped") {
    return {
      kind: "skip",
      path: destPath,
      reason: `bloque escrito por una navori más nueva (${result.details?.existingVersion ?? "?"}); no lo toqué. Actualiza tu CLI: npm i -g navori@latest`,
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
      version: NAVORI_VERSION,
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
  if (result.status === "downgrade-skipped") {
    input.skipped.push({
      path: relative(input.cwd, targetAbs),
      reason: `sub-bloque '${input.skill.id}' escrito por una navori más nueva (${result.details?.existingVersion ?? "?"}); no lo toqué. Actualiza tu CLI`,
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

/**
 * Strip a disabled plugin's injectInto sub-block from its target file (the
 * inverse of applySubBlockInject). Operates on the pending content if the file
 * is being re-rendered this pass, else on the on-disk copy. No-op when the
 * target or the sub-block is absent. (#80)
 */
function removeSubBlock(input: {
  cwd: string;
  skill: LoadedPlugin["skillAssets"][number];
  pending: Array<{ path: string; content: string; status: RenderStatus; chmodExec?: boolean }>;
}): void {
  const targetAbs = join(input.cwd, input.skill.injectInto!);
  const pendingEntry = input.pending.find((p) => p.path === targetAbs);

  let currentContent: string;
  if (pendingEntry) {
    currentContent = pendingEntry.content;
  } else if (existsSync(targetAbs)) {
    currentContent = readFileSync(targetAbs, "utf-8");
  } else {
    return; // target file gone — nothing to strip
  }

  const stripped = removeManagedSection(currentContent, input.skill.id, "html");
  if (stripped === currentContent) return; // sub-block not present

  if (pendingEntry) {
    pendingEntry.content = stripped;
    return;
  }
  input.pending.push({ path: targetAbs, content: stripped, status: "updated" });
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
/**
 * Presets whose repos are frontend UI codebases. Their JSX/TSX repeats by
 * nature (component boilerplate, Mantine props), so jscpd's duplication
 * threshold is relaxed to 10%. Every other preset (backends, workers) keeps
 * the stricter 5% default.
 */
const FRONTEND_PRESETS = new Set([
  "vite-react-ts",
  "vite-react-ts-mantine",
  "nextjs",
  "astro",
  "react-native-expo",
]);

/** jscpd duplication threshold (percent) for a preset — see FRONTEND_PRESETS. */
function jscpdThresholdForPreset(preset: string): number {
  return FRONTEND_PRESETS.has(preset) ? 10 : 5;
}

function planPluginScript(
  cwd: string,
  script: { src: string; dest: string; exec: boolean },
  config: NavoriConfig,
): PluginScriptPlan {
  const destPath = join(cwd, ".claude/scripts", script.dest);
  const raw = readFileSync(script.src, "utf-8");
  const interpolated = interpolate(raw, config, {
    extraVars: { jscpdThreshold: String(jscpdThresholdForPreset(config.preset)) },
  });
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
