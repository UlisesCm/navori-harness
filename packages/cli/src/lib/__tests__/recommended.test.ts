import { describe, it, expect } from "vitest";
import {
  buildRecommendedQualityGate,
  buildRecommendedProject,
  validatorProjectFlags,
} from "../recommended.ts";
import type { DetectedProject, StackInfo } from "../detect.ts";

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
      validator: null,
      deps: [],
    },
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

describe("validatorProjectFlags", () => {
  const stackWith = (validator: StackInfo["validator"]): StackInfo => ({
    ...makeDetected().stack,
    validator,
  });

  it("maps zod to { zodValidation: true }", () => {
    expect(validatorProjectFlags(stackWith("zod"))).toEqual({ zodValidation: true });
  });

  it("maps joi to { joiValidation: true }", () => {
    expect(validatorProjectFlags(stackWith("joi"))).toEqual({ joiValidation: true });
  });

  it("returns {} when no validator is detected", () => {
    expect(validatorProjectFlags(stackWith(null))).toEqual({});
  });
});
