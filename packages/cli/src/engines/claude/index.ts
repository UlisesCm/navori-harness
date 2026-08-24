import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { effectiveConfig, type NavoriConfig } from "../../lib/config.ts";
import type { MonorepoRenderContext } from "../../lib/monorepo.ts";
import {
  loadEnabledPlugins,
  loadDisabledPlugins,
  RETIRED_PLUGINS,
  type LoadedPlugin,
} from "../../lib/plugins.ts";
import {
  computeRenderPlan,
  canonicalManagedOrder,
  classifyVersionDrift,
  type AssetPlanEntry,
  type UpdateAvailable,
} from "../../lib/render-plan.ts";
import { loadPreset, PresetError } from "../../lib/presets.ts";
import { LIBRARY_SKILLS, REMOVED_LIB_SKILLS, unknownLibraries } from "../../lib/library-skills.ts";
import { getCoreRoot, readCliVersion } from "../../lib/bundled-assets.ts";
import {
  injectManagedSection,
  removeManagedSection,
  reorderManagedBlocks,
  splitUserSection,
  emitUserSection,
} from "../../lib/marker.ts";
import type { RenderStatus } from "../../lib/style.ts";
import { isNavoriOwnedSettings } from "./settings-detection.ts";
import { buildClaudeSettings } from "./build-settings.ts";
import { mergeCoexistSettings, isPlainObject } from "./coexist-settings.ts";
import { renderManagedFile } from "../shared/render-managed-file.ts";
import { interpolate, sanitizeProjectValue } from "../../lib/interpolate.ts";
import { expandHookIncludes } from "../../lib/hook-includes.ts";
import { benchMark } from "../../lib/bench.ts";
import { stripFrontmatter } from "../../lib/frontmatter.ts";
import { tc, resolveLang, type Lang } from "../../lib/i18n.ts";
import { CORE_AGENTS, extraConditionMet, isAgentEnabled } from "../shared/harness-assets.ts";
import { resolveHarnessPlan } from "../shared/harness-plan.ts";
import { buildSkillRows } from "../shared/skills-index.ts";
import { buildAgentsIndexBlock } from "../shared/agents-index.ts";
import {
  collectPlan,
  commitWrites,
  type AdapterCtx,
  type PendingRemoval,
  type SkipReason,
  type SkipStatus,
  type SkippedFile,
} from "../shared/execute-plan.ts";
import { createClaudeAdapter } from "./adapter.ts";

/**
 * Claude keeps its detailed skip prose (with the `navori sync` hint and the
 * upgrade nudge) when a managed block was hand-edited or written by a newer
 * navori. Passed to `collectPlan` so the shared spine surfaces Claude's
 * messages, not the generic English defaults (Spec 0008 C.2).
 */
const makeClaudeSkipReason =
  (lang: Lang): SkipReason =>
  (status, _destRelPath, existingVersion) =>
    status === "user-modified-skipped"
      ? tc(lang).engine.managedBlockEditedByHand
      : tc(lang).engine.blockFromNewerNavori(existingVersion);

/**
 * Claude engine adapter — entry point. Orchestrates the full render of a
 * `.claude/` tree against a NavoriConfig:
 *
 *   - CLAUDE.md          (delegated to computeRenderPlan; existing flow)
 *   - .claude/settings.json   (built from settings-base + plugins + qg hook)
 *   - .claude/agents/<role>.md  for each role enabled in config.harness
 *   - .claude/skills/<id>/SKILL.md  for each core skill (directory form —
 *     the shape Claude Code auto-discovers; always-on for now)
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
  skipped: SkippedFile[];
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
}

/**
 * Workflow skills — always-on process skills (ticket pipeline, PR flow) that are
 * stack-agnostic, so they render for every preset, not just backend ones. Unlike
 * CORE_SKILLS they keep a BARE managed-id (matching the id the express preset
 * wrote before they were promoted here), so an `update` recognizes the existing
 * block in place instead of orphaning it and appending a duplicate.
 */
// Managed blocks stamp the navori release version (bumps every release) so the
// anti-retroceso guard has a per-release signal — not @navori/core's static
// version. `source` still records provenance. See render-plan NAVORI_VERSION (#79).
const NAVORI_VERSION = readCliVersion();
const CORE_META = { source: "@navori/core" as const, version: NAVORI_VERSION };

/** Managed-block id for the skills index injected into CLAUDE.md. */
const SKILLS_INDEX_ID = "skills-index";

/**
 * Whether a preset extra applies to this config. An extra with no `condition`
 * is always on; one with a condition is materialized only when the config path
 * resolves truthy (same semantics as CoreManagedAsset.condition). Used in BOTH
 * the skills index and the extras render loop so they never disagree.
 */
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
  coreAssets: string,
  lang: Lang,
  /** Where this CLAUDE.md is written — the `.claude/skills/` it indexes sit
   * next to it, which on a workspace render is NOT `repoRoot`. */
  cwd: string,
): string | null {
  const rows = buildSkillRows(config, repoRoot, coreAssets, localSkills, cwd);
  if (rows.length === 0) return null;
  const t = tc(lang).blocks.skillsIndex;
  // The project-local note only makes sense when the repo actually declares
  // local skills; otherwise it points at a category that isn't present.
  const localNote = localSkills.length > 0 ? [t.localNote] : [];
  return [t.heading, "", t.intro, ...localNote, "", ...rows, ""].join("\n");
}

