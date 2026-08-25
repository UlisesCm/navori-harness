import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * #490 — the unreleased-subcommand guard (`scripts/check-asset-commands.mjs`).
 *
 * An asset that orders `navori <cmd>` resolves the PUBLISHED binary, so a PR
 * landing a subcommand and an asset calling it together ships an asset that is
 * broken until the next release. That is how `audit` shipped in #485, and it
 * failed silently: citty prints help and exits 0 for an unknown subcommand.
 *
 * The contract pinned here is deliberately narrow, because the interesting
 * output CHANGES with every release (once 0.7.0 is out, `audit` stops being
 * unreleased and the warning goes quiet — a test asserting on `audit` would
 * then fail for the right reason at the wrong time).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const SCRIPT = resolve(REPO_ROOT, "scripts", "check-asset-commands.mjs");

function run() {
  return spawnSync("node", [SCRIPT], {
    encoding: "utf-8",
    cwd: REPO_ROOT,
    env: { ...process.env, FORCE_COLOR: "0" },
  });
}

describe("asset subcommand check (#490)", () => {
  it("never blocks the build — a pending release is not a failure", () => {
    // Blocking would invert the order: you'd have to publish before merging.
    expect(run().status).toBe(0);
  });

  it("actually ran, rather than exiting quietly (anti-false-green)", () => {
    const { stdout } = run();
    expect(stdout.trim()).not.toBe("");
    expect(stdout).toMatch(/[✓⚠]/);
  });

  it("reports a file:line for anything it flags", () => {
    const { stdout } = run();
    if (!stdout.includes("⚠ assets cite")) return; // nothing pending: vacuously fine
    // A warning without a location is not actionable.
    expect(stdout).toMatch(/\s{4}\S+\.(md|sh):\d+/);
  });

  it("knows every subcommand the CLI registers", () => {
    // The parser is the load-bearing half: if `subCommands` stops matching, the
    // check silently considers every citation prose and flags nothing.
    const source = readFileSync(resolve(REPO_ROOT, "packages/cli/src/index.ts"), "utf-8");
    const block = source.match(/subCommands:\s*\{([\s\S]*?)\n\s*\},/)?.[1];
    expect(block, "the check's own regex must still match index.ts").toBeTypeOf("string");
    const names = [...(block ?? "").matchAll(/^\s*([a-z][\w-]*)\s*:/gm)].map((m) => m[1]);
    expect(names).toContain("render");
    expect(names).toContain("audit");
    expect(names.length).toBeGreaterThanOrEqual(20);
  });
});
