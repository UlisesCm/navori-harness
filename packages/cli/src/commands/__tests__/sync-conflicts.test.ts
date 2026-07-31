import { describe, it, expect } from "vitest";
import { collectTargetConflicts, type SyncTarget, type TargetPlan } from "../sync.ts";
import type { ClaudeEngineResult } from "../../engines/claude/index.ts";
import type { EngineRenderSummary } from "../render.ts";
import type { NavoriConfig } from "../../lib/config.ts";
import type { SkippedFile } from "../../engines/shared/execute-plan.ts";

/**
 * #241: whole-file conflict detection must key off the stable
 * `user-modified-skipped` status, NOT a regex over localized skip prose. These
 * tests pin that: a user-modified skip whose reason contains NO "edit" substring
 * is still a conflict, and a downgrade skip whose reason DOES contain "edited"
 * is not — the exact cases the old `/editad|edit/i` regex got wrong.
 */

const TARGET: SyncTarget = {
  label: "root",
  cwd: "/repo",
  repoRoot: "/repo",
  config: {} as unknown as NavoriConfig,
};

function claudeResult(skipped: SkippedFile[]): ClaudeEngineResult {
  return {
    written: [],
    skipped,
    warnings: [],
    backupPath: null,
    claudeMdEntries: [],
    updatesAvailable: [],
    downgrades: [],
    languageFallbacks: [],
    inspected: 0,
  };
}

function engineSummary(skipped: SkippedFile[]): EngineRenderSummary {
  return { engine: "cursor", written: [], skipped, warnings: [], backupPath: null };
}

describe("collectTargetConflicts (#241 status-based detection)", () => {
  it("flags a claude user-modified skip even when the reason has no 'edit' substring", () => {
    // A reworded/relocalized reason the old regex would have missed.
    const plan: TargetPlan = {
      target: TARGET,
      claude: claudeResult([
        {
          path: ".claude/agents/leader.md",
          reason: "bloque tocado a mano; se conservó",
          status: "user-modified-skipped",
        },
      ]),
      engines: [],
    };

    const conflicts = collectTargetConflicts(plan);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.path).toBe(".claude/agents/leader.md");
  });

  it("does NOT flag a downgrade skip even when its reason contains 'edited'", () => {
    const plan: TargetPlan = {
      target: TARGET,
      claude: claudeResult([
        {
          path: ".claude/agents/leader.md",
          reason: "block edited by a newer navori",
          status: "downgrade-skipped",
        },
      ]),
      engines: [],
    };

    expect(collectTargetConflicts(plan)).toEqual([]);
  });

  it("ignores skips with no status (e.g. settings.json parse failures)", () => {
    const plan: TargetPlan = {
      target: TARGET,
      claude: claudeResult([
        { path: ".claude/settings.json", reason: "no se pudo parsear settings.json" },
      ]),
      engines: [],
    };

    expect(collectTargetConflicts(plan)).toEqual([]);
  });

  it("flags a non-Claude engine user-modified skip and prefixes it with the engine", () => {
    const plan: TargetPlan = {
      target: TARGET,
      claude: undefined,
      engines: [
        engineSummary([
          { path: ".cursor/rules/navori.mdc", reason: "editado", status: "user-modified-skipped" },
        ]),
      ],
    };

    const conflicts = collectTargetConflicts(plan);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.path).toBe("[cursor] .cursor/rules/navori.mdc");
  });

  it("prefixes a workspace target's conflict with its label", () => {
    const plan: TargetPlan = {
      target: { ...TARGET, label: "workspace:backend" },
      claude: claudeResult([
        { path: "CLAUDE.md", reason: "whatever", status: "user-modified-skipped" },
      ]),
      engines: [],
    };

    const conflicts = collectTargetConflicts(plan);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.path).toBe("[workspace:backend] CLAUDE.md");
  });
});
