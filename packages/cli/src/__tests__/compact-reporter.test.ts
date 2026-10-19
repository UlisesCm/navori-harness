import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { TestCase, TestModule } from "vitest/node";
import { runCoverage } from "../../scripts/run-test-coverage.mjs";
import { renderCompact } from "../../vitest.reporter.ts";

type Err = {
  message: string;
  name?: string;
  diff?: string;
  stacks?: { file: string; line: number }[];
};

/** Only reporter-consumed fields; expand when another Vitest member is consumed. Native API verified below. */
function fakeCase(
  file: string,
  name: string,
  state: "passed" | "failed" | "skipped" | "pending",
  errors: Err[] = [],
  logs: string[] = [],
): TestCase {
  return {
    fullName: name,
    module: { relativeModuleId: file },
    result: () => ({ state, errors }),
    logs: () => logs.map((content) => ({ content })),
  } as unknown as TestCase;
}

/** Only reporter-consumed fields; expand when another module member is consumed. */
function fakeModule(
  file: string,
  tests: TestCase[],
  errors: Err[] = [],
  suiteErrors: Err[] = [],
): TestModule {
  return {
    relativeModuleId: file,
    errors: () => errors,
    children: {
      allTests: () => tests[Symbol.iterator](),
      allSuites: () =>
        (suiteErrors.length > 0 ? [{ fullName: "suite", errors: () => suiteErrors }] : [])[
          Symbol.iterator
        ](),
    },
  } as unknown as TestModule;
}

describe("compact reporter", () => {
  // Covers: R26
  it("coverage JSON output retains the console reporter selected for this terminal", () => {
    const calls: string[][] = [];
    const status = runCoverage({
      env: { NAVORI_COVERAGE_DIR: "/tmp/compact-report", NAVORI_TEST_REPORT: "/tmp/tests.json" },
      spawnSync: (_command, args) => {
        calls.push(args);
        return { status: 0 };
      },
    });
    expect(status).toBe(0);
    expect(calls[0]).toEqual([
      "x",
      "vitest",
      "run",
      "--coverage",
      `--reporter=${process.stdout.isTTY ? "default" : "./vitest.reporter.ts"}`,
      "--reporter=json",
      "--outputFile.json=/tmp/tests.json",
    ]);
  });

  // Covers: R26
  it("green is one totals line", () => {
    const out = renderCompact(
      [
        fakeModule("a.test.ts", [
          fakeCase("a.test.ts", "ok", "passed"),
          fakeCase("a.test.ts", "s", "skipped"),
        ]),
      ],
      [],
      1.26,
    );
    expect(out).toBe("Tests: 1 passed, 1 skipped (1 files) in 1.3s\n");
  });

  // Covers: R27
  it("rojo muestra errores de carga, nombres y detalles acotados", () => {
    const stackTail = "TAIL-OF-STACK-MARKER";
    const many = Array.from({ length: 60 }, (_, i) =>
      fakeCase(
        "b.test.ts",
        `case ${i}`,
        "failed",
        [
          {
            name: "AssertionError",
            message: "expected 1 to be 2",
            diff: `${"x".repeat(5000)}${stackTail}`,
          },
        ],
        ["console noise"],
      ),
    );
    const out = renderCompact(
      [
        fakeModule("b.test.ts", many, [], [{ message: "afterAll exploded" }]),
        fakeModule(
          "broken.test.ts",
          [],
          [{ name: "SyntaxError", message: "cannot import ./missing" }],
        ),
      ],
      [{ name: "Error", message: "unhandled rejection" }],
      2,
    );
    expect(out).toContain("Tests: 60 failed");
    expect(out).toContain("broken.test.ts: SyntaxError: cannot import ./missing");
    expect(out).toContain("suite: Error: afterAll exploded");
    expect(out).toContain("unhandled: Error: unhandled rejection");
    expect(out.match(/^FAIL /gm)).toHaveLength(50);
    expect(out).toContain("… 10 more failed");
    const details = out.split("\n--- ").slice(1);
    expect(details).toHaveLength(10);
    for (const d of details) {
      expect(Buffer.byteLength(d.split("\n").slice(1).join("\n"))).toBeLessThanOrEqual(1200);
    }
    expect(details[0]).toContain("AssertionError: expected 1 to be 2");
    expect(details[0]).toContain(stackTail);
  });

  // Covers: R27
  it("an error outside any case is red even with no failed case", () => {
    const out = renderCompact([fakeModule("c.test.ts", [], [{ message: "boom" }])], [], 0);
    expect(out).toContain("Tests: 0 failed");
    expect(out).toContain("c.test.ts: Error: boom");
  });

  // Covers: R27
  it("a bailed run with no failed case is red INTERRUPTED and counts unfinished tests", () => {
    const tests = [fakeCase("d.test.ts", "a", "passed"), fakeCase("d.test.ts", "b", "pending")];
    const out = renderCompact([fakeModule("d.test.ts", tests)], [], 1, "interrupted");
    expect(out).toContain("Tests: INTERRUPTED (interrupted) — 1 passed, 0 skipped, 1 not finished");
  });

  // Covers: R27
  it("detail carries the failing frame inside the test file", () => {
    const failing = fakeCase("e.test.ts", "x", "failed", [
      {
        message: "nope",
        stacks: [
          { file: "/node_modules/lib.js", line: 1 },
          { file: "/repo/src/e.test.ts", line: 42 },
        ],
      },
    ]);
    expect(renderCompact([fakeModule("e.test.ts", [failing])], [], 1)).toContain("at e.test.ts:42");
  });

  // Covers: R27
  it("real vitest run: names the case, file:line and the module error", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const root = resolve(here, "fixtures/compact-smoke");
    const bin = resolve(here, "../../node_modules/.bin/vitest");
    const config = resolve(root, "vitest.config.mjs");
    const run = spawnSync(bin, ["run", "--root", root, "--config", config], {
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    });
    const out = `${run.stdout}${run.stderr}`;
    expect(run.status).toBe(1);
    expect(out).toContain("Tests: 1 failed");
    expect(out).toContain("FAIL boom.fix.ts > smoke case fails");
    expect(out).toMatch(/at boom\.fix\.ts:\d+/);
    expect(out).toContain("broken.fix.ts: ");
    expect(out).toContain("missing-module");
  }, 60_000);
});
