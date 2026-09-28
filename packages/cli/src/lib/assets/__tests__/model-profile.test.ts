import { describe, it, expect } from "vitest";
import type { NavoriConfig } from "../../config/config.ts";
import {
  resolveCodexModel,
  scanMissingModelProfile,
  scanModelProfileProvenance,
} from "../model-profile.ts";

/**
 * #817 — the 8 core agents template `model: {{models.<agent>}}` / `effort:
 * {{effort.<agent>}}`, but both fields are OPTIONAL in `navori.config.json`
 * (see `ModelsSchema`/`EffortSchema`). When a tier is unset, `renderManagedFile`
 * drops the frontmatter line silently (by design — see `omitUnresolvedKeyLines`
 * in render-managed-file.ts), so nothing in the rendered agent signals the gap.
 * This advisory scan must fire the two ways a
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
        orchestrator: "opus",
        implementer: "sonnet",
        reviewer: "sonnet",
        scout: "sonnet",
        auditor: "sonnet",
        publisher: "haiku",
        scribe: "haiku",
        architect: "opus",
      },
      effort: {
        orchestrator: "xhigh",
        implementer: "medium",
        reviewer: "medium",
        scout: "medium",
        auditor: "medium",
        publisher: "low",
        scribe: "low",
        architect: "high",
      },
    });
    expect(scanMissingModelProfile(cfg)).toEqual([]);
  });

  it("flags every enabled agent as missing both tiers when neither is configured", () => {
    const issues = scanMissingModelProfile(config());
    expect(issues).toContainEqual({
      agent: "scout",
      harnessKey: "scout",
      missing: ["model", "effort"],
    });
    // The 8 core agents on by default (orchestrator included — it's rendered
    // for Claude; `architect` always renders too since spec 0032 R33 retired
    // its `harness.architect` toggle).
    expect(issues.map((i) => i.agent).sort()).toEqual(
      [
        "architect",
        "auditor",
        "implementer",
        "orchestrator",
        "publisher",
        "reviewer",
        "scout",
        "scribe",
      ].sort(),
    );
  });

  // Spec 0032 (#1011), R33: `harness.architect` is retired — the agent always
  // renders, so it is flagged by default like every other core agent whose
  // tiers are unset.
  it("architect is flagged by default (no more harness.architect toggle)", () => {
    const architect = scanMissingModelProfile(config()).find((i) => i.agent === "architect");
    expect(architect).toEqual({
      agent: "architect",
      harnessKey: "architect",
      missing: ["model", "effort"],
    });
  });

  it("flags only the missing half when one tier is set and the other isn't", () => {
    const cfg = config({ models: { scout: "sonnet" } });
    const scout = scanMissingModelProfile(cfg).find((i) => i.agent === "scout");
    expect(scout).toEqual({
      agent: "scout",
      harnessKey: "scout",
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

describe("model profile provenance (Spec 0037 R12)", () => {
  // Covers: R12
  it("reports an explicit Claude profile without inventing a host-resolved model", () => {
    const rows = scanModelProfileProvenance(
      config({ models: { reviewer: "sonnet" }, effort: { reviewer: "low" } }),
    );
    expect(rows.find((row) => row.agent === "reviewer")).toEqual({
      engine: "claude",
      agent: "reviewer",
      model: {
        configured: "sonnet",
        origin: "explicit",
        wouldRender: "sonnet",
        effectiveObserved: null,
      },
      effort: {
        configured: "low",
        origin: "explicit",
        wouldRender: "low",
        effectiveObserved: null,
      },
    });
    expect(rows.some((row) => row.agent === "orchestrator")).toBe(false);
  });

  // Covers: R12
  it("distinguishes configured Codex mapping from the built-in fallback", () => {
    const cfg = config({
      engines: ["codex"],
      models: {
        implementer: "sonnet",
        reviewer: "haiku",
        codexMap: { sonnet: "gpt-6-custom" },
      },
      effort: { implementer: "high", reviewer: "low" },
    });
    const rows = scanModelProfileProvenance(cfg);
    expect(rows.find((row) => row.agent === "implementer")?.model).toEqual({
      configured: "sonnet",
      origin: "mapped",
      wouldRender: "gpt-6-custom",
      effectiveObserved: null,
      mapping: "configured",
    });
    expect(rows.find((row) => row.agent === "reviewer")?.model).toEqual({
      configured: "haiku",
      origin: "mapped",
      wouldRender: "gpt-6-luna",
      effectiveObserved: null,
      mapping: "built-in",
    });
    expect(rows.find((row) => row.agent === "reviewer")?.effort).toEqual({
      configured: "low",
      origin: "explicit",
      wouldRender: "low",
      effectiveObserved: null,
    });
    expect(resolveCodexModel(cfg, "sonnet")).toEqual({
      model: "gpt-6-custom",
      mapping: "configured",
    });
  });

  // Covers: R12
  it("keeps omitted architect model and effort inherited rather than erroneous", () => {
    const rows = scanModelProfileProvenance(
      config({ engines: ["claude", "codex"], models: { reviewer: "sonnet" } }),
    );
    expect(rows.filter((row) => row.agent === "architect")).toEqual([
      {
        engine: "claude",
        agent: "architect",
        model: {
          configured: null,
          origin: "inherited",
          wouldRender: null,
          effectiveObserved: null,
        },
        effort: {
          configured: null,
          origin: "inherited",
          wouldRender: null,
          effectiveObserved: null,
        },
      },
      {
        engine: "codex",
        agent: "architect",
        model: {
          configured: null,
          origin: "inherited",
          wouldRender: null,
          effectiveObserved: null,
        },
        effort: {
          configured: null,
          origin: "inherited",
          wouldRender: null,
          effectiveObserved: null,
        },
      },
    ]);
  });

  // Covers: R12 — main-thread effort is a separate Claude settings contract.
  it("does not misreport orchestrator effort as a spawned-agent profile", () => {
    for (const effort of ["low", "max"] as const) {
      const rows = scanModelProfileProvenance(
        config({ engines: ["claude", "codex"], effort: { orchestrator: effort } }),
      );
      expect(rows.some((row) => row.agent === "orchestrator")).toBe(false);
    }
  });
});