/** Managed-block id for the agents index injected into CLAUDE.md. */
const AGENTS_INDEX_ID = "agentes-disponibles";

/**
 * Build the agents index — the catalog the orchestrator (main agent) reads to
 * know which subagents exist and when to spawn each. Lists only the enabled
 * leaf agents (config.harness[key] !== false); the leader is excluded because
 * the main agent embeds that role rather than delegating to it. The prose
 * (heading, intro, per-agent "when to reach for it") is localized and shared
 * with Codex via `buildAgentsIndexBlock` (#289). Returns null when nothing is
 * enabled so the block is stripped instead of rendered empty.
 */
function buildAgentsIndexBody(config: NavoriConfig, lang: Lang): string | null {
  const when = tc(lang).blocks.agentsIndex.when;
  const agents: Array<{ id: string; description: string }> = [];
  for (const agent of CORE_AGENTS) {
    if (agent.id === "leader") continue;
    if (!isAgentEnabled(config, agent.harnessKey)) continue;
    const description = when[agent.id];
    if (!description) continue;
    agents.push({ id: agent.id, description });
  }
  return buildAgentsIndexBlock(lang, agents, { withIntro: true });
}

/** Managed sub-block id for the Codex cross-model review advisory in leader.md. */
const CODEX_CROSS_REVIEW_ID = "codex-cross-review";

/**
 * Body of the Codex cross-model review advisory appended to `leader.md`. Short
 * on purpose: the actual review criteria already live in what `.codex/` renders
 * (`AGENTS.md` + `.codex/agents/reviewer.toml`), so this only tells the Claude
 * orchestrator that a second opinion from a DIFFERENT provider is one command
 * away — and when to reach for it. `{{prTarget}}` resolves against the config.
 *
 * The prose lives in `core-assets/managed/codex-cross-review.md` (not inline in
 * TS) so it goes through the same asset+interpolation pipeline as every other
 * managed block (#229). Follow-up: the other computed blocks (`skills-index`,
 * `agentes-disponibles`, `contexto-*`) are shared across engines and build their
 * rows from config, so relocating THEIR prose + localizing it is a larger,
 * cross-engine refactor tracked separately.
 */
function buildCodexCrossReviewBody(config: NavoriConfig): string {
  const assetPath = resolve(getCoreRoot(), "core-assets/managed/codex-cross-review.md");
  return interpolate(readFileSync(assetPath, "utf-8"), config);
}

/** Managed-block id for the project-context rules injected into CLAUDE.md. */
const CONTEXTO_PROYECTO_ID = "contexto-proyecto";

/** Managed-block id for the monorepo map (workspace tree) injected into CLAUDE.md. */
const CONTEXTO_MONOREPO_ID = "contexto-monorepo";

/**
 * Ids of the CLAUDE.md managed blocks THIS engine computes and injects AFTER the
 * core/preset/plugin blocks (steps 1b–1c). This is the Claude adapter's canonical
 * order contribution (#228): the engine-agnostic core no longer knows these ids —
 * `canonicalManagedOrder` receives them from here, so the render's reorder pass
 * places the computed blocks in this exact order. Exported so a follow-up can
 * hand the same list to doctor's order check (`lib/health.ts`).
 */
