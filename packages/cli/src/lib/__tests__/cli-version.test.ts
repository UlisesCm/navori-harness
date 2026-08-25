import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readCliVersion } from "../bundled-assets.ts";

/**
 * #488 — `audit` stamped every report `navori@0.0.0`.
 *
 * Four copies of "read my own version" had drifted apart, and the one `audit`
 * used read `process.env.npm_package_version`, which only exists under an
 * npm/pnpm script. Run as a binary — the way it always runs in production —
 * the variable is absent and the fallback fired 100% of the time.
 *
 * These guard the two halves: the canonical reader works, and no caller
 * reintroduces the env-var shortcut.
 */

describe("readCliVersion", () => {
  it("resolves the real CLI version, never the 0.0.0 fallback", () => {
    const version = readCliVersion();
    expect(version).not.toBe("0.0.0");
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("version reading has a single source", () => {
  /**
   * The guards below pass on an empty grep result — which is also what a
   * BROKEN grep returns (wrong cwd, missing binary). Without this, all of them
   * would go green while checking nothing, the exact failure mode that let
   * #486's empty-prompt bug survive 70 tests.
   */
  it("the grep guard actually finds things (anti-false-green)", () => {
    expect(grepSrc("readCliVersion")).not.toBe("");
  });

  it("no source file reads npm_package_version", () => {
    // A binary never has it set; reaching for it is always the bug of #488.
    const hits = grepSrc("npm_package_version");
    expect(hits, `npm_package_version is only set under npm scripts:\n${hits}`).toBe("");
  });

  it("no command re-declares its own readVersion helper", () => {
    // The copies drifted; `readCliVersion` is the one that validates
    // `name === "navori"`, which matters in a monorepo where ../package.json
    // can be the workspace root rather than the CLI's.
    const hits = grepSrc("function readVersion");
    expect(hits, `use readCliVersion() from lib/bundled-assets.ts instead:\n${hits}`).toBe("");
  });
});

/**
 * grep over src/, excluding this file. Empty string when there are no hits.
 *
 * `fileURLToPath`, never `url.pathname`: the latter stays percent-encoded, so
 * a checkout under a path with spaces ("Dev - Docs") yields "Dev%20-%20Docs",
 * grep fails on the missing directory, and the catch below reports it as "no
 * hits" — every guard green while checking nothing.
 *
 * Only exit code 1 (no match) is a legitimate empty result. Anything else is
 * a broken guard and must throw rather than pass silently.
 */
function grepSrc(pattern: string): string {
  const cwd = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  try {
    return execFileSync(
      "grep",
      ["-rn", "--include=*.ts", "-F", pattern, "src", "--exclude", "cli-version.test.ts"],
      { encoding: "utf-8", cwd },
    ).trim();
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 1) return "";
    throw new Error(`grep guard failed in ${cwd} (exit ${status}) — the check did not run`);
  }
}
