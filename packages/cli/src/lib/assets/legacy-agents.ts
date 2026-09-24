import type { NavoriConfig } from "../config/config.ts";
import { AGENT_ROLE_KEYS } from "../config/config.ts";

/**
 * Legacy agent filenames (hand-rolled harnesses that predate navori) mapped to
 * the canonical navori agent that supersedes them. When a repo being adopted
 * ships `sdd-leader.md` AND navori generates `leader.md`, the two are redundant:
 * the user ends up with duplicated, confusing agents. navori can't delete the
 * legacy file — it carries no navori marker, so it's the user's content — but it
 * CAN recognize the alias and tell the user which file is now superseded.
 *
 * Append here as new legacy names surface in real adoptions.
 */
export const LEGACY_AGENT_ALIASES: Readonly<Record<string, string>> = {
  "sdd-leader": "orchestrator",
  "sdd-implementer": "implementer",
  "sdd-reviewer": "reviewer",
  "sdd-explorer": "scout",
  "sdd-researcher": "scout",
  "sdd-ticket-audit": "auditor",
  "deep-auditor": "auditor",
};

/**
 * Canonical agent id (kebab, = filename) → its role key (camel). Exported
 * (spec 0026 T8, R42) so `roster-parity.test.ts` can verify it against
 * `engines/shared/roster.ts` without a second hand-copied mapping.
 *
 * Typed against `AGENT_ROLE_KEYS` (the role-key space), not
 * `keyof NavoriConfig["harness"]`: since spec 0032 R33 retired
 * `harness.architect`, "architect" is a valid role key with no matching
 * harness toggle — `detectLegacyAgents` below special-cases it.
 */
export const CANONICAL_HARNESS_KEY: Readonly<Record<string, (typeof AGENT_ROLE_KEYS)[number]>> = {
  orchestrator: "orchestrator",
  implementer: "implementer",
  reviewer: "reviewer",
  scout: "scout",
  auditor: "auditor",
  publisher: "publisher",
  scribe: "scribe",
  architect: "architect",
};

/** A legacy agent file whose canonical navori replacement is active. */
export interface LegacyAgent {
  /** The legacy file's basename without `.md` (e.g. `sdd-leader`). */
  legacyName: string;
  /** The canonical navori agent that supersedes it (e.g. `leader`). */
  canonical: string;
}

/**
 * Given the agent filenames found in `.claude/agents/`, return the ones that are
 * a known legacy alias of a canonical agent navori actively manages. A legacy
 * file is only flagged when its canonical replacement is enabled in the harness
 * (a disabled canonical means no duplication, so nothing to supersede).
 *
 * `agentFiles` may carry the `.md` extension or not — both are handled.
 */
export function detectLegacyAgents(
  agentFiles: readonly string[],
  config: NavoriConfig,
): LegacyAgent[] {
  const harness = config.harness;
  const out: LegacyAgent[] = [];
  for (const file of agentFiles) {
    const legacyName = file.replace(/\.md$/, "");
    const canonical = LEGACY_AGENT_ALIASES[legacyName];
    if (!canonical) continue;
    const key = CANONICAL_HARNESS_KEY[canonical];
    // No harness section → all agents default on. Otherwise honor the flag
    // (undefined is treated as enabled, matching isAgentEnabled in the engine).
    // `architect` (spec 0032 R33) has no harness toggle anymore — always enabled.
    const enabled = !harness || !key || key === "architect" || harness[key] !== false;
    if (enabled) out.push({ legacyName, canonical });
  }
  return out;
}
