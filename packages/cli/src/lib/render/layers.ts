import { CORE_MANAGED_ASSETS, type AssetPlanEntry } from "./render-plan.ts";

/**
 * The layer a rendered block belongs to (spec 0064). It decides which file carries the block once
 * `AGENTS.md` is the shared source:
 *  - `shared`: neutral text every reader can act on (core rules, preset stack, shared plugin blocks).
 *  - `claude`: true only on Claude Code (its tools, paths and permission model).
 *  - `orchestrator`: doctrine for the main agent, which a child never receives.
 */
export type Layer = "shared" | "claude" | "orchestrator";

/**
 * Layer of one plan entry. `audience` wins (it already routes the block elsewhere), then an explicit
 * `layer`, then provenance: core and the active preset's blocks are shared, while a plugin block
 * that declares nothing is read as Claude-specific (as it was before layers existed).
 */
export function layerOf(entry: AssetPlanEntry, presetId: string | undefined): Layer {
  if (entry.asset.audience === "orchestrator") return "orchestrator";
  if (entry.asset.layer !== undefined) return entry.asset.layer;
  return entry.source === "core" || entry.source === presetId ? "shared" : "claude";
}

/** True only for a block that explicitly declares the Claude layer; undeclared plugin blocks do not count. */
export function declaresClaudeLayer(entry: AssetPlanEntry): boolean {
  return entry.asset.audience !== "orchestrator" && entry.asset.layer === "claude";
}

/** Ids of the orchestrator layer, derived from the `audience` each core asset declares. */
export const ORCHESTRATOR_LAYER_IDS: ReadonlySet<string> = new Set(
  CORE_MANAGED_ASSETS.filter((asset) => asset.audience === "orchestrator").map((asset) => asset.id),
);

/**
 * Layer of each block the Claude engine computes outside the plan (they have no asset to carry a
 * `layer`; the plan would also hand them to cursor and copilot). Declared exception: a test requires
 * these keys to be exactly `CLAUDE_COMPUTED_BLOCK_IDS`, so a new computed block cannot go unclassified.
 */
export const COMPUTED_BLOCK_LAYERS: Readonly<Record<string, Layer>> = {
  "agentes-disponibles": "orchestrator",
  "contexto-proyecto": "shared",
  "contexto-monorepo": "claude",
};
