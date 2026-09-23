import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NavoriConfig } from "../config.ts";
import { scanQualityGateReadiness } from "../gate-readiness.ts";

/**
 * #368 — a declared gate that can't run makes three phases of the intake
 * pipeline structurally unreachable, and nothing noticed until an implementer
 * hit it mid-task. These tests pin the three static blockers and, just as
 * importantly, the cases that must NOT warn: a false alarm on the gate is what
 * would teach people to ignore doctor.
 */
let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-gate-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function config(gate: { fast?: string; full?: string }): NavoriConfig {
  return {
    name: "demo",
    engines: ["claude"],
    preset: "custom",
    language: "es",
    branchBase: "main",
    commits: "conventional-es",
    qualityGate: gate,
  } as NavoriConfig;
}

/** Materialize a package.json (and optionally its node_modules) at `rel`. */
function pkg(rel: string, scripts: Record<string, string>, withDeps = true): void {
  const dir = join(cwd, rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", scripts }));
  if (withDeps) mkdirSync(join(dir, "node_modules"), { recursive: true });
}

describe("scanQualityGateReadiness (#368)", () => {
  it("says nothing when no gate is declared", () => {
    expect(scanQualityGateReadiness(cwd, config({}))).toEqual([]);
  });

  it("flags a gate whose binary is not on PATH", () => {
    const issues = scanQualityGateReadiness(cwd, config({ fast: "navori-not-a-binary check" }));
    expect(issues).toEqual([
      { gate: "fast", detail: "navori-not-a-binary", reason: "missing-binary" },
    ]);
  });

  // The measured case: the binary is there, the script is there, but nobody ran
  // an install — so every phase that leans on the gate fails at the worst time.
  it("flags a package-manager gate with no node_modules", () => {
    pkg(".", { test: "vitest run" }, false);
    const issues = scanQualityGateReadiness(cwd, config({ fast: "npm test" }));
    expect(issues).toEqual([{ gate: "fast", detail: ".", reason: "missing-deps" }]);
  });

  it("flags a script the package.json doesn't declare", () => {
    pkg(".", { test: "vitest run" });
    const issues = scanQualityGateReadiness(cwd, config({ fast: "npm run typecheck" }));
    expect(issues).toEqual([{ gate: "fast", detail: "typecheck", reason: "missing-script" }]);
  });

  it("follows a `cd` into the directory the next segment runs in", () => {
    pkg(".", { "format:check": "biome format" });
    pkg("packages/cli", { test: "vitest run" });
    // Every segment resolves: root has format:check, packages/cli has test.
    expect(
      scanQualityGateReadiness(
        cwd,
        config({ full: "npm run format:check && cd packages/cli && npm test" }),
      ),
    ).toEqual([]);
    // …and the script is looked up in the RIGHT package.json: `test` lives in
    // packages/cli, so asking for it at the root must flag it.
    expect(scanQualityGateReadiness(cwd, config({ full: "npm test" }))).toEqual([
      { gate: "full", detail: "test", reason: "missing-script" },
    ]);
  });

  it("declines to guess the script when the invocation carries flags", () => {
    pkg(".", { test: "vitest run" });
    // `--filter cli` could be a workspace selector, not a script: no verdict.
    expect(scanQualityGateReadiness(cwd, config({ fast: "npm --filter cli lint" }))).toEqual([]);
  });

  it("ignores shell builtins and env-var prefixes", () => {
    pkg(".", { lint: "oxlint" });
    expect(
      scanQualityGateReadiness(cwd, config({ fast: "echo start && CI=1 npm run lint" })),
    ).toEqual([]);
  });

  it("reports a blocker once even when both gates hit it", () => {
    const issues = scanQualityGateReadiness(
      cwd,
      config({ fast: "navori-nope lint", full: "navori-nope test" }),
    );
    expect(issues).toHaveLength(1);
  });

  it("stays silent for a non-JS gate whose binary exists", () => {
    // `sh` is on PATH everywhere the suite runs; no package.json contract to check.
    expect(scanQualityGateReadiness(cwd, config({ fast: "sh -c true" }))).toEqual([]);
  });
});
