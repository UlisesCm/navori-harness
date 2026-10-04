import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NavoriConfig } from "../config/config.ts";
import { resolveCodexModelValue, type CodexModelSource } from "../codex/model-catalog.ts";
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

/** The configured tier is not evidence of a host-resolved model identity. */
export type ProfileOrigin = "explicit" | "mapped" | "inherited";

export interface ProfileValue {
  configured: string | null;
  origin: ProfileOrigin;
  /** Config projection only; doctor does not inspect rendered files here. */
  wouldRender: string | null;
  /** Static doctor cannot observe the model/effort actually used by the host. */
  effectiveObserved: null;
  mapping?: "configured" | "built-in";
  /** Codex only: whether the id came from a family lookup, a pinned id or the last-known fallback. */
  source?: CodexModelSource;
}

/** One renderable core subagent; main-thread orchestrator and preset extras are excluded. */
export interface ModelProfileProvenance {
  engine: "claude" | "codex";
  agent: string;
  model: ProfileValue;
  effort: ProfileValue;
}

// Shared by the Codex renderer and doctor. Tier names describe routing, not
// equivalent quality across hosts (Spec 0037 R12). Values are model FAMILIES
// (spec 0041 R32), resolved against the local Codex catalog at render time.
const CODEX_MODEL_BY_CLAUDE_TIER = {
  opus: "sol",
  sonnet: "sol",
  haiku: "luna",
} as const;

export interface CodexModelChoice {
  model: string;
  mapping: "configured" | "built-in";
  source: CodexModelSource;
  /** Set when `source` is `fallback`: the family missing from the local catalog. */
  family?: string;
}

/**
 * Resolve a configured tier to a concrete Codex model id (spec 0041 R32).
 * `models.codexMap[tier]` (or the built-in family) is a family name or a full
 * id: an id is a pin, a family resolves to the highest-version catalog model.
 * Never throws; `catalogPath` is injectable so tests never read `~/.codex`.
 */
export function resolveCodexModel(
  config: NavoriConfig,
  tier: keyof typeof CODEX_MODEL_BY_CLAUDE_TIER,
  catalogPath?: string | null,
  previous: string | null = null,
): CodexModelChoice {
  const configured = config.models?.codexMap?.[tier];
  const value = configured ?? CODEX_MODEL_BY_CLAUDE_TIER[tier];
  const resolved =
    catalogPath === undefined
      ? resolveCodexModelValue(value, undefined, previous)
      : resolveCodexModelValue(value, catalogPath, previous);
  return { ...resolved, mapping: configured !== undefined ? "configured" : "built-in" };
}

/** Model id currently rendered in `.codex/agents/<agent>.toml`, or null (absent, unreadable, none). */
export function readRenderedCodexModel(cwd: string, agentId: string): string | null {
  try {
    const toml = readFileSync(join(cwd, ".codex/agents", `${agentId}.toml`), "utf-8");
    return /^model\s*=\s*"([^"]+)"/m.exec(toml)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** A rendered `.codex/agents/<agent>.toml` model that its family no longer resolves to. */
export interface StaleCodexModel {
  agent: string;
  rendered: string;
  current: string;
}

/**
 * Compare the model rendered in each `.codex/agents/*.toml` against the current
 * resolution of its tier (spec 0041 R32). Pinned ids and matching models are
 * silent; an agent without a rendered model, or an unreadable file, is skipped.
 * Never throws; `catalogPath` is injectable like `resolveCodexModel`.
 */
export function scanStaleCodexModels(
  cwd: string,
  config: NavoriConfig,
  catalogPath?: string | null,
): StaleCodexModel[] {
  const stale: StaleCodexModel[] = [];
  for (const agent of CORE_AGENTS) {
    if (agent.id === "orchestrator" || !isAgentEnabled(config, agent.harnessKey)) continue;
    const tier = config.models?.[agent.harnessKey];
    if (!tier) continue;
    const rendered = readRenderedCodexModel(cwd, agent.id);
    if (rendered === null) continue;
    const current = resolveCodexModel(config, tier, catalogPath, rendered);
    if (current.source === "pin" || current.model === rendered) continue;
    stale.push({ agent: agent.id, rendered, current: current.model });
  }
  return stale;
}

/** Project core-subagent profiles without guessing host inheritance or file state. */
export function scanModelProfileProvenance(config: NavoriConfig): ModelProfileProvenance[] {
  const rows: ModelProfileProvenance[] = [];
  for (const engine of config.engines) {
    if (engine !== "claude" && engine !== "codex") continue;
    for (const agent of CORE_AGENTS) {
      // The main thread embodies orchestrator; there is no spawned agent model.
      // Claude's effort.orchestrator may seed settings.json effortLevel (except
      // max), but that root setting belongs to T16's separate evaluation.
      if (agent.id === "orchestrator" || !isAgentEnabled(config, agent.harnessKey)) continue;
      const tier = config.models?.[agent.harnessKey];
      const configuredEffort = config.effort?.[agent.harnessKey];
      const mapped = engine === "codex" && tier ? resolveCodexModel(config, tier) : null;
      rows.push({
        engine,
        agent: agent.id,
        model: tier
          ? {
              configured: tier,
              origin: mapped ? "mapped" : "explicit",
              wouldRender: mapped?.model ?? tier,
              effectiveObserved: null,
              ...(mapped ? { mapping: mapped.mapping, source: mapped.source } : {}),
            }
          : { configured: null, origin: "inherited", wouldRender: null, effectiveObserved: null },
        effort: configuredEffort
          ? {
              configured: configuredEffort,
              origin: "explicit",
              wouldRender: configuredEffort,
              effectiveObserved: null,
            }
          : { configured: null, origin: "inherited", wouldRender: null, effectiveObserved: null },
      });
    }
  }
  return rows;
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
 * This scan is the human advisory signal; `scanModelProfileProvenance` adds
 * machine-readable provenance. Advisory only: it never flips `doctor`'s `ok`,
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
