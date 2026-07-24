import { describe, it, expect } from "vitest";
import {
  buildRecommendedQualityGate,
  buildRecommendedProject,
  buildFullPlugins,
  buildFullProject,
  RECOMMENDED_MODELS,
  RECOMMENDED_EFFORT,
} from "../recommended.ts";
import { KNOWN_PLUGINS } from "../plugins.ts";
import type { DetectedProject } from "../detect.ts";

function makeDetected(overrides: Partial<DetectedProject> = {}): DetectedProject {
  return {
    name: "demo",
    branchBase: "main",
    existingEngines: [],
    packageManager: "pnpm",
    monorepo: null,
    stack: {
      language: "js",
      framework: null,
      ui: null,
      forms: null,
      state: null,
      test: null,
      worker: null,
      deps: [],
    },
    libraries: [],
    suggestedPreset: "custom",
    qualityGate: null,
    claudeInfra: { present: false, files: [] } as DetectedProject["claudeInfra"],
    sources: { name: null, branchBase: null, packageManager: null },
    ...overrides,
  };
}

describe("buildRecommendedQualityGate", () => {
  it("returns '<pm> tsc --noEmit' when TypeScript is detected", () => {
    const detected = makeDetected({
      stack: { ...makeDetected().stack, language: "ts" },
    });
    expect(buildRecommendedQualityGate(detected)).toEqual({
      fast: "pnpm tsc --noEmit",
      full: "pnpm tsc --noEmit",
    });
  });

  it("respects the detected packageManager", () => {
    const detected = makeDetected({
      packageManager: "bun",
      stack: { ...makeDetected().stack, language: "ts" },
    });
    expect(buildRecommendedQualityGate(detected)).toEqual({
      fast: "bun tsc --noEmit",
      full: "bun tsc --noEmit",
    });
  });

  it("uses 'yarn tsc' for yarn (bare bin resolution works)", () => {
    const detected = makeDetected({
      packageManager: "yarn",
      stack: { ...makeDetected().stack, language: "ts" },
    });
    expect(buildRecommendedQualityGate(detected)?.fast).toBe("yarn tsc --noEmit");
  });

  it("routes npm through npx ('npm tsc' is an unknown command) (#88)", () => {
    const detected = makeDetected({
      packageManager: "npm",
      stack: { ...makeDetected().stack, language: "ts" },
    });
    expect(buildRecommendedQualityGate(detected)).toEqual({
      fast: "npx tsc --noEmit",
      full: "npx tsc --noEmit",
    });
  });

  it("defaults to pnpm when no package manager is detected", () => {
    const detected = makeDetected({
      packageManager: null,
      stack: { ...makeDetected().stack, language: "ts" },
    });
    expect(buildRecommendedQualityGate(detected)?.fast).toBe("pnpm tsc --noEmit");
  });

  it("returns null when language is js (no TS) — conservative no-fallback", () => {
    const detected = makeDetected({
      stack: { ...makeDetected().stack, language: "js" },
    });
    expect(buildRecommendedQualityGate(detected)).toBeNull();
  });

  it("returns null when language is python (handled by guessQualityGate)", () => {
    const detected = makeDetected({
      stack: { ...makeDetected().stack, language: "python" },
    });
    expect(buildRecommendedQualityGate(detected)).toBeNull();
  });

  it("returns null when language is rust", () => {
    const detected = makeDetected({
      stack: { ...makeDetected().stack, language: "rust" },
    });
    expect(buildRecommendedQualityGate(detected)).toBeNull();
  });

  it("returns null when language is unknown", () => {
    const detected = makeDetected({
      stack: { ...makeDetected().stack, language: "unknown" },
    });
    expect(buildRecommendedQualityGate(detected)).toBeNull();
  });
});

describe("buildRecommendedProject", () => {
  it("returns empty arrays + testRunner when test stack is detected", () => {
    const detected = makeDetected({
      stack: { ...makeDetected().stack, test: "vitest" },
    });
    expect(buildRecommendedProject(detected)).toEqual({
      legacyPaths: [],
      criticalAreas: [],
      testRunner: "vitest",
    });
  });

  it("omits testRunner when not detected", () => {
    const detected = makeDetected({
      stack: { ...makeDetected().stack, test: null },
    });
    const result = buildRecommendedProject(detected);
    expect(result).toEqual({
      legacyPaths: [],
      criticalAreas: [],
    });
    expect("testRunner" in result).toBe(false);
  });

  it("propagates jest as testRunner", () => {
    const detected = makeDetected({
      stack: { ...makeDetected().stack, test: "jest" },
    });
    expect(buildRecommendedProject(detected).testRunner).toBe("jest");
  });

  it("propagates @playwright/test as testRunner", () => {
    const detected = makeDetected({
      stack: { ...makeDetected().stack, test: "@playwright/test" },
    });
    expect(buildRecommendedProject(detected).testRunner).toBe("@playwright/test");
  });
});