export const CLAUDE_COMPUTED_BLOCK_IDS = [
  SKILLS_INDEX_ID,
  AGENTS_INDEX_ID,
  CONTEXTO_MONOREPO_ID,
  CONTEXTO_PROYECTO_ID,
] as const;

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
  lang: Lang,
): string | null {
  const t = tc(lang).blocks.monorepo;
  if (isWorkspace) {
    if (!mono) return null;
    // Every workspace field below is untrusted config (checked-in, editable via
    // PR) landing VERBATIM inside a trusted managed block — sanitize each so it
    // can't inject doctrine across a newline or forge an HTML-comment marker that
    // truncates a neighboring security block (#264). Same defense as
    // buildContextoProyectoBody (#198). `tool` is enum-constrained but harmless
    // to sanitize; sanitizing it keeps every interpolated value uniform.
    const tool = sanitizeProjectValue(mono.tool ?? "pnpm");
    const currentName = sanitizeProjectValue(mono.currentName);
    const currentPath = sanitizeProjectValue(mono.currentPath);
    const lines: string[] = [
      t.workspaceHeading(currentName),
      "",
      t.workspaceIntro(currentName, currentPath, tool),
      "",
    ];
    if (mono.siblings.length > 0) {
      lines.push(t.siblingsLead);
      for (const s of mono.siblings) {
        const name = sanitizeProjectValue(s.name);
        const path = sanitizeProjectValue(s.path);
        const preset = s.preset ? sanitizeProjectValue(s.preset) : "";
        lines.push(`- \`${name}\` — \`${path}\`${preset ? ` (${preset})` : ""}`);
      }
    } else {
      lines.push(t.onlyWorkspace);
    }
    lines.push("");
    lines.push(t.scopedTaskHint(currentName));
    lines.push("");
    return lines.join("\n");
  }

  // Root render: read the workspace list straight off the config.
  const workspaces = config.monorepo?.workspaces ?? [];
  if (workspaces.length === 0) return null;
  // Sanitize `tool` (untrusted config) before it reaches the managed block
  // (#264); each workspace's name/path/preset is sanitized in the loop below.
  const tool = sanitizeProjectValue(config.monorepo?.tool ?? "pnpm");
  const lines: string[] = [t.rootHeading, "", t.rootIntro(tool), "", t.workspacesLead];
  for (const w of workspaces) {
    const name = sanitizeProjectValue(w.name);
    const path = sanitizeProjectValue(w.path);
    const preset = w.preset ? sanitizeProjectValue(w.preset) : "";
    lines.push(`- \`${name}\` — \`${path}\`${preset ? ` (${preset})` : ""}`);
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
function buildContextoProyectoBody(config: NavoriConfig, lang: Lang): string | null {
  // Read straight off the schema type: an `?? {}` fallback would widen `proj`
  // to a union with `{}` and lose every declared key.
  const proj = config.project;
  const t = tc(lang).blocks.projectContext;
  const rows: string[] = [];

  const posture = proj?.posture;
  if (posture === "greenfield") {
    rows.push(t.stageGreenfield);
  } else if (posture === "production") {
    rows.push(t.stageProduction);
  } else if (posture === "migration") {
    rows.push(t.stageMigration);
  }

  const migrations = proj?.libraryMigrations ?? [];
  for (const m of migrations) {
    // project.* is untrusted config (checked-in, editable via PR) landing inside
    // a trusted managed block — sanitize so it can't inject doctrine or forge a
    // marker to corrupt the region (#198).
    const domain = sanitizeProjectValue(m.domain);
    const preferred = sanitizeProjectValue(m.preferred);
    const legacy = sanitizeProjectValue(m.legacy);
    rows.push(t.migrationRow(domain, preferred, legacy));
  }

  const rigor = proj?.reviewRigor;
  if (rigor === "strict") {
    rows.push(t.rigorStrict);
  } else if (rigor === "pragmatic") {
    rows.push(t.rigorPragmatic);
  }

  const arch = sanitizeProjectValue(proj?.architectureRule ?? "");
  if (arch) {
    rows.push(t.architecture(arch));
  }

  const critical = (proj?.criticalAreas ?? [])
    .map((c) => sanitizeProjectValue(c))
    .filter((c) => c !== "");
  if (critical.length > 0) {
    rows.push(t.criticalAreas(critical.join(", ")));
  }

  const tests = proj?.testsForNewCode;
  if (tests === "always") {
    rows.push(t.testsAlways);
  } else if (tests === "when-applicable") {
    rows.push(t.testsWhenApplicable);
  } else if (tests === "none") {
    rows.push(t.testsNone);
  }

  if (rows.length === 0) return null;

  return [t.heading, "", t.intro, "", ...rows, ""].join("\n");
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
  } = {},
): ClaudeEngineResult {
  // Fill in render-only derived defaults (e.g. prTarget ?? branchBase) so
  // templates interpolate against a complete config without persisting it.
  const config = effectiveConfig(inputConfig);
  const lang = resolveLang(config.language);
  const dryRun = options.dryRun === true;
  const force = options.force === true;
  const repoRoot = options.repoRoot ?? cwd;
  // A workspace render (repoRoot points elsewhere than cwd) omits the root-only
  // global blocks — Claude Code already loads them from the parent CLAUDE.md.
  // Issue #70.
  const isWorkspace = options.repoRoot != null && resolve(options.repoRoot) !== resolve(cwd);
  // Root the bundled core assets resolve against (vs a local preset's folder).
  const coreAssets = resolve(getCoreRoot(), "core-assets");
  const skipped: SkippedFile[] = [];
  const warnings: string[] = [];
  const pending: Array<{
    path: string;
    content: string;
    status: RenderStatus;
    chmodExec?: boolean;
  }> = [];
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
  const {
    managed: claudeMdManaged,
    userBody,
    hadMarkers: hadUserSection,
  } = splitUserSection(claudeMdExisting);
  const claudeMdPlan = computeRenderPlan(claudeMdManaged, config, repoRoot, {
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
  const skillsIndexBody = buildSkillsIndexBody(
    config,
    localSkills,
    repoRoot,
    coreAssets,
    lang,
    cwd,
  );
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
  const agentsIndexBody = buildAgentsIndexBody(config, lang);
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
  const contextoBody = buildContextoProyectoBody(config, lang);
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
  const monorepoBody = buildContextoMonorepoBody(
    config,
    options.monorepoContext,
    isWorkspace,
    lang,
  );
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
  const reorder = reorderManagedBlocks(
    claudeMdContent,
    canonicalManagedOrder(config, repoRoot, {
      omitRootOnly: isWorkspace,
      computedBlockIds: CLAUDE_COMPUTED_BLOCK_IDS,
    }),
  );
  claudeMdContent = reorder.output;
  if (reorder.blockedByInterleaving) {
    warnings.push(tc(lang).engine.managedBlocksOutOfOrder);
  }

  // 1e. Re-attach the user-authored zone, wrapped in explicit markers, after the
  // managed region. Emitted when there's domain to preserve, the file already had
  // the markers (keeps an already-delimited file idempotent), OR the file is new
  // (fresh CLAUDE.md ships the zone + a placeholder so the contract is visible);
  // a managed repo with no domain and no markers stays untouched (no spurious diff).
  if (userBody !== null || hadUserSection || claudeMdExisting.length === 0) {
    claudeMdContent = emitUserSection(claudeMdContent, userBody, lang);
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

  // 2.5. .mcp.json — the project-scoped MCP registry Claude Code reads (#212).
  // Before this, a plugin's `mcpServer` was only ever materialized for Codex
  // (config.toml); on Claude the server relied 100% on `postInstall` side-
  // effects, which don't run under `add --skip-install`. So `codegraph`'s
  // `mcp__codegraph__*` permission pointed at a server that was never registered,
  // and the protocol promised MCP tools that didn't exist. We now write the same
  // servers Codex gets into `.mcp.json`, reconciling disabled plugins and
  // preserving any servers the user added under their own keys.
  const disabledPlugins = loadDisabledPlugins(config.plugins).loaded;
  const mcpResult = planMcpRegistration(cwd, enabledPlugins, disabledPlugins, config, force);
  // Count `.mcp.json` as an inspected destination only when there's one to
  // manage — an enabled plugin declaring a server, or an existing file to
  // reconcile. A repo with no MCP plugins and no `.mcp.json` has no destination
  // here (unlike settings.json, which navori always owns), so it isn't counted.
  const hasMcpDestination =
    enabledPlugins.some((pl) => pl.manifest.mcpServer) || existsSync(join(cwd, ".mcp.json"));
  if (hasMcpDestination) inspected += 1;
  if (mcpResult.kind === "skip") {
    skipped.push({ path: relative(cwd, mcpResult.path), reason: mcpResult.reason });
  } else if (mcpResult.kind === "write") {
    pending.push({
      path: mcpResult.path,
      content: mcpResult.content,
      status: mcpResult.status,
    });
  }

  // 3–6.6 (Spec 0008 C.2) — SHARED inventory via the spine. resolveHarnessPlan
  // resolves core/preset agents, core/workflow/preset/library skills and core
  // hooks; collectPlan renders them through the Claude adapter into the SAME
  // `pending`. Claude-only work (CLAUDE.md above; settings/bootstrap/scripts/
  // injectInto/preset-hooks/reconciliation below) shares that pending and one
  // commitWrites. `includeLeader` because Claude DOES emit leader.md.
  const preset = loadActivePreset(config, repoRoot, warnings);
  const harnessPlan = resolveHarnessPlan(config, coreAssets, preset, { includeLeader: true });
  // A `project.libraries` id this registry doesn't know is silently skipped by
  // the plan AND its managed skill is pruned from disk below (§8.6) — a repo
  // upgraded without `navori update` would lose its guidance with zero signal
  // (audit v0.5.1 A1, the socketio split). Warn loudly instead.
  for (const lib of unknownLibraries(config.project?.libraries)) {
    warnings.push(
      lib.removed
        ? tc(lang).engine.libraryRemovedFromRegistry(lib.id, lib.successors)
        : tc(lang).engine.libraryUnknownInRegistry(lib.id),
    );
  }
  const adapterCtx: AdapterCtx = {
    cwd,
    config,
    repoRoot,
    isWorkspace,
    coreAssets,
    preset,
    plugins: enabledPlugins,
  };
  const sharedPlan = collectPlan(harnessPlan, createClaudeAdapter(), adapterCtx, {
    prune: false,
    skipReason: makeClaudeSkipReason(lang),
    lang,
  });
  for (const p of sharedPlan.pending) {
    pending.push({ path: p.path, content: p.content, status: p.status, chmodExec: p.chmodExec });
  }
  for (const s of sharedPlan.skipped) skipped.push(s);
  inspected += harnessPlan.agents.length + harnessPlan.skills.length + harnessPlan.hooks.length;
  if (!config.qualityGate?.fast) {
    warnings.push(tc(lang).engine.qualityGateHookSkipped);
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

  // 6.5-bis. Preset HOOKS — the one preset-extra kind the spine doesn't model
  // (arbitrary destRelPath + exec bit, no id-derived path). Preset agents/skills
  // and library skills already went through the shared plan above; only hooks
  // remain here. Every bundled preset ships `extras.hooks: []`, so this is a
  // no-op today — kept Claude-only until a real preset needs it (then lift into
  // the plan). The preset was loaded (with its warnings) by loadActivePreset.
  for (const extra of preset?.def.extras.hooks ?? []) {
    if (!extraConditionMet(extra, config)) continue;
    inspected += 1;
    applyManagedFilePlan(
      planManagedFile({
        cwd,
        assetRoot: preset!.assetRoot,
        assetRelPath: extra.relPath,
        destRelPath: extra.destRelPath,
        managedId: extra.id,
        config,
      }),
      cwd,
      pending,
      skipped,
      /* chmodExec */ true,
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
        // #215: register version drift so `navori update` reports a plugin
        // sub-block whose version bumped, instead of silently correcting it on
        // render. Reuses the CLAUDE.md plan's buckets so it flows out via the
        // same `updatesAvailable`/`downgrades` the engine returns.
        updatesAvailable: claudeMdPlan.updatesAvailable,
        downgrades: claudeMdPlan.downgrades,
      });
    }
  }

  // 8.4. Codex cross-model review advisory (I3/N3, #168). When this repo renders
  // the `codex` engine, the Claude orchestrator gets a managed sub-block in
  // leader.md telling it a second opinion from a DIFFERENT provider is one
  // command away — reusing what `.codex/` already rendered (AGENTS.md +
  // reviewer.toml), so the prompt stays short. GATED ON THE ENGINE, not a
  // standalone toggle: no `codex` in engines → no `.codex/` → the block is
  // stripped, never left orphaned. Same gating pattern as `scanCodexHealth`.
  applyCodexCrossReview(cwd, config, pending);

  // 8.5. Reconcile DISABLED plugins. A plugin turned off (via `configure
  // plugins` or `navori remove`) still has its managed CLAUDE.md blocks stripped
  // by computeRenderPlan, but its injectInto sub-blocks (e.g. leader.md) and its
  // .claude/scripts/* were only ever touched on the enabled path — so they'd
  // orphan. Strip them here so disabling a plugin fully cleans up (#80).
  const removals: PendingRemoval[] = [];
  for (const plugin of disabledPlugins) {
    for (const skill of plugin.skillAssets) {
      if (!skill.injectInto) continue;
      inspected += 1;
      removeSubBlock({ cwd, skill, pending });
    }
    for (const script of plugin.scriptAssets) {
      const destPath = join(cwd, ".claude/scripts", script.dest);
      if (existsSync(destPath)) {
        inspected += 1;
        removals.push({ path: destPath });
      }
    }
  }

  // 8.5-bis. Purge physical assets of RETIRED plugins (#314). A retired plugin's
  // manifest is gone, so it can never load → it never reaches the disabled-plugin
  // loop above, and its scripts (`.claude/scripts/*`) orphan on disk as inert
  // cruft no command strips. This sweep is config-INDEPENDENT on purpose: `navori
  // remove` deletes the plugin's config key, so gating on "still declared" would
  // never fire — it must clean the leftover for any retired id whose assets remain
  // on disk. Marker-free by design: these paths are navori-owned build outputs
  // (copied verbatim from the plugin package), not user content. commitWrites
  // backs them up before deleting and skips deletion entirely under dryRun.
  for (const retired of Object.values(RETIRED_PLUGINS)) {
    for (const asset of retired.assets) {
      const assetPath = join(cwd, asset);
      if (!existsSync(assetPath)) continue;
      inspected += 1;
      let recursive = false;
      try {
        recursive = statSync(assetPath).isDirectory();
      } catch {
        // Unreadable stat — leave `recursive` false. If it was actually a dir,
        // the non-recursive rmSync throws EISDIR, which the best-effort removal
        // path swallows: the dir is left in place rather than half-deleted. Safe
        // degradation for the edge case of an unreadable path.
      }
      removals.push({ path: assetPath, recursive });
    }
  }

  // 8.6. Reconcile REMOVED library skills. A skill dropped from the registry
  // (a legacy lib we no longer teach) leaves a stale managed file on disk in
  // repos rendered before the removal. Delete ours — but only files carrying
  // navori's own marker for that id, never a user's hand-written skill of the
  // same name. Both shapes are swept: the legacy FLAT `<id>.md` AND the current
  // DIRECTORY `<id>/SKILL.md` (a repo may have rendered the lib in either form).
  for (const id of REMOVED_LIB_SKILLS) {
    for (const removal of [planFlatSkillRemoval(cwd, id, id), planDirSkillRemoval(cwd, id, id)]) {
      if (!removal) continue;
      inspected += 1;
      removals.push(removal);
    }
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
    // Sweep both shapes: the legacy FLAT `<id>.md` and the current DIRECTORY
    // `<id>/SKILL.md`. A deselected lib rendered by this version orphans as a
    // directory; one rendered by an older version orphans as a flat file.
    for (const removal of [planFlatSkillRemoval(cwd, id, id), planDirSkillRemoval(cwd, id, id)]) {
      if (!removal) continue;
      inspected += 1;
      removals.push(removal);
    }
  }

  // 8.8. Migrate legacy FLAT skill files to the DIRECTORY form. navori now writes
  // every Claude skill as `.claude/skills/<id>/SKILL.md` (the shape Claude Code
  // auto-discovers); a repo onboarded before this change still carries the stale
  // flat `.claude/skills/<id>.md`. This render (re)writes the directory form, so
  // we prune the flat twin — otherwise BOTH coexist and the model sees the skill
  // twice. Covers core, workflow, preset and library skills uniformly (every
  // skill the shared plan placed). Marker-gated per skill, keyed on the exact
  // managed id navori stamped, so a user's hand-written `<id>.md` is never
  // touched. (#166)
  for (const skill of harnessPlan.skills) {
    const removal = planFlatSkillRemoval(cwd, skill.id, skill.managedId);
    if (!removal) continue;
    inspected += 1;
    removals.push(removal);
  }

  // 9. Backup + atomic writes — shared spine (Spec 0008 C.3). The CLAUDE.md-only
  // pending (built above), the shared-plan pending (§3–6.6) and the
  // reconciliation removals all flow through ONE commitWrites: a single backup
  // (#405: exactly the files this render overwrites or deletes), CLAUDE.md
  // written LAST so a crash leaves the file the user reads intact, and one
  // write-error surface. `removalsBestEffort` keeps disabled-plugin script
  // cleanup non-fatal. Claude assembles its extended report on top.
  benchMark("plan");
  const { written, backupPath } = commitWrites({
    pending: pending.map((p) => ({ ...p, relPath: relative(cwd, p.path) })),
    removals,
    cwd,
    // #348: EPHEMERAL_HARNESS_PATHS (worktrees, progress, local settings) are
    // excluded from the backup by commitWrites itself, for every engine.
    dryRun,
    writeLast: (p) => p.path === claudeMdPath,
    removalsBestEffort: true,
    lang,
  });
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
  };
}

// ─────────────────────────── helpers ───────────────────────────

/**
 * Prune a stale FLAT skill file (`.claude/skills/<id>.md`) that an earlier
 * navori wrote, now that navori emits the DIRECTORY form
 * `.claude/skills/<id>/SKILL.md` (the only shape Claude Code auto-discovers).
 * Guarded by the marker so a user's hand-written `<id>.md` of the same name is
 * never removed. `markerId` is the managed-block id navori stamped (`<id>-base`
 * for core skills, the bare id for workflow/library/preset). Returns null when
 * there's nothing (safe) to remove. (#166)
 */
function planFlatSkillRemoval(cwd: string, id: string, markerId: string): PendingRemoval | null {
  const flat = join(cwd, ".claude/skills", `${id}.md`);
  if (!existsSync(flat)) return null;
  let content: string;
  try {
    content = readFileSync(flat, "utf-8");
  } catch {
    return null; // unreadable — leave it rather than guess
  }
  if (!content.includes(`navori:managed id="${markerId}"`)) return null; // user's own — keep
  return { path: flat };
}

/**
 * Prune an ORPHANED DIRECTORY-form skill (`.claude/skills/<id>/SKILL.md`) navori
 * no longer renders. Removes the whole directory when SKILL.md is its only child,
 * else just SKILL.md so a user's sibling refs/assets survive — mirroring the
 * `skill-dir` orphan shape the shared spine uses for Codex. Marker-gated like the
 * flat prune. Returns null when there's nothing (safe) to remove. (#166)
 */
function planDirSkillRemoval(cwd: string, id: string, markerId: string): PendingRemoval | null {
  const skillDir = join(cwd, ".claude/skills", id);
  const skillPath = join(skillDir, "SKILL.md");
  if (!existsSync(skillPath)) return null;
  let content: string;
  try {
    content = readFileSync(skillPath, "utf-8");
  } catch {
    return null; // unreadable — leave it rather than guess
  }
  if (!content.includes(`navori:managed id="${markerId}"`)) return null; // user's own — keep
  let children: string[];
  try {
    children = readdirSync(skillDir);
  } catch {
    children = [];
  }
  const onlySkill = children.length === 1 && children[0] === "SKILL.md";
  return onlySkill ? { path: skillDir, recursive: true } : { path: skillPath };
}

/**
 * Load the active preset for the plan, surfacing Claude's own warnings. A
 * `custom`/absent preset returns null with no warning; an invalid preset warns
 * (and, because it stays null, also emits the not-found warning — same two-note
 * behavior as the pre-spine §6.5 loop).
 */
function loadActivePreset(
  config: NavoriConfig,
  repoRoot: string,
  warnings: string[],
): ReturnType<typeof loadPreset> {
  if (!config.preset || config.preset === "custom") return null;
  let loaded: ReturnType<typeof loadPreset> = null;
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
  return loaded;
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
    // Issue #4: with --force, regenerate even on parse error. The corrupt file
    // is about to be overwritten, so the pre-render backup still snapshots it
    // (#405: the backup covers every pending write that already exists) and the
    // user can recover by hand if needed.
    if (force) {
      return { kind: "write", path, content: newJson, status: "updated" };
    }
    return {
      kind: "skip",
      path,
      reason: tc(resolveLang(config.language)).engine.settingsParseFailed((err as Error).message),
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
        reason: tc(resolveLang(config.language)).engine.settingsNotObject,
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

type McpPlan =
  | { kind: "noop" }
  | { kind: "skip"; path: string; reason: string }
  | { kind: "write"; path: string; content: string; status: RenderStatus };

/**
 * Plan `.mcp.json` — the project-scoped MCP server registry Claude Code reads at
 * the repo root (#212). navori materializes one server per ENABLED plugin that
 * declares `mcpServer`, keyed by the plugin id (== the server name, so a
 * `mcp__<id>__*` permission rule resolves against a real server). stdio is the
 * default, so no `type` field is emitted; `command`/`args`/`env` mirror what the
 * Codex adapter already writes into `config.toml`, giving the two engines parity.
 *
 * Ownership is by KEY, not a `$navori` marker: navori only ever sets/removes the
 * server entries whose key is a navori plugin id, so a user's own servers under
 * other keys — and any other top-level `.mcp.json` fields — survive every render.
 * A DISABLED plugin's entry is removed (reconciliation), mirroring how disabled
 * plugins are cleaned up elsewhere. An unparseable / non-object existing file is
 * left untouched (skip) unless `--force`, so navori never clobbers a file it
 * can't safely merge into.
 */
function planMcpRegistration(
  cwd: string,
  enabledPlugins: LoadedPlugin[],
  disabledPlugins: LoadedPlugin[],
  config: NavoriConfig,
  force: boolean,
): McpPlan {
  const path = join(cwd, ".mcp.json");

  // Servers navori wants registered: enabled plugins declaring an mcpServer.
  const desired = new Map<string, Record<string, unknown>>();
  for (const plugin of enabledPlugins) {
    const server = plugin.manifest.mcpServer;
    if (!server) continue;
    const entry: Record<string, unknown> = { command: server.command, args: server.args };
    if (server.env && Object.keys(server.env).length > 0) entry.env = server.env;
    desired.set(plugin.manifest.id, entry);
  }

  const existing = existsSync(path) ? readFileSync(path, "utf-8") : null;
  let base: Record<string, unknown> = {};
  let baseServers: Record<string, unknown> = {};
  let hadServersKey = false;
  if (existing !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch (err) {
      if (!force) {
        const detail = (err as Error).message;
        const reason = tc(resolveLang(config.language)).engine.mcpJsonParseFailed(detail);
        return { kind: "skip", path, reason };
      }
      parsed = {};
    }
    if (isPlainObject(parsed)) {
      base = parsed;
      const ms = parsed.mcpServers;
      if (isPlainObject(ms)) {
        baseServers = { ...ms };
        hadServersKey = true;
      }
    } else if (!force) {
      const reason = tc(resolveLang(config.language)).engine.mcpJsonNotObject;
      return { kind: "skip", path, reason };
    }
  }

  // Merge: start from the user's servers, drop disabled navori plugins, then
  // set/refresh the enabled ones. Only navori-plugin keys are ever touched.
  const servers: Record<string, unknown> = { ...baseServers };
  for (const plugin of disabledPlugins) {
    if (plugin.manifest.mcpServer) delete servers[plugin.manifest.id];
  }
  for (const [id, entry] of desired) servers[id] = entry;

  // No file yet and nothing to register → don't create an empty `.mcp.json`.
  if (existing === null && Object.keys(servers).length === 0) return { kind: "noop" };

  const merged: Record<string, unknown> = { ...base };
  if (Object.keys(servers).length > 0 || hadServersKey) {
    merged.mcpServers = servers;
  }
  const newJson = JSON.stringify(merged, null, 2) + "\n";
  if (existing === newJson) return { kind: "noop" };
  return {
    kind: "write",
    path,
    content: newJson,
    status: existing === null ? "created" : "updated",
  };
}

interface ManagedFilePlanInput {
  cwd: string;
  /** Root `assetRelPath` resolves against (core-assets/ or a local preset folder). */
  assetRoot: string;
  assetRelPath: string; // relative to assetRoot
  destRelPath: string; // relative to cwd
  managedId: string;
  config: NavoriConfig;
}

type ManagedFilePlan =
  | { kind: "noop" }
  | { kind: "skip"; path: string; reason: string; status: SkipStatus }
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
      reason: tc(resolveLang(input.config.language)).engine.managedBlockEditedByHand,
      status: "user-modified-skipped",
    };
  }
  if (result.status === "downgrade-skipped") {
    return {
      kind: "skip",
      path: destPath,
      reason: tc(resolveLang(input.config.language)).engine.blockFromNewerNavori(
        result.details?.existingVersion ?? undefined,
      ),
      status: "downgrade-skipped",
    };
  }
  return { kind: "write", path: destPath, content: result.content, status: result.status };
}

function applyManagedFilePlan(
  plan: ManagedFilePlan,
  cwd: string,
  pending: Array<{ path: string; content: string; status: RenderStatus; chmodExec?: boolean }>,
  skipped: SkippedFile[],
  chmodExec = false,
): void {
  if (plan.kind === "noop") return;
  if (plan.kind === "skip") {
    skipped.push({ path: relative(cwd, plan.path), reason: plan.reason, status: plan.status });
    return;
  }
  pending.push({ path: plan.path, content: plan.content, status: plan.status, chmodExec });
}

interface BootstrapFilePlanInput {
  cwd: string;
  assetRelPath: string; // relative to core-assets/
  destRelPath: string; // relative to cwd
  config: NavoriConfig;
}

type BootstrapPlan = { kind: "noop" } | { kind: "write"; path: string; content: string };

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
  skipped: SkippedFile[];
  warnings: string[];
  updatesAvailable: UpdateAvailable[];
  downgrades: UpdateAvailable[];
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
      tc(resolveLang(input.config.language)).engine.pluginSkillNotInjected(
        input.skill.id,
        input.plugin.manifest.id,
        input.skill.injectInto ?? "?",
      ),
    );
    return;
  }

  const rawSkill = readFileSync(input.skill.absPath, "utf-8");
  const skillBody = stripFrontmatter(rawSkill);
  const interpolated = interpolate(skillBody, input.config);

  const subBlockSource = `@navori/plugin-${input.plugin.manifest.id}`;
  const result = injectManagedSection(
    currentContent,
    input.skill.id,
    interpolated,
    {
      source: subBlockSource,
      version: NAVORI_VERSION,
    },
    "html",
  );

  // #215: bucket the sub-block's version drift the same way core/preset/plugin
  // CLAUDE.md blocks do — an upgrade lands in `updatesAvailable` (so `navori
  // update` lists it), a downgrade in `downgrades` (so the anti-retroceso nudge
  // fires). Was blind before: sub-blocks were only ever seen through the write
  // list, never the managed-update report.
  classifyVersionDrift(
    result,
    input.skill.id,
    subBlockSource,
    NAVORI_VERSION,
    input.updatesAvailable,
    input.downgrades,
  );

  if (result.status === "user-modified-skipped") {
    input.skipped.push({
      path: relative(input.cwd, targetAbs),
      reason: tc(resolveLang(input.config.language)).engine.subBlockEditedByHand(
        input.skill.id,
        input.plugin.manifest.id,
      ),
      status: "user-modified-skipped",
    });
    return;
  }
  if (result.status === "downgrade-skipped") {
    input.skipped.push({
      path: relative(input.cwd, targetAbs),
      reason: tc(resolveLang(input.config.language)).engine.subBlockFromNewerNavori(
        input.skill.id,
        result.details?.existingVersion ?? undefined,
      ),
      status: "downgrade-skipped",
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

/**
 * Inject (or strip) the Codex cross-model review advisory as a managed sub-block
 * in `leader.md`, gated on the `codex` engine (#168). Mirrors the injectInto
 * sub-block flow: operate on the pending leader.md if this render is rewriting
 * it, else on the on-disk copy, so the block appears/disappears even on a no-op
 * render where leader.md itself is unchanged. No-op when leader.md is absent
 * (the `leader` role is disabled, or the engine hasn't rendered it). A hand-
 * edited block is preserved by `injectManagedSection` (its output stays put),
 * so no explicit skip surface is needed here.
 */
function applyCodexCrossReview(
  cwd: string,
  config: NavoriConfig,
  pending: Array<{ path: string; content: string; status: RenderStatus; chmodExec?: boolean }>,
): void {
  const targetAbs = join(cwd, ".claude/agents/leader.md");
  const pendingEntry = pending.find((p) => p.path === targetAbs);

  let currentContent: string;
  if (pendingEntry) {
    currentContent = pendingEntry.content;
  } else if (existsSync(targetAbs)) {
    currentContent = readFileSync(targetAbs, "utf-8");
  } else {
    return; // no leader.md to host the block
  }

  const next = config.engines.includes("codex")
    ? injectManagedSection(
        currentContent,
        CODEX_CROSS_REVIEW_ID,
        buildCodexCrossReviewBody(config),
        CORE_META,
        "html",
      ).output
    : removeManagedSection(currentContent, CODEX_CROSS_REVIEW_ID, "html");

  if (next === currentContent) return; // already in the wanted state

  if (pendingEntry) {
    pendingEntry.content = next;
    return;
  }
  pending.push({ path: targetAbs, content: next, status: "updated" });
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
 *
 * #215: unlike managed blocks/sub-blocks, a plugin script carries NO version
 * marker, so there's no drift to classify via `classifyVersionDrift`. It simply
 * auto-corrects on render — a content change yields a `write` that surfaces in
 * the render/`update` WRITE list (`agg.writes`), just not the managed-version
 * `updatesAvailable` report (which is version-marker-based by construction).
 * That's the intended, documented behavior, not a gap.
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
  // Inline `# navori:include` shell partials before interpolating so the shared
  // gate boilerplate has one source of truth yet the rendered script is standalone.
  const raw = expandHookIncludes(readFileSync(script.src, "utf-8"));
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
