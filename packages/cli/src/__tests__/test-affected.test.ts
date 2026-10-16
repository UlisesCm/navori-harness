import { describe, expect, it } from "vitest";
import { planAffected } from "../../scripts/test-affected.mjs";

const T = (name: string): string => `packages/cli/src/__tests__/${name}.test.ts`;
const RENDER = "packages/cli/src/lib/render/__tests__/render.test.ts";
const GOLDEN = "packages/cli/src/__tests__/golden-render-tree.test.ts";
const E2E = T("cli.e2e");
const testFiles = [T("a"), T("b"), RENDER, GOLDEN, E2E];

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