describe("buildFullPlugins", () => {
  it("enables every id it is given", () => {
    const ids = Object.keys(KNOWN_PLUGINS);
    const result = buildFullPlugins(ids);
    expect(Object.keys(result).sort()).toEqual([...ids].sort());
    for (const id of ids) {
      expect(result[id]).toEqual({ enabled: true });
    }
  });

  it("enables the binary-dependent plugins (jscpd/semgrep/gh/acli) unconditionally", () => {
    const result = buildFullPlugins(["jscpd", "semgrep", "gh", "acli"]);
    for (const id of ["jscpd", "semgrep", "gh", "acli"]) {
      expect(result[id]).toEqual({ enabled: true });
    }
  });

  it("only enables the ids passed in (bundled-aware caller decides the set)", () => {
    const result = buildFullPlugins(["engram", "gh"]);
    expect(Object.keys(result).sort()).toEqual(["engram", "gh"]);
  });

  it("returns an empty set for an empty id list", () => {
    expect(buildFullPlugins([])).toEqual({});
  });
});

describe("buildFullProject", () => {
  it("extends the recommended baseline with a strict production posture", () => {
    const detected = makeDetected({
      stack: { ...makeDetected().stack, test: "vitest" },
    });
    expect(buildFullProject(detected)).toEqual({
      legacyPaths: [],
      criticalAreas: [],
      testRunner: "vitest",
      posture: "production",
      reviewRigor: "strict",
      testsForNewCode: "always",
    });
  });

  it("never invents architectureRule (repo-specific)", () => {
    const result = buildFullProject(makeDetected());
    expect("architectureRule" in result).toBe(false);
  });

  it("still omits testRunner when no test stack is detected", () => {
    const result = buildFullProject(makeDetected({ stack: { ...makeDetected().stack, test: null } }));
    expect("testRunner" in result).toBe(false);
    expect(result.posture).toBe("production");
  });
});

describe("RECOMMENDED_MODELS", () => {
  it("keeps judgement roles on opus and drops mechanical roles to cheaper tiers", () => {
    // Orchestration/review keep the top tier; code/synthesis → sonnet; read-only → haiku.
    expect(RECOMMENDED_MODELS.leader).toBe("opus");
    expect(RECOMMENDED_MODELS.implementer).toBe("sonnet");
    expect(RECOMMENDED_MODELS.reviewer).toBe("sonnet");
    expect(RECOMMENDED_MODELS.explorer).toBe("haiku");
    expect(RECOMMENDED_MODELS.commitPrPilot).toBe("haiku");
  });

  it("covers every configurable agent role (no agent silently inherits the session model)", () => {
    expect(Object.keys(RECOMMENDED_MODELS).sort()).toEqual(
      ["auditor", "commitPrPilot", "explorer", "implementer", "leader", "researcher", "reviewer", "ticketAudit"].sort(),
    );
  });

  it("only uses valid model aliases", () => {
    const valid = new Set(["opus", "sonnet", "haiku"]);
    for (const m of Object.values(RECOMMENDED_MODELS)) expect(valid.has(m)).toBe(true);
  });
});

describe("RECOMMENDED_EFFORT", () => {
  it("keeps the orchestrator at xhigh and drops mechanical agents to low", () => {
    expect(RECOMMENDED_EFFORT.leader).toBe("xhigh");
    expect(RECOMMENDED_EFFORT.implementer).toBe("medium");
    expect(RECOMMENDED_EFFORT.explorer).toBe("low");
    expect(RECOMMENDED_EFFORT.commitPrPilot).toBe("low");
  });

  it("covers the same agent roles as the model profile", () => {
    expect(Object.keys(RECOMMENDED_EFFORT).sort()).toEqual(Object.keys(RECOMMENDED_MODELS).sort());
  });

  it("only uses valid effort levels", () => {
    const valid = new Set(["low", "medium", "high", "xhigh", "max"]);
    for (const e of Object.values(RECOMMENDED_EFFORT)) expect(valid.has(e)).toBe(true);
  });
});
