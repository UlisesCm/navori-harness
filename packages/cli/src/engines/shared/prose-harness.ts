import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { effectiveConfig, type NavoriConfig } from "../../lib/config.ts";
import { writeFileAtomic } from "../../lib/atomic.ts";
import { createBackup, purgeOldBackups } from "../../lib/backup.ts";
import { RenderWriteError } from "../../lib/errors.ts";
import { computeRenderPlan } from "../../lib/render-plan.ts";
import { injectManagedSection } from "../../lib/marker.ts";
import { getCoreRoot, readCliVersion } from "../../lib/bundled-assets.ts";
import { tc, resolveLang } from "../../lib/i18n.ts";
import type { RenderStatus } from "../../lib/style.ts";
import { buildSkillRows } from "./skills-index.ts";
import type { SkippedFile } from "./execute-plan.ts";

/**
 * Shared engine for the non-Claude "prose" targets: AGENTS.md (universal),
 * Cursor (`.cursor/rules/*.mdc`) and Copilot (`.github/copilot-instructions.md`).
 *
 * All three project the SAME harness context — the core rule blocks, the preset
 * stack block, the skills index and a short workflow summary — into a single
 * managed markdown file. They differ only in destination path and the seed
 * header (a plain title for AGENTS.md/Copilot, YAML frontmatter for a Cursor
 * `.mdc`). This module owns the common body builder + the single-file render
 * (marker injection, backup, atomic write); each adapter is a thin wrapper.
 *
 * Claude-only concerns are intentionally dropped for every prose target:
 * `config.models.*` (per-agent model), the defensive hooks, the quality-gate
 * hook, the permission rules and the subagent orchestration block. Plugin
 * blocks (e.g. engram) are skipped too — they assume Claude Code infrastructure
 * the other tools don't have. `collectOmissionWarnings` surfaces the gap so a
 * user enabling one of these engines never assumes parity with `.claude/`.
 *
 * Hybrid ownership mirrors the rest of navori: everything navori generates lives
 * inside one managed marker; whatever the user writes outside it is preserved.
 */

export interface ProseEngineResult {
  written: Array<{ path: string; status: RenderStatus }>;
  skipped: SkippedFile[];
  warnings: string[];
  backupPath: string | null;
}

// Stamp the navori release version (bumps per release) for the anti-retroceso
// guard, not @navori/core's static version. (#79)
const CORE_META = { source: "@navori/core" as const, version: readCliVersion() };
/**
 * Build the skills index as prose. Independent from the Claude engine's
 * `buildSkillsIndexBody` (which references `.claude/skills/` paths that don't
 * exist for non-Claude tools); here the listing is path-free.
 */
function buildSkillsSection(config: NavoriConfig, repoRoot: string): string | null {
  const coreAssets = resolve(getCoreRoot(), "core-assets");
  // Shared row builder (C4): same set as the Claude index, minus project-local
  // skills (these engines have no `.claude/skills/`). Unlike the old prose-only
  // copy it now lists met-conditional preset skills too (deterministic from
  // config), instead of dropping every conditional one.
  const rows = buildSkillRows(config, repoRoot, coreAssets);
  if (rows.length === 0) return null;
  return ["## Available skills", "", ...rows, ""].join("\n");
}

/** Short, engine-agnostic summary of how navori expects work to flow. */
function buildWorkflowSection(): string {
  return [
    "## Workflow",
    "",
    "- For non-trivial tasks: analysis → plan → implementation. One at a time.",
    "- Before coding: is it the simplest option? readable in 6 months? does it keep the existing pattern?",
    "- Search with read-only tools (don't read the whole repo); cite `file:line`.",
    "- Close with the project's quality gate green before calling it done.",
    "",
  ].join("\n");
}

/**
 * Build the managed body: core rule blocks + preset stack + skills + workflow.
 * Reuses `computeRenderPlan` (engine-agnostic) for the rule blocks and keeps
 * only the core + preset sources — plugin blocks are Claude-specific.
 */
export function buildHarnessProse(
  config: NavoriConfig,
  repoRoot: string,
  isWorkspace: boolean,
  options: { includeOrchestration?: boolean; includePluginBlocks?: boolean } = {},
): string {
  // Workspace renders omit root-only blocks — same semantics as the Claude
  // engine (#70): the tools that read these files merge/inherit the root file,
  // so re-emitting the global blocks per workspace just duplicates context.
  const plan = computeRenderPlan("", config, repoRoot, { omitRootOnly: isWorkspace });
  // Keep core rule blocks + the active preset's stack block (its source is the
  // preset id). Plugin-contributed blocks (engram, etc.) are Claude-specific and
  // dropped — other tools don't have that infra. The "orquestacion" block is
  // also Claude-only (it drives subagents via the Agent tool, which non-Claude
  // tools lack); its engine-agnostic core lives in the workflow section below.
  const ruleBlocks = plan.entries
    .filter(
      (e) =>
        e.newContent != null &&
        e.status !== "removed-condition-false" &&
        (options.includeOrchestration === true || e.asset.id !== "orquestacion") &&
        (options.includePluginBlocks === true || e.source === "core" || e.source === config.preset),
    )
    .map((e) => e.newContent!.trim());

  const skills = buildSkillsSection(config, repoRoot);
  const sections = [
    "> Project context generated by navori. Read by Cursor, Codex, Gemini and Copilot.",
    ...ruleBlocks,
    ...(skills ? [skills] : []),
    buildWorkflowSection(),
  ];
  return sections.join("\n\n").trim() + "\n";
}

