import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Spec 0054 T15 — the preservation check. Fixed text fixtures only: the repo
 * run at the bottom reads the working tree and git, it never runs the suite.
 */

interface Preservation {
  compareFile: (input: {
    label: string;
    baseTexts: string[];
    nowText: string;
    removedCases?: string[];
    rowIds?: boolean;
  }) => string[];
  compareLiteralBaseline: (input: {
    baseline: { positive?: unknown[]; negative?: unknown[] };
    expected: { positive: number; negative: number; equivalenceCase: string };
    nowText: string;
  }) => string[];
}

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(
  here,
  "..",
  "..",
  "..",
  "..",
  "scripts",
  "js",
  "check-test-preservation.mjs",
);
// Loaded by computed URL: a static import would pull the root script under this package's rootDir.
const { compareFile, compareLiteralBaseline } = (await import(
  pathToFileURL(SCRIPT).href
)) as Preservation;

const BASE = [
  "// Covers: R1, R2",
  'it("a", () => {});',
  'it("b", () => {});',
  "// Covers: #12",
  'it("c", () => {});',
].join("\n");

describe("check-test-preservation", () => {
  // Covers: R7, R8, R9
  it("detecta un Covers perdido, un caso de menos y una mutación que no rompe nada", () => {
    expect(compareFile({ label: "f", baseTexts: [BASE], nowText: BASE })).toEqual([]);

    const lostCovers = BASE.replace("R2", "R9");
    expect(compareFile({ label: "f", baseTexts: [BASE], nowText: lostCovers })).toContain(
      'f: lost "Covers: R2"',
    );

    const fewer = BASE.replace('it("c", () => {});', "");
    expect(compareFile({ label: "f", baseTexts: [BASE], nowText: fewer }).join("\n")).toContain(
      "2 cases, baseline 3",
    );
    // A documented removal is allowed, an undocumented one is named.
    expect(
      compareFile({ label: "f", baseTexts: [BASE], nowText: fewer, removedCases: ["c"] }),
    ).toEqual([]);
    const renamed = fewer.replace('it("b"', 'it("z"');
    expect(
      compareFile({ label: "f", baseTexts: [BASE], nowText: renamed, removedCases: ["c"] }),
    ).toContain('f: case removed without documentation: "b"');
    expect(
      compareFile({ label: "f", baseTexts: [BASE], nowText: BASE, removedCases: ["c"] }),
    ).toContain('f: "c" is listed as removed but still exists');

    // Table rows count for a merged file.
    const table = ['it.each(ROWS)("$id", () => {});', '  id: "x",', '  id: "y",', '  id: "z",'];
    expect(
      compareFile({ label: "m", baseTexts: [BASE], nowText: table.join("\n"), rowIds: true }).join(
        "\n",
      ),
    ).toContain('lost "Covers: R1"');
    expect(
      compareFile({
        label: "m",
        baseTexts: ["it('a', () => {});"],
        nowText: table.join("\n"),
        rowIds: true,
      }),
    ).toEqual([]);

    // Literal baseline: shrunk counts or a missing equivalence case fail.
    const expected = { positive: 2, negative: 1, equivalenceCase: "same tokens" };
    const nowText = 'it("same tokens", () => {});';
    expect(
      compareLiteralBaseline({
        baseline: { positive: ["a", "b"], negative: ["c"] },
        expected,
        nowText,
      }),
    ).toEqual([]);
    expect(
      compareLiteralBaseline({
        baseline: { positive: ["a"], negative: [] },
        expected,
        nowText: "",
      }),
    ).toHaveLength(3);
  });

  // Covers: R7
  it("la config del repo sobre el árbol actual conserva casos y Covers", () => {
    const run = spawnSync("node", [SCRIPT], { encoding: "utf8" });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("preserved");
  });
});
