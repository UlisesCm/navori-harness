import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  affectedVitestArgs,
  mergeBaseRefs,
  parseAffectedArgs,
  planAffected,
} from "../../scripts/test-affected.mjs";

const T = (name: string): string => `packages/cli/src/__tests__/${name}.test.ts`;
const RENDER = "packages/cli/src/lib/render/__tests__/render.test.ts";
const GOLDEN = "packages/cli/src/__tests__/golden-render-tree.test.ts";
const E2E = T("cli.e2e");
const testFiles = [
  T("a"),
  T("b"),
  RENDER,
  GOLDEN,
  E2E,
  ...Array.from({ length: 10 }, (_, i) => T(`unrelated-${i}`)),
];

function plan(
  changes: Array<{ path: string; deleted?: boolean }>,
  grep: Record<string, string[]> = {},
  hasMergeBase = true,
): ReturnType<typeof planAffected> {
  return planAffected({
    changes: changes.map((c) => ({ path: c.path, deleted: c.deleted ?? false })),
    hasMergeBase,
    testFiles,
    grep: (needle: string) => grep[needle] ?? [],
  });
}

describe("planAffected", () => {
  // Covers: R24
  it("selects direct hook tests by filename and runs full for shared hook partials", () => {
    const guard = "packages/cli/src/lib/__tests__/guard-destructive.test.ts";
    const progress = "packages/cli/src/lib/__tests__/guard-destructive-progress.test.ts";
    const selected = planAffected({
      changes: [{ path: "packages/core/core-assets/hooks/guard-destructive.sh", deleted: false }],
      hasMergeBase: true,
      testFiles: [...testFiles, guard, progress],
      grep: (needle: string) => (needle === "guard-destructive.sh" ? [guard, progress] : []),
    });
    expect(selected.full).toBe(false);
    expect(selected.tests).toEqual(expect.arrayContaining([guard, progress, RENDER, GOLDEN]));
    expect(plan([{ path: "packages/core/core-assets/hooks/_partials/extract-cmd.sh" }]).full).toBe(
      true,
    );
  });
  // Covers: R24
  it("runner scripts outside the source graph require full tests, including deletions", () => {
    for (const path of [
      "packages/cli/scripts/test-affected.mjs",
      "packages/cli/scripts/run-test-coverage.mjs",
      "scripts/js/test-import-graph.mjs",
      "scripts/js/check-test-preservation.mjs",
      "scripts/js/test-preservation.config.json",
    ]) {
      for (const deleted of [false, true])
        expect(plan([{ path, deleted }])).toMatchObject({
          full: true,
          reason: `${path} is outside the source import graph`,
        });
    }
  });
  // Covers: R24
  it("plan-json outputs only JSON and executes no tests for explicit test paths", () => {
    const result = spawnSync(
      process.execPath,
      [
        resolve(import.meta.dirname, "../../scripts/test-affected.mjs"),
        "--files",
        T("test-affected"),
        "--plan-json",
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const output: unknown = JSON.parse(result.stdout);
    expect(output).toMatchObject({ full: false, related: [], tests: [T("test-affected")] });
    expect(result.stdout.split("\n")).toHaveLength(2);
  });
  // Covers: R24
  it("base explícita, hub medido y umbral por salida disparan la suite completa", () => {
    expect(mergeBaseRefs("feature", { NAVORI_AFFECTED_BASE: "env" })).toEqual(["feature"]);
    expect(mergeBaseRefs(undefined, { NAVORI_AFFECTED_BASE: "env" })).toEqual(["env"]);
    expect(mergeBaseRefs(undefined, {})).toEqual(["origin/dev", "dev"]);
    for (const path of ["lib/config/config.ts", "engines/shared/permission-rules.ts"]) {
      expect(plan([{ path: `packages/cli/src/${path}` }]).full).toBe(true);
    }
    const source = "packages/cli/src/lib/shared.ts";
    const tests = Array.from({ length: 10 }, (_, i) => T(`graph-${i}`));
    const graph = new Map(tests.slice(0, 3).map((t) => [t, [source]]));
    const input = {
      changes: [{ path: source, deleted: false }],
      hasMergeBase: true,
      testFiles: tests,
      grep: () => [],
      graph,
    };
    expect(planAffected(input).full).toBe(false);
    graph.set(tests[3]!, [source]);
    expect(planAffected(input)).toMatchObject({
      full: true,
      reason: "estimated 4/10 test files (>=40%)",
    });
    graph.set(source, [source]); // A cycle cannot hang the estimator.
    expect(planAffected(input).full).toBe(true);
  });

  // Covers: R24
  it("parses explicit files and emits one native invocation for source and test union", () => {
    expect(parseAffectedArgs(["--base", "dev", "--files", T("a"), "--plan-json"])).toEqual({
      base: "dev",
      files: [T("a")],
      planJson: true,
    });
    for (const args of [["--base"], ["--unknown"], ["--files", "../outside"]])
      expect(() => parseAffectedArgs(args)).toThrow();
    const selected = plan([{ path: "packages/cli/src/lib/x.ts" }, { path: T("a") }]);
    expect(affectedVitestArgs(selected)).toEqual([
      "related",
      "--run",
      "src/__tests__/a.test.ts",
      "src/lib/x.ts",
    ]);
    expect(affectedVitestArgs({ ...selected, full: true })).toEqual(["run"]);
  });
  // Covers: R11
  it("ruteo por tipo de cambio, borrados, core-assets y caída a suite completa", () => {
    // A source file goes to `vitest related`; a changed test runs directly.
    const src = plan([{ path: "packages/cli/src/lib/x.ts" }, { path: T("a") }]);
    expect(src).toMatchObject({
      full: false,
      related: ["packages/cli/src/lib/x.ts"],
      tests: [T("a")],
    });

    // A deleted test is not run; a deleted source never reaches `related` and selects by name.
    const del = plan(
      [
        { path: T("gone"), deleted: true },
        { path: "packages/cli/src/lib/old.ts", deleted: true },
      ],
      { "packages/cli/src/lib/old.ts": [T("a")], old: [T("b")] },
    );
    expect(del.related).toEqual([]);
    expect(del.tests).toEqual([T("a"), T("b")]);

    // .md/.sh/.json select the tests naming the path.
    const doc = plan([{ path: "docs/x.md" }], { "docs/x.md": [T("b")] });
    expect(doc).toMatchObject({ full: false, tests: [T("b")] });

    // core-assets add render and golden tests by directory rule, plus dist/index.js specs.
    const core = plan([{ path: "packages/core/core-assets/agents/x.md" }], {
      "dist/index.js": [E2E],
    });
    expect(core.tests).toEqual([E2E, GOLDEN, RENDER].sort());

    // A dist input (non-test source) also selects the specs that spawn dist/index.js.
    const dist = plan([{ path: "packages/cli/src/index.ts" }], { "dist/index.js": [E2E] });
    expect(dist.related).toEqual(["packages/cli/src/index.ts"]);
    expect(dist.tests).toEqual([E2E]);

    // Test-only change does not select dist specs.
    expect(plan([{ path: T("a") }], { "dist/index.js": [E2E] }).tests).toEqual([T("a")]);

    // Config, TS config, manifests and lockfiles run everything.
    for (const path of [
      "packages/cli/vitest.config.ts",
      "tsconfig.base.json",
      "packages/cli/package.json",
      "bun.lock",
    ]) {
      expect(plan([{ path }]).full).toBe(true);
    }

    // No merge-base falls back to the full suite.
    expect(plan([], {}, false)).toMatchObject({ full: true });

    // Nothing changed selects nothing.
    expect(plan([])).toMatchObject({ full: false, related: [], tests: [] });
  });
});
