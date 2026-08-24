import { assert, describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeConfig } from "../../lib/config.ts";
import { runRender, renderRepoRows, rollupRenderRows } from "../render.ts";

/**
 * #340: a repo with a corrupt `navori.config.json` must fail as ONE row, not
 * abort the batch. `runRender` used to read the config through
 * `readConfigOrExit`, which calls `process.exit(1)` — that doesn't throw, so
 * `renderRepoRows`' own try/catch never saw it and every repo after the broken
 * one was silently skipped (the exact operation this breaks: the mass rollout
 * after a version bump).
 *
 * Against the pre-fix code all three fail inside `readConfigOrExit`, at the
 * `process.exit(1)` that swallowed the batch.
 */
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "navori-render-batch-corrupt-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A repo whose config renders cleanly. */
function seedValidRepo(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeConfig(join(dir, "navori.config.json"), {
    name,
    engines: ["claude"],
    preset: "custom",
    qualityGate: { fast: "pnpm lint", full: "pnpm test" },
  });
  return dir;
}

/** A repo whose config exists but can't be parsed or validated. */
function seedCorruptRepo(name: string, contents: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "navori.config.json"), contents, "utf-8");
  return dir;
}

describe("batch render survives a corrupt config (#340)", () => {
  it("renders the other repos when one has invalid JSON", () => {
    const repos = [
      { name: "a", path: seedValidRepo("a") },
      { name: "b", path: seedCorruptRepo("b", '{ "name": "b", ') },
      { name: "c", path: seedValidRepo("c") },
    ];

    const rows = renderRepoRows(repos, { preview: true, force: false });

    expect(rows).toHaveLength(3);
    const [rowA, rowB, rowC] = rows;
    assert.isDefined(rowA);
    assert.isDefined(rowB);
    assert.isDefined(rowC);
    expect(rowB.status).toBe("error");
    // The message must name the problem, not dump a raw stack trace.
    expect(rowB.detail).toMatch(/invalid json/i);
    expect(rowA.status).not.toBe("error");
    expect(rowC.status).not.toBe("error");
    expect(rollupRenderRows(rows).failed).toBe(1);
  });

  it("renders the other repos when one fails schema validation", () => {
    const repos = [
      { name: "a", path: seedValidRepo("a") },
      // Parses as JSON, but `engines` must be an array of known engine ids.
      { name: "b", path: seedCorruptRepo("b", '{ "name": "b", "engines": "claude" }') },
      { name: "c", path: seedValidRepo("c") },
    ];

    const rows = renderRepoRows(repos, { preview: true, force: false });

    expect(rows).toHaveLength(3);
    const rowB = rows[1];
    assert.isDefined(rowB);
    expect(rowB.status).toBe("error");
    expect(rowB.detail).toMatch(/validation failed/i);
    // The per-field detail survives into the row, as `doctor` already reports it.
    expect(rowB.detail).toContain("engines");
    // …but on a single line, or it spills down the multi-repo table.
    expect(rowB.detail).not.toContain("\n");
    expect(rollupRenderRows(rows).ok).toBe(2);
  });

  it("reports config-invalid as a result instead of exiting the process", () => {
    const dir = seedCorruptRepo("solo", "not json at all");

    const result = runRender(dir, { dryRun: true });

    expect(result.ok).toBe(false);
    expect(result.reasonCode).toBe("config-invalid");
    expect(result.entries).toEqual([]);
  });
});
