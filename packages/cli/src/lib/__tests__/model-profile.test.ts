import { describe, it, expect } from "vitest";
import type { NavoriConfig } from "../config.ts";
import { scanMissingModelProfile } from "../model-profile.ts";

/**
 * #817 — the 8 core agents template `model: {{models.<agent>}}` / `effort:
 * {{effort.<agent>}}`, but both fields are OPTIONAL in `navori.config.json`
 * (see `ModelsSchema`/`EffortSchema`). When a tier is unset, `renderManagedFile`
 * drops the frontmatter line silently (by design — see `omitUnresolvedKeyLines`
 * in render-managed-file.ts), so nothing in the rendered agent signals the gap.
 * This scan is the only place it surfaces, and it must fire the two ways a
 * misconfiguration could be missed: a repo that never configured the profile at
 * all, and one that configured half of it (model but not effort, or vice versa).
 */
function config(overrides: Partial<NavoriConfig> = {}): NavoriConfig {
  return {
    name: "demo",
    engines: ["claude"],
    preset: "custom",
    language: "es",
    branchBase: "main",
    commits: "conventional-es",
    ...overrides,
  } as NavoriConfig;
}

describe("scanMissingModelProfile (#817)", () => {
  it("reports nothing when every enabled agent has both tiers set", () => {
    const cfg = config({
      models: {
        leader: "opus",
        implementer: "sonnet",
        reviewer: "sonnet",
        researcher: "sonnet",
        ticketAudit: "sonnet",
        commitPrPilot: "haiku",
        explorer: "haiku",
        auditor: "sonnet",
      },
      effort: {
        leader: "xhigh",
        implementer: "medium",
        reviewer: "medium",
        researcher: "medium",
        ticketAudit: "medium",
        commitPrPilot: "low",
        explorer: "low",
        auditor: "medium",
      },
    });
    expect(scanMissingModelProfile(cfg)).toEqual([]);
  });

  it("flags every enabled agent as missing both tiers when neither is configured", () => {
    const issues = scanMissingModelProfile(config());
    expect(issues).toContainEqual({
      agent: "researcher",
      harnessKey: "researcher",
      missing: ["model", "effort"],
    });
    // The 8 core agents (leader included — it's rendered for Claude).
    expect(issues.map((i) => i.agent).sort()).toEqual(
      [
        "auditor",
        "commit-pr-pilot",
        "explorer",
        "implementer",
        "leader",
        "researcher",
        "reviewer",
        "ticket-audit",
      ].sort(),
    );
  });

  it("flags only the missing half when one tier is set and the other isn't", () => {
    const cfg = config({ models: { researcher: "sonnet" } });
    const researcher = scanMissingModelProfile(cfg).find((i) => i.agent === "researcher");
    expect(researcher).toEqual({
      agent: "researcher",
      harnessKey: "researcher",
      missing: ["effort"],
    });
  });

  it("skips an agent disabled via harness", () => {
    const cfg = config({ harness: { auditor: false } as NavoriConfig["harness"] });
    expect(scanMissingModelProfile(cfg).some((i) => i.agent === "auditor")).toBe(false);
  });

  it("says nothing when no disk engine is configured (agents-md never emits a model tier)", () => {
    const cfg = config({ engines: ["agents-md"] });
    expect(scanMissingModelProfile(cfg)).toEqual([]);
  });
});