/**
 * A prose target is intentionally a subset of the Claude engine: it drops
 * subagent orchestration, hooks, permission rules, Claude-only plugin blocks and
 * per-agent model assignment. That trade-off is invisible from the result alone
 * — `warnings: []` would let someone enabling one of these engines assume parity
 * with `.claude/`. Surface every real omission, driven by config so we only warn
 * about infra the user actually configured. Issue #71 item 13.
 */
export function collectOmissionWarnings(config: NavoriConfig): string[] {
  const strings = tc(resolveLang(config.language)).engine;
  const warnings: string[] = [strings.proseNoClaudeInfra];
  const enabledPlugins = Object.entries(config.plugins ?? {})
    .filter(([, s]) => s.enabled === true)
    .map(([id]) => id);
  if (enabledPlugins.length > 0) {
    warnings.push(strings.prosePluginBlocksOmitted(enabledPlugins.join(", ")));
  }
  if (config.models && Object.keys(config.models).length > 0) {
    warnings.push(strings.proseModelAssignmentOmitted);
  }
  return warnings;
}

export interface ProseRenderSpec {
  cwd: string;
  config: NavoriConfig;
  /** Destination file, relative to cwd (e.g. "AGENTS.md", ".cursor/rules/navori.mdc"). */
  destRelPath: string;
  /** Managed-block id; must be stable across releases (anti-retroceso). */
  managedId: string;
  /** Seed written before the managed block the FIRST time the file is created
   * (a title, or YAML frontmatter for a `.mdc`). Preserved verbatim after. */
  header: string;
  /** User-owned section seeded once, after the managed block, on first render. */
  userSection: string;
  dryRun?: boolean;
  /** Repo root (resolves shared presets); defaults to cwd. */
  repoRoot?: string;
  /** Codex has native subagents, so its AGENTS.md keeps orchestration rules. */
  includeOrchestration?: boolean;
  /** Full engines may retain plugin protocol blocks they can back with MCP. */
  includePluginBlocks?: boolean;
}

/**
 * Render one managed prose file end-to-end: build the harness body, inject it
 * into the (existing or freshly-seeded) file inside a single managed marker,
 * back up + atomically write. Shared by the AGENTS.md, Cursor and Copilot
 * adapters — they only supply the destination, id and seed header.
 */
export function renderProseFile(spec: ProseRenderSpec): ProseEngineResult {
  const config = effectiveConfig(spec.config);
  const strings = tc(resolveLang(config.language)).engine;
  const cwd = spec.cwd;
  const repoRoot = spec.repoRoot ?? cwd;
  // Workspace render: repoRoot points elsewhere than cwd (same detection as
  // the Claude engine).
  const isWorkspace = spec.repoRoot != null && resolve(spec.repoRoot) !== resolve(cwd);
  const destPath = join(cwd, spec.destRelPath);

  const firstRender = !existsSync(destPath);
  const existing = firstRender ? spec.header : readFileSync(destPath, "utf-8");
  const body = buildHarnessProse(config, repoRoot, isWorkspace, {
    includeOrchestration: spec.includeOrchestration,
    includePluginBlocks: spec.includePluginBlocks,
  });

  const result = injectManagedSection(existing, spec.managedId, body, CORE_META, "html");
  // First render seeds a user-section after the managed block; on re-render the
  // existing file already has it and injectManagedSection preserves it in place.
  const output = firstRender ? result.output + spec.userSection : result.output;

  const written: ProseEngineResult["written"] = [];
  const skipped: ProseEngineResult["skipped"] = [];
  let backupPath: string | null = null;

  if (result.status === "user-modified-skipped") {
    skipped.push({
      path: spec.destRelPath,
      reason: strings.managedBlockEditedByHand,
      status: "user-modified-skipped",
    });
  } else if (result.status === "downgrade-skipped") {
    skipped.push({
      path: spec.destRelPath,
      reason: strings.blockFromNewerNavori(result.details?.existingVersion ?? undefined),
      status: "downgrade-skipped",
    });
  } else if (result.status === "unchanged") {
    // nothing to do
  } else {
    written.push({ path: spec.destRelPath, status: result.status });
    if (!spec.dryRun) {
      if (!firstRender) {
        const handle = createBackup(cwd, [spec.destRelPath]);
        if (handle.files.length > 0) {
          backupPath = handle.path;
          purgeOldBackups();
        }
      }
      try {
        mkdirSync(dirname(destPath), { recursive: true });
        writeFileAtomic(destPath, output);
      } catch (err) {
        // The result (and its backupPath) never reaches the caller on a throw —
        // put the recovery breadcrumb in the error itself (#77).
        const hint = backupPath ? strings.backupAvailableAt(backupPath) : "";
        const detail = err instanceof Error ? err.message : String(err);
        throw new RenderWriteError(
          `${strings.renderFailedWriting(undefined, destPath, detail)}.${hint}`,
          backupPath,
        );
      }
    }
  }

  // Parity warnings are repo-level advisories; emitting them again for every
  // workspace of a monorepo would just repeat the same text N times.
  const warnings = isWorkspace ? [] : collectOmissionWarnings(config);
  return { written, skipped, warnings, backupPath };
}
