import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * #967 — `hasBinary` used to only check `existsSync` + `isFile()`, so a file
 * present in PATH but without the executable bit was declared "installed".
 * These tests pin the regression this fixes: an unreadable/non-executable
 * candidate must return `false`.
 *
 * Fixtures live under a throwaway `mkdtempSync(tmpdir())` dir, never under
 * the real home or the repo, and `PATH` is pointed there for the duration
 * of each test.
 */

const { hasBinary } = await import("../which.ts");

let dir: string;
let originalPath: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "navori-which-"));
  originalPath = process.env.PATH;
  process.env.PATH = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env.PATH = originalPath;
});

describe("hasBinary", () => {
  it("returns true for an executable file in PATH", () => {
    const bin = join(dir, "mytool");
    writeFileSync(bin, "#!/bin/sh\necho hi\n");
    chmodSync(bin, 0o755);

    expect(hasBinary("mytool")).toBe(true);
  });

  it("returns false for a file in PATH without the executable bit (the #967 regression)", () => {
    if (process.platform === "win32") return; // mode has no effect on win32 — see which.ts

    const bin = join(dir, "mytool");
    writeFileSync(bin, "not executable");
    chmodSync(bin, 0o644);

    expect(hasBinary("mytool")).toBe(false);
  });

  it("returns false when the candidate is a directory, not a file", () => {
    mkdirSync(join(dir, "mytool"));

    expect(hasBinary("mytool")).toBe(false);
  });

  it("returns false for a dangling symlink", () => {
    symlinkSync(join(dir, "does-not-exist"), join(dir, "mytool"));

    expect(hasBinary("mytool")).toBe(false);
  });

  it("returns false when the binary is absent from PATH", () => {
    expect(hasBinary("does-not-exist-anywhere")).toBe(false);
  });

  it("returns false when PATH is empty", () => {
    process.env.PATH = "";
    expect(hasBinary("does-not-exist-anywhere")).toBe(false);
  });
});
