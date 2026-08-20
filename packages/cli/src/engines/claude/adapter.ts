import type { AdapterCtx, EngineAdapter, PlacementRequest } from "../shared/execute-plan.ts";

/**
 * Claude adapter (Spec 0008, Capa 2) — the SHARED slice only: core/preset
 * agents, core/workflow/preset/library skills, and core hooks, placed under
 * `.claude/`. Everything Claude-only (the CLAUDE.md pipeline, settings.json,
 * progress bootstrap, plugin scripts, injectInto sub-blocks and the 3-way
 * reconciliation) stays in `renderClaudeEngine` and feeds the SAME pending +
 * a single `commitWrites`. `extraFiles`/`orphanScans` are empty here on
 * purpose: those concerns live in the engine, not the adapter.
 *
 * Destinations are derived from the canonical id (`.claude/agents/<id>.md`,
 * `.claude/skills/<id>/SKILL.md`, etc.), matching how the bundled presets
 * already declare their extras. A local preset that ships an extra at a
 * non-standard path would be normalized to the derived path — none of the
 * bundled presets do (their `destRelPath` is always `.claude/<kind>/<id>.<ext>`),
 * so parity holds; revisit if a real preset needs an off-tree destination.
 *
 * Skills use the DIRECTORY form `.claude/skills/<id>/SKILL.md` — the only shape
 * Claude Code auto-discovers (a flat `<id>.md` never surfaces its
 * `description`/trigger to the model). Codex already uses the same shape under
 * `.agents/skills/`. The FLAT legacy `<id>.md` from repos onboarded before this
 * change is pruned by the engine's reconciliation (see `renderClaudeEngine`).
 *
 * `label` is intentionally omitted so a write failure reads "El render falló…"
 * exactly as Claude did before the spine.
 */
export function createClaudeAdapter(): EngineAdapter {
  return {
    id: "claude",
    // Kept in sync with the LIVE list in `index.ts` (the one the engine's own
    // `commitWrites` call passes) — `.mcp.json` included. Nothing reads this
    // copy today: the Claude engine only takes `collectPlan` from the spine,
    // and `collectPlan` never looks at backup targets. It is here because the
    // `EngineAdapter` contract requires it, and a WRONG value sitting in a
    // dead field is a landmine for whoever finishes the migration to
    // `executePlan` — it would silently drop `.mcp.json` from the backup.
    // Excludes are not this list's business: `commitWrites` always unions
    // `EPHEMERAL_HARNESS_PATHS` in, for every engine (#361). (#373)
    backupTargets: ["CLAUDE.md", ".claude", "navori.config.json", ".mcp.json"],

    placeAgent(agent): PlacementRequest {
      return {
        assetPath: agent.assetPath,
        destRelPath: `.claude/agents/${agent.id}.md`,
        managedId: agent.managedId,
        commentStyle: "html",
      };
    },

    placeSkill(skill): PlacementRequest {
      return {
        assetPath: skill.assetPath,
        // Directory form — the shape Claude Code auto-discovers. See the module
        // header; the flat legacy `<id>.md` is pruned by the engine.
        destRelPath: `.claude/skills/${skill.id}/SKILL.md`,
        managedId: skill.managedId,
        commentStyle: "html",
      };
    },

    placeHook(hook): PlacementRequest {
      return {
        assetPath: hook.assetPath,
        destRelPath: `.claude/hooks/${hook.id}.sh`,
        managedId: hook.managedId,
        commentStyle: "shell",
        chmodExec: true,
      };
    },

    // CLAUDE.md, settings.json, scripts and bootstrap are built in the engine
    // (Claude-only) and merged into the shared pending — not here.
    extraFiles(_ctx: AdapterCtx): PlacementRequest[] {
      return [];
    },

    // Claude's reconciliation (disabled plugins, removed/orphaned lib skills,
    // sub-block removal) is richer than OrphanScan[] and stays in the engine.
    orphanScans() {
      return [];
    },
  };
}
