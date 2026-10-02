import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import {
  acquireDistLock,
  distLockPath,
  releaseOnProcessExit,
  type DistLockHandle,
} from "../../vitest.distLock.ts";

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
        warn: () => {},
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

describe("acquireDistLock waiting notice", () => {
  // Covers: #1159 A2
  it("warns once with path and owner across several polls, then keeps waiting", async () => {
    const root = packageRoot();
    handles.push(await acquireDistLock({ packageRoot: root }));

    let clock = 0;
    const messages: string[] = [];
    await expect(
      acquireDistLock({
        packageRoot: root,
        waitMs: 1000,
        pollMs: 0,
        now: () => clock,
        sleep: async () => {
          clock += 300;
        },
        warn: (message) => messages.push(message),
      }),
    ).rejects.toThrow("timed out waiting");

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(distLockPath(root));
    expect(messages[0]).toContain(`Current owner: ${root}`);
    expect(messages[0]).toContain("Do not remove it while a Vitest suite");
  });
});

describe("releaseOnProcessExit", () => {
  // Covers: #1159 A1
  it("releases the lock on exit and disarm removes the listener", async () => {
    const root = packageRoot();
    const handle = await acquireDistLock({ packageRoot: root });
    handles.push(handle);
    const target = new EventEmitter();
    const disarm = releaseOnProcessExit(handle, target);
    expect(target.listenerCount("exit")).toBe(1);
    disarm();
    expect(target.listenerCount("exit")).toBe(0);

    releaseOnProcessExit(handle, target);
    target.emit("exit");
    expect(existsSync(distLockPath(root))).toBe(false);
  });

  // Covers: #1159 A1
  it("leaves a lock now owned by someone else intact", async () => {
    const root = packageRoot();
    const handle = await acquireDistLock({ packageRoot: root });
    handles.push(handle);
    const target = new EventEmitter();
    releaseOnProcessExit(handle, target);
    writeFileSync(
      join(distLockPath(root), "owner.json"),
      JSON.stringify({ token: "other", packageRoot: root }),
    );

    target.emit("exit");
    expect(existsSync(distLockPath(root))).toBe(true);
    rmSync(distLockPath(root), { recursive: true, force: true });
  });

  // Covers: #1159 A1
  it("frees the lock when a Vitest-style SIGINT handler calls process.exit()", async () => {
    const root = packageRoot();
    const script = join(mkdtempSync(join(tmpdir(), "navori-dist-lock-child-")), "child.ts");
    const lockModule = fileURLToPath(new URL("../../vitest.distLock.ts", import.meta.url));
    writeFileSync(
      script,
      `import { acquireDistLock, releaseOnProcessExit } from ${JSON.stringify(lockModule)};
const lock = await acquireDistLock({ packageRoot: ${JSON.stringify(root)} });
releaseOnProcessExit(lock);
process.once("SIGINT", () => setTimeout(() => process.exit(), 1));
process.stdout.write("ready\\n");
setInterval(() => {}, 1000);
`,
    );
    const child = spawn("bun", [script], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((ready, fail) => {
      child.once("error", fail);
      child.stdout.once("data", () => ready());
    });
    expect(existsSync(distLockPath(root))).toBe(true);
    const closed = new Promise<void>((done) => child.once("close", () => done()));
    child.kill("SIGINT");
    await closed;
    expect(existsSync(distLockPath(root))).toBe(false);
  });
});
