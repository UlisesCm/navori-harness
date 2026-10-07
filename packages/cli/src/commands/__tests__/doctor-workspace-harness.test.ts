import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeConfig, type NavoriConfig } from "../../lib/config/config.ts";
import { NavoriConfigSchema } from "../../lib/config/schema.ts";
import { runRender } from "../render.ts";
import { buildEngineEvidence, buildEngineInventory, scanWorkspaceFullHarness } from "../doctor.ts";

/**
 * Spec 0043 T12/T13 — `doctor` reads a trimmed workspace (`minimal`, `root`) as
 * trimmed: it does not call `missing` what the mode omits, and under `full` it
 * says, informationally, that the workspace's hooks and agents are unused.
 */

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-doctor-ws-"));
  mkdirSync(join(cwd, "apps/api"), { recursive: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(cwd, { recursive: true, force: true });
});

function setup(harness: "minimal" | "full" | "root", engines = ["claude", "codex"]): NavoriConfig {
  const config = NavoriConfigSchema.parse({
    name: "doctor-ws",
    engines,
    preset: "monorepo-turbopnpm",
    qualityGate: { fast: "pnpm -w lint", full: "pnpm -w test" },
    monorepo: {
      enabled: true,
      tool: "turbo",
      workspaces: [{ name: "api", path: "apps/api", preset: "nextjs" }],
      workspaceHarness: harness,
    },
  });
  writeConfig(join(cwd, "navori.config.json"), config);
  expect(runRender(cwd, { dryRun: false }).ok).toBe(true);
  return config;
}

describe("doctor sobre workspaces recortados (spec 0043 T12)", () => {
  for (const harness of ["minimal", "root"] as const) {
    it(`la evidencia de un workspace \`${harness}\` no marca \`missing\` agentes, hooks ni skills omitidas`, () => {
      // Covers: R10
      const config = setup(harness);
      const rows = buildEngineEvidence(config, cwd).filter(
        (r) => r.location === "apps/api" && r.engine === "claude",
      );
      if (harness === "minimal") expect(rows.length).toBeGreaterThan(0);
      expect(rows.filter((r) => r.materialized.status === "missing")).toEqual([]);
      expect(rows.some((r) => r.kind === "agent" || r.kind === "hook")).toBe(false);
      // Lo que sí lleva (preset propio) sigue observándose.
      const skills = rows.filter((r) => r.kind === "skill").map((r) => r.id);
      if (harness === "minimal") expect(skills).toContain("nextjs-app-router");
      else expect(skills).toEqual([]);
    });
  }

  it("bajo `root` el inventario cuenta lo subido en la raíz", () => {
    // Covers: R10
    const config = setup("root");
    expect(buildEngineInventory(config, cwd).claude?.skills).toContain("nextjs-app-router");
    const rootRows = buildEngineEvidence(config, cwd).filter(
      (r) => r.location === "." && r.engine === "claude" && r.id === "nextjs-app-router",
    );
    expect(rootRows.map((r) => r.materialized.status)).toEqual(["verified"]);
  });
});

describe("doctor bajo `full` (spec 0043 T13)", () => {
  it("bajo `full` aparece la nota y bajo `minimal` y `root` no", () => {
    // Covers: R11
    expect(scanWorkspaceFullHarness(setup("full"))).toEqual({ workspaces: ["apps/api"] });
    expect(scanWorkspaceFullHarness(setup("minimal"))).toBeNull();
    expect(scanWorkspaceFullHarness(setup("root"))).toBeNull();
  });
});
