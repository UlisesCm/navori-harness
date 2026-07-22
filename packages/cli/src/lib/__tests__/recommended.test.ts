import { describe, it, expect } from "vitest";
import {
  buildRecommendedQualityGate,
  buildRecommendedProject,
  buildFullPlugins,
  buildFullProject,
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

  it("enables the binary-dependent plugins (jscpd/semgrep/cognitive/gh/acli) unconditionally", () => {
    const result = buildFullPlugins(["jscpd", "semgrep", "cognitive", "gh", "acli"]);
    for (const id of ["jscpd", "semgrep", "cognitive", "gh", "acli"]) {
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
