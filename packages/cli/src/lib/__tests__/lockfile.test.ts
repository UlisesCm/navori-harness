import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, openSync, closeSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLock, LockTimeoutError } from "../lockfile.ts";

let dir: string;
let lockPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "navori-lock-"));
  lockPath = join(dir, "test.lock");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("withFileLock", () => {
  it("runs the function, returns its value, and releases the lock", () => {
    const result = withFileLock(lockPath, () => 42);
    expect(result).toBe(42);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("releases the lock even when the function throws", () => {
    expect(() =>
      withFileLock(lockPath, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("can re-acquire after a previous holder released", () => {
    withFileLock(lockPath, () => "first");
    const second = withFileLock(lockPath, () => "second");
    expect(second).toBe("second");
  });

  it("times out when a fresh lock is already held", () => {
    const fd = openSync(lockPath, "wx"); // hold the lock, fresh mtime
    try {
      expect(() =>
        withFileLock(lockPath, () => "never", { timeoutMs: 100, staleMs: 60_000 }),
      ).toThrow(LockTimeoutError);
    } finally {
      closeSync(fd);
      rmSync(lockPath, { force: true });
    }
  });

  it("steals a stale lock (holder died) and runs", () => {
    const fd = openSync(lockPath, "wx");
    closeSync(fd);
    // Backdate the lock's mtime well past the stale threshold.
    const past = new Date(Date.now() - 120_000);
    utimesSync(lockPath, past, past);

    const result = withFileLock(lockPath, () => "recovered", { timeoutMs: 500, staleMs: 30_000 });
    expect(result).toBe("recovered");
    expect(existsSync(lockPath)).toBe(false);
  });
});
