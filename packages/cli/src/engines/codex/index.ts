import type { NavoriConfig } from "../../lib/config.ts";
import { effectiveConfig } from "../../lib/config.ts";
import type { ProseEngineResult } from "../shared/prose-harness.ts";

/**
 * Codex engine adapter — full parity with the Claude engine, retargeted to
 * Codex's locations: AGENTS.md (root), .codex/skills/<id>/SKILL.md,
 * .codex/config.toml ([agents]/[mcp_servers]/[[hooks]]/sandbox), .codex/hooks/*.sh.
 * Returns the ProseEngineResult shape so it plugs into renderNonClaudeEngines
 * (DT-1). Phases 2-5 fill this body incrementally.
 */
export function renderCodexEngine(
  cwd: string,
  inputConfig: NavoriConfig,
  options: { dryRun?: boolean; repoRoot?: string } = {},
): ProseEngineResult {
  const config = effectiveConfig(inputConfig);
  const written: ProseEngineResult["written"] = [];
  const skipped: ProseEngineResult["skipped"] = [];
  const warnings: string[] = [];
  // Phases 2-5 populate this body. For now, a verifiable no-op.
  void config;
  void cwd;
  void options;
  return { written, skipped, warnings, backupPath: null };
}
