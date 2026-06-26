import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { effectiveConfig, type NavoriConfig } from "../../lib/config.ts";
import { writeFileAtomic } from "../../lib/atomic.ts";
import { createBackup } from "../../lib/backup.ts";
import { computeRenderPlan } from "../../lib/render-plan.ts";
import { injectManagedSection } from "../../lib/marker.ts";
import { loadPreset } from "../../lib/presets.ts";
import { librarySkillById } from "../../lib/library-skills.ts";
import { readBundledCoreVersion } from "../../lib/bundled-assets.ts";
import type { RenderStatus } from "../../lib/style.ts";

/**
 * AGENTS.md engine adapter. Emits a single `AGENTS.md` at the repo root — the
 * universal format Cursor, Codex, Gemini CLI and Copilot all read. Unlike the
 * Claude engine, AGENTS.md has no hooks, settings or executable permissions, so
 * this adapter only projects the *prose* context: the core rule blocks, the
 * stack block from the preset, the skills index and a short workflow summary.
 *
 * Claude-only concerns are intentionally dropped: `config.models.*` (no engine
 * but Claude has a per-agent model), the defensive hooks, the quality-gate hook
 * and the permission rules. Plugin-contributed blocks (e.g. engram) are skipped
 * too — they assume Claude Code infrastructure the other tools don't have.
 *
 * Hybrid ownership mirrors the rest of navori: everything navori generates lives
 * inside one managed marker; whatever the user writes outside it is preserved.
 */

export interface AgentsMdEngineResult {
  written: Array<{ path: string; status: RenderStatus }>;
  skipped: Array<{ path: string; reason: string }>;
  warnings: string[];
  backupPath: string | null;
}

const MANAGED_ID = "navori-agents";
const CORE_META = { source: "@navori/core" as const, version: readBundledCoreVersion() };
const CORE_SKILLS: ReadonlyArray<string> = ["verify-before-done", "loop-back-debug", "review-diff"];

/** Title the first render seeds before the managed block. */
const HEADER = "# AGENTS.md\n";
/** User-owned section appended once, the first time AGENTS.md is created. */
const USER_SECTION =
  "\n<!-- navori:user-section -->\n" +
  "## Reglas del repo (tuyas)\n\n" +
  "<!-- Agrega acá lo específico de tu repo; navori no toca esta sección. -->\n";

/**
 * Build the skills index as prose. Independent from the Claude engine's
 * `buildSkillsIndexBody` (which references `.claude/skills/` paths that don't
 * exist for non-Claude tools); here the listing is path-free.
 */
function buildSkillsSection(config: NavoriConfig, repoRoot: string): string | null {
  const rows: string[] = [];
  const listed = new Set<string>();
  for (const id of CORE_SKILLS) {
    rows.push(`- \`${id}\` — navori`);
    listed.add(id);
  }
  if (config.preset && config.preset !== "custom") {
    try {
      const loaded = loadPreset(config.preset, repoRoot);
      for (const e of loaded?.def.extras.skills ?? []) {
        if (e.condition) continue; // conditional skills depend on Claude-side state
        const name = basename(e.destRelPath).replace(/\.md$/, "");
        if (listed.has(name)) continue;
        rows.push(`- \`${name}\` — preset (\`${config.preset}\`)`);
        listed.add(name);
      }
    } catch {
      // Preset issues surface in the Claude engine; the index degrades quietly.
    }
  }
  for (const id of config.project?.libraries ?? []) {
    if (listed.has(id) || !librarySkillById(id)) continue;
    rows.push(`- \`${id}\` — library (detected)`);
    listed.add(id);
  }
  if (rows.length === 0) return null;
  return ["## Skills disponibles", "", ...rows, ""].join("\n");
}

/** Short, engine-agnostic summary of how navori expects work to flow. */
function buildWorkflowSection(): string {
  return [
    "## Flujo de trabajo",
    "",
    "- Para tareas no triviales: análisis → plan → implementación. De una en una.",
    "- Antes de codear: ¿es lo más simple? ¿legible en 6 meses? ¿mantiene el patrón existente?",
    "- Busca con herramientas read-only (no leas el repo entero); cita `archivo:línea`.",
    "- Cierra con el quality gate del proyecto en verde antes de dar por terminado.",
    "",
  ].join("\n");
}

/**
 * Build the managed body: core rule blocks + preset stack + skills + workflow.
 * Reuses `computeRenderPlan` (engine-agnostic) for the rule blocks and keeps
 * only the core + preset sources — plugin blocks are Claude-specific.
 */
function buildManagedBody(config: NavoriConfig, repoRoot: string): string {
  const plan = computeRenderPlan("", config, repoRoot);
  // Keep core rule blocks + the active preset's stack block (its source is the
  // preset id). Plugin-contributed blocks (engram, etc.) are Claude-specific and
  // dropped — other tools don't have that infra.
  const ruleBlocks = plan.entries
    .filter(
      (e) =>
        e.newContent != null &&
        e.status !== "removed-condition-false" &&
        (e.source === "core" || e.source === config.preset),
    )
    .map((e) => e.newContent!.trim());

  const skills = buildSkillsSection(config, repoRoot);
  const sections = [
    "> Contexto del proyecto generado por navori. Lo leen Cursor, Codex, Gemini y Copilot.",
    ...ruleBlocks,
    ...(skills ? [skills] : []),
    buildWorkflowSection(),
  ];
  return sections.join("\n\n").trim() + "\n";
}

export function renderAgentsMdEngine(
  cwd: string,
  inputConfig: NavoriConfig,
  options: { dryRun?: boolean; repoRoot?: string } = {},
): AgentsMdEngineResult {
  const config = effectiveConfig(inputConfig);
  const repoRoot = options.repoRoot ?? cwd;
  const agentsMdPath = join(cwd, "AGENTS.md");

  const firstRender = !existsSync(agentsMdPath);
  const existing = firstRender ? HEADER : readFileSync(agentsMdPath, "utf-8");
  const body = buildManagedBody(config, repoRoot);

  const result = injectManagedSection(existing, MANAGED_ID, body, CORE_META, "html");
  // First render seeds a user-section after the managed block; on re-render the
  // existing file already has it and injectManagedSection preserves it in place.
  const output = firstRender ? result.output + USER_SECTION : result.output;

  const written: AgentsMdEngineResult["written"] = [];
  const skipped: AgentsMdEngineResult["skipped"] = [];
  let backupPath: string | null = null;

  if (result.status === "user-modified-skipped") {
    skipped.push({ path: "AGENTS.md", reason: "managed block edited by hand" });
  } else if (result.status === "unchanged") {
    // nothing to do
  } else {
    written.push({ path: "AGENTS.md", status: result.status });
    if (!options.dryRun) {
      if (!firstRender) {
        const handle = createBackup(cwd, ["AGENTS.md"]);
        if (handle.files.length > 0) backupPath = handle.path;
      }
      mkdirSync(dirname(agentsMdPath), { recursive: true });
      writeFileAtomic(agentsMdPath, output);
    }
  }

  return { written, skipped, warnings: [], backupPath };
}
