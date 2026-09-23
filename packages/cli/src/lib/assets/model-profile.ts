import type { NavoriConfig } from "../config/config.ts";
import { CORE_AGENTS, isAgentEnabled } from "../../engines/shared/harness-assets.ts";

/** Which per-agent tier(s) render frontmatter omits for this agent. */
export type MissingTier = "model" | "effort";

export interface MissingModelProfile {
  /** Core agent id (e.g. "researcher"), matching `.claude/agents/<id>.md`. */
  agent: string;
  /** The harness key this agent is assigned in navori.config.json (e.g. "researcher"). */
  harnessKey: string;
  missing: MissingTier[];
}

/**
 * Core agents whose source template declares `model: {{models.<agent>}}` /
 * `effort: {{effort.<agent>}}` (issue #817) but whose tier is unset in
 * `navori.config.json`.
 *
 * Both fields are OPTIONAL by design (see `ModelsSchema`/`EffortSchema` in
 * `schema.ts`): a repo that never sets them is not misconfigured — every agent
 * simply inherits the session's model/effort, and `renderManagedFile` reflects
 * that by DROPPING the frontmatter line (`omitUnresolvedKeyLines`) rather than
 * emitting a broken YAML value or a frozen placeholder. That is correct and
 * deliberate, but it also means nothing in the rendered file signals the gap —
 * a repo that MEANT to set a cost-aware profile (see `RECOMMENDED_MODELS` /
 * `RECOMMENDED_EFFORT` in `recommended.ts`) and forgot has no way to notice.
 * This scan is that signal. Advisory only: it never flips `doctor`'s `ok`,
 * the same treatment as the sibling `gateReadiness` / `emptyUserSections`
 * checks — an unset tier is a valid default, not a hard failure.
 */
export function scanMissingModelProfile(config: NavoriConfig): MissingModelProfile[] {
  // Only the disk engines (claude, codex) ever read `models`/`effort` per
  // agent — a repo rendering only prose engines (agents-md, cursor, copilot)
  // never emits a per-agent model tier, so there is nothing to warn about.
  const hasDiskEngine = config.engines.some((e) => e === "claude" || e === "codex");
  if (!hasDiskEngine) return [];

  const out: MissingModelProfile[] = [];
  for (const agent of CORE_AGENTS) {
    if (!isAgentEnabled(config, agent.harnessKey)) continue;
    const missing: MissingTier[] = [];
    if (!config.models?.[agent.harnessKey]) missing.push("model");
    if (!config.effort?.[agent.harnessKey]) missing.push("effort");
    if (missing.length > 0) out.push({ agent: agent.id, harnessKey: agent.harnessKey, missing });
  }
  return out;
}
