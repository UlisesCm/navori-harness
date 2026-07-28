import { type NavoriConfig } from "../../lib/config.ts";
import { renderProseFile, type ProseEngineResult } from "../shared/prose-harness.ts";

/**
 * Codex engine adapter — full parity with the Claude engine, retargeted to
 * Codex's locations: AGENTS.md (root), .codex/skills/<id>/SKILL.md,
 * .codex/config.toml ([agents]/[mcp_servers]/[[hooks]]/sandbox), .codex/hooks/*.sh.
 * Returns the ProseEngineResult shape so it plugs into renderNonClaudeEngines
 * (DT-1).
 *
 * Phase status: Fase 2 emits AGENTS.md (with orchestration). Fases 3-5 add
 * skills, config.toml and hooks — they push into the same aggregated result.
 */

export type CodexEngineResult = ProseEngineResult;

/** Managed-block id for Codex's AGENTS.md. Distinct from the `agents-md` engine
 * so both can be introspected independently; a repo should target one or the
 * other for AGENTS.md, not both. */
const AGENTS_MANAGED_ID = "navori-codex-agents";

/** Title the first render seeds before the managed block. */
const AGENTS_HEADER = "# AGENTS.md\n";
/** User-owned section appended once, the first time AGENTS.md is created. */
const AGENTS_USER_SECTION =
  "\n<!-- navori:user-section -->\n" +
  "## Reglas del repo (tuyas)\n\n" +
  "<!-- Agrega aquí lo específico de tu repo; navori no toca esta sección. -->\n";

export function renderCodexEngine(
  cwd: string,
  inputConfig: NavoriConfig,
  options: { dryRun?: boolean; repoRoot?: string } = {},
): CodexEngineResult {
  // Fase 2 — AGENTS.md with the orchestration block (Codex has subagents, so it
  // gets context parity, unlike the prose engines). Omission warnings are
  // suppressed because Codex DOES replicate hooks/permissions/subagents.
  return renderProseFile({
    cwd,
    config: inputConfig,
    destRelPath: "AGENTS.md",
    managedId: AGENTS_MANAGED_ID,
    header: AGENTS_HEADER,
    userSection: AGENTS_USER_SECTION,
    dryRun: options.dryRun,
    repoRoot: options.repoRoot,
    includeOrchestration: true,
    suppressOmissionWarnings: true,
  });
}
