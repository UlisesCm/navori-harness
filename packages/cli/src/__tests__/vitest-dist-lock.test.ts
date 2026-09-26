import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireDistLock, distLockPath, type DistLockHandle } from "../../vitest.distLock.ts";

const handles: DistLockHandle[] = [];

afterEach(() => {
  while (handles.length > 0) handles.pop()?.release();
});

function packageRoot(): string {
  return mkdtempSync(join(tmpdir(), "navori-dist-lock-test-"));
}

describe("acquireDistLock", () => {
  it("serializes one checkout and releases only the matching owner", async () => {
    const root = packageRoot();
    const first = await acquireDistLock({ packageRoot: root });
    handles.push(first);

    let clock = 0;
    await expect(
      acquireDistLock({
        packageRoot: root,
        waitMs: 1,
        pollMs: 0,
        now: () => clock,
        sleep: async () => {
          clock = 6 * 60 * 1000;
        },
      }),
    ).rejects.toThrow("Do not remove it while a Vitest suite for this checkout is active");

    // A six-minute live holder remains intact: elapsed time is never evidence
    // that another suite may reclaim the lock.
    expect(() => first.release()).not.toThrow();
    handles.pop();
    const second = await acquireDistLock({ packageRoot: root, waitMs: 1 });
    handles.push(second);
  });

  it("removes a partial lock when writing its owner record fails", async () => {
    const root = packageRoot();
    const path = distLockPath(root);
    await expect(
      acquireDistLock({
        packageRoot: root,
        fileSystem: {
          mkdir: (target) => mkdirSync(target),
          writeFile: () => {
            throw new Error("owner write failed");
          },
          remove: (target) => rmSync(target, { recursive: true, force: true }),
          readFile: (target) => readFileSync(target, "utf-8"),
        },
      }),
    ).rejects.toThrow("owner write failed");

    expect(existsSync(path)).toBe(false);
    const replacement = await acquireDistLock({ packageRoot: root });
    handles.push(replacement);
  });

  it("uses a different lock for each checkout", () => {
    expect(distLockPath("/tmp/navori-a")).not.toBe(distLockPath("/tmp/navori-b"));
  });
});
