import { describe, it, expect } from "vitest";
import { suggestNextSteps, type DriftReport } from "../health.ts";

const contentDrift: DriftReport = {
  filePath: ".claude/agents/leader.md",
  markerId: "leader-base",
  source: "@navori/core",
  kind: "content",
};
const versionDrift: DriftReport = {
  filePath: ".claude/agents/leader.md",
  markerId: "leader-base",
  source: "@navori/core",
  kind: "version",
  fromVersion: "0.0.1",
  toVersion: "0.0.2",
};

describe("suggestNextSteps (spec 0003 §3.5.3)", () => {
  it("suggests render --apply when CLAUDE.md is missing", () => {
    const steps = suggestNextSteps({ claudeMdExists: false, missingPlugins: [], drifts: [] });
    expect(steps.some((s) => s.includes("render --apply"))).toBe(true);
  });

  it("suggests sync --interactive on content drift", () => {
    const steps = suggestNextSteps({ claudeMdExists: true, missingPlugins: [], drifts: [contentDrift] });
    expect(steps.some((s) => s.includes("sync --interactive"))).toBe(true);
  });

  it("suggests render --apply on version drift", () => {
    const steps = suggestNextSteps({ claudeMdExists: true, missingPlugins: [], drifts: [versionDrift] });
    expect(steps.some((s) => s.includes("render --apply"))).toBe(true);
  });

  it("flags missing plugins", () => {
    const steps = suggestNextSteps({
      claudeMdExists: true,
      missingPlugins: [{ id: "ghost", reason: "unknown plugin id" }],
      drifts: [],
    });
    expect(steps.some((s) => s.toLowerCase().includes("plugin"))).toBe(true);
  });

  it("says all-clear when nothing is pending", () => {
    const steps = suggestNextSteps({ claudeMdExists: true, missingPlugins: [], drifts: [] });
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatch(/al día/i);
  });
});
