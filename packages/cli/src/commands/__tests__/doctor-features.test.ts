import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderClaudeEngine } from "../../engines/claude/index.ts";
import { scanUnknownFeatures, scanFeatureExternalSkills } from "../doctor.ts";
import { scanManagedDrift } from "../../lib/health.ts";
import type { NavoriConfig } from "../../lib/config.ts";

const MANIFEST = {
  id: "app-builder",
  displayName: "App builder",
  description: "Trigger: build a mobile app. Phased end-to-end app creation.",
  type: "feature",
  kind: "bootstrap",
  phases: [
    // core skill (active) + one navori bundles under NO preset (truly external)
    { n: 0, slug: "product", objetivo: "x", skills: ["verify-before-done", "made-up-skill"], gate: "g" },
    // both bundled under presets that aren't active on a "custom" repo — these
    // must NOT be flagged as external (regression: they were, ~20 false warnings).
    { n: 1, slug: "scaffold", objetivo: "y", skills: ["expo-runtime", "astro-islands"], gate: "g" },
  ],
  invariants: [],
};

function config(features: string[]): NavoriConfig {
  return {
    name: "demo",
    engines: ["claude"],
    preset: "custom",
    version: "1.0.0",
    language: "es",
    branchBase: "main",
    commits: "conventional-es",
    features,
  } as unknown as NavoriConfig;
}

let cwd: string;

function writeFixture(): void {
  const dir = join(cwd, ".navori/features/app-builder");
  mkdirSync(join(dir, "phases"), { recursive: true });
  writeFileSync(join(dir, "feature.json"), JSON.stringify(MANIFEST, null, 2));
  writeFileSync(join(dir, "FEATURE.md"), "# App builder\n\nOrquestas fases.\n");
  writeFileSync(join(dir, "phases/0-product.md"), "# 0 — product\n\nDefine el producto.\n");
  writeFileSync(join(dir, "phases/1-scaffold.md"), "# 1 — scaffold\n\nMonorepo.\n");
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-doctor-feat-"));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("doctor — features", () => {
  it("scanUnknownFeatures flags an id with no bundle, clears for a known one", () => {
    expect(scanUnknownFeatures(cwd, config(["no-such-feature-zzz"]))).toEqual(["no-such-feature-zzz"]);
    writeFixture();
    expect(scanUnknownFeatures(cwd, config(["app-builder"]))).toEqual([]);
  });

  it("scanFeatureExternalSkills splits truly-external from inactive-preset skills", () => {
    writeFixture();
    const out = scanFeatureExternalSkills(cwd, config(["app-builder"]));
    expect(out).toHaveLength(1);
    expect(out[0]!.featureId).toBe("app-builder");

    // Only a skill navori bundles under NO preset is "external".
    expect(out[0]!.external).toEqual(["made-up-skill"]);
    // The active core skill is not flagged at all.
    expect(out[0]!.external).not.toContain("verify-before-done");
    expect(out[0]!.inactivePreset).not.toContain("verify-before-done");

    // Skills bundled under an INACTIVE preset are the softer bucket — NOT external.
    const inactive = out[0]!.inactivePreset.sort();
    expect(inactive).toEqual(["astro-islands", "expo-runtime"]);
    expect(out[0]!.external).not.toContain("expo-runtime");
    expect(out[0]!.external).not.toContain("astro-islands");
  });

  it("scanFeatureExternalSkills is empty when no features are active", () => {
    expect(scanFeatureExternalSkills(cwd, config([]))).toEqual([]);
  });

  it("reports content drift on a hand-edited rendered phase file", () => {
    writeFixture();
    renderClaudeEngine(cwd, config(["app-builder"]));

    // Hand-edit the rendered phase body inside the managed markers WITHOUT
    // updating the hash — the exact drift signature doctor must catch.
    const phasePath = join(cwd, ".claude/skills/app-builder/phases/1-scaffold.md");
    const edited = readFileSync(phasePath, "utf-8").replace("Monorepo.", "Monorepo hand-edited.");
    writeFileSync(phasePath, edited);

    const drifts = scanManagedDrift(cwd, config(["app-builder"]));
    const phaseDrift = drifts.find(
      (d) => d.filePath.includes("phases/1-scaffold.md") && d.kind === "content",
    );
    expect(phaseDrift).toBeDefined();
    expect(phaseDrift!.source).toBe("@navori/feature-app-builder");
  });
});
