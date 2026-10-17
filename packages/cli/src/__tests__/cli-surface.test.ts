import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GOLDEN_PATH, parseSubcommands, runSurface } from "../../scripts/capture-cli-surface.mjs";

/**
 * Spec 0055 R15 — the CLI surface (`--version`, `--help`, `<sub> --help`, unknown command)
 * stays byte-identical to the golden captured from the base `dist/`.
 */

interface SurfaceCase {
  args: string[];
  status: number;
  stdout: string;
  stderr: string;
}

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "index.js");
const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as { cases: SurfaceCase[] };

describe("cli surface", () => {
  // Covers: R15
  it("la superficie del CLI coincide con el golden de la base", () => {
    const home = mkdtempSync(join(tmpdir(), "navori-cli-surface-"));
    try {
      const mismatches: string[] = [];
      for (const expected of golden.cases) {
        const actual = runSurface(dist, expected.args, home);
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          mismatches.push(`navori ${expected.args.join(" ")}`);
        }
      }
      expect(mismatches, "commands whose surface differs from the base golden").toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // Covers: R15
  it("el golden cubre version, help raiz, cada subcomando y un comando desconocido", () => {
    const root = golden.cases.find((c) => c.args.join(" ") === "--help");
    expect(root).toBeDefined();
    const subs = parseSubcommands(root?.stdout ?? "");
    expect(subs.length).toBeGreaterThan(20);
    expect(golden.cases.map((c) => c.args.join(" "))).toEqual([
      "--version",
      "--help",
      ...subs.map((sub) => `${sub} --help`),
      "no-such-command",
    ]);
    expect(golden.cases.at(-1)?.status).not.toBe(0);
  });
});
