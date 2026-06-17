import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  suggestNextSteps,
  collectMissingPlugins,
  scanManagedDrift,
  listMarkers,
  type DriftReport,
} from "../health.ts";
import { NavoriConfigSchema } from "../schema.ts";
import { computeManagedHash } from "../marker.ts";

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

describe("collectMissingPlugins", () => {
  const cfg = (plugins: Record<string, { enabled: boolean }>) =>
    NavoriConfigSchema.parse({ name: "demo", engines: ["claude"], preset: "custom", plugins });

  it("reports an enabled plugin that can't be loaded", () => {
    const missing = collectMissingPlugins(cfg({ "ghost-plugin": { enabled: true } }));
    expect(missing).toHaveLength(1);
    expect(missing[0]!.id).toBe("ghost-plugin");
  });

  it("ignores disabled plugins", () => {
    expect(collectMissingPlugins(cfg({ "ghost-plugin": { enabled: false } }))).toHaveLength(0);
  });

  it("returns empty when there are no plugins", () => {
    expect(
      collectMissingPlugins(NavoriConfigSchema.parse({ name: "demo", engines: ["claude"], preset: "custom" })),
    ).toHaveLength(0);
  });
});

describe("listMarkers + scanManagedDrift", () => {
  let cwd: string;
  const config = NavoriConfigSchema.parse({ name: "demo", engines: ["claude"], preset: "custom" });

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "navori-health-"));
    mkdirSync(join(cwd, ".claude/agents"), { recursive: true });
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  function writeAgent(body: string, attrs: string): void {
    writeFileSync(
      join(cwd, ".claude/agents/leader.md"),
      `<!-- navori:managed id="leader-base" ${attrs} -->\n${body}\n<!-- /navori:managed id="leader-base" -->\n`,
    );
  }

  it("listMarkers parses id/hash/version/source", () => {
    writeAgent("body", 'hash="abc123" version="9.9.9" source="@navori/core"');
    const markers = listMarkers(join(cwd, ".claude/agents/leader.md"));
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      id: "leader-base",
      hash: "abc123",
      version: "9.9.9",
      source: "@navori/core",
    });
  });

  it("listMarkers returns [] for a missing file", () => {
    expect(listMarkers(join(cwd, "nope.md"))).toEqual([]);
  });

  it("detects content drift when the body no longer matches its hash", () => {
    writeAgent("hand-edited body", 'hash="deadbeef" version="9.9.9" source="@navori/core"');
    const drifts = scanManagedDrift(cwd, config);
    expect(drifts.some((d) => d.kind === "content" && d.markerId === "leader-base")).toBe(true);
  });

  it("detects version drift when the version is older than the bundle", () => {
    // Correct hash so content drift doesn't fire — isolate the version check.
    const body = "stable body";
    writeAgent(body, `hash="${computeManagedHash(body)}" version="0.0.0" source="@navori/core"`);
    const drifts = scanManagedDrift(cwd, config);
    expect(drifts.some((d) => d.kind === "version" && d.markerId === "leader-base")).toBe(true);
    expect(drifts.some((d) => d.kind === "content")).toBe(false);
  });

  it("no drift for a marker without version/hash attrs", () => {
    writeAgent("body", 'source="@navori/core"');
    expect(scanManagedDrift(cwd, config)).toHaveLength(0);
  });
});
