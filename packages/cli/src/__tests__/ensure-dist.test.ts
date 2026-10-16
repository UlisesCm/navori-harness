import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireDistLock, distLockPath } from "../../vitest.distLock.ts";
import { checkRenderLocked } from "../../scripts/check-render-locked.ts";
import { computeFingerprint, ensureDist } from "../../scripts/ensure-dist.ts";

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function write(root: string, rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

/** A throwaway git repo shaped like the monorepo; returns its `packages/cli`. */
function fixture(): { repo: string; pkg: string } {
  const repo = mkdtempSync(join(tmpdir(), "navori-ensure-dist-"));
  roots.push(repo);
  spawnSync("git", ["init", "-q"], { cwd: repo });
  write(repo, "package.json", "{}");
  write(repo, "bun.lock", "lock");
  write(repo, "packages/cli/package.json", "{}");
  write(repo, "packages/cli/src/a.ts", "export const a = 1;");
  write(repo, "packages/cli/src/__tests__/a.test.ts", "// test");
  write(repo, "packages/core/core-assets/x.md", "x");
  write(repo, "packages/plugins/p/plugin.json", "{}");
  return { repo, pkg: join(repo, "packages/cli") };
}

/** Counting stub for `bun run build`. */
function stubBuild(
  pkg: string,
  side?: () => void,
): { calls: () => number; run: () => { status: number } } {
  let calls = 0;
  return {
    calls: () => calls,
    run: () => {
      calls += 1;
      side?.();
      write(pkg, "dist/index.js", "built");
      return { status: 0 };
    },
  };
}

const V = "test-versions";

describe("ensureDist", () => {
  // Covers: R5
  it("sello igual no compila, entrada cambiada o borrada o sin sello compila", () => {
    const { repo, pkg } = fixture();
    const b = stubBuild(pkg);
    const run = (): { built: boolean; sealed: boolean } =>
      ensureDist({ packageRoot: pkg, lockHeld: true, build: b.run, versions: V });

    expect(run()).toEqual({ built: true, sealed: true });
    expect(readFileSync(join(pkg, "dist/.build-fingerprint"), "utf8").trim()).toBe(
      computeFingerprint(pkg, V),
    );
    // Same inputs: sealed hit, no build.
    expect(run().built).toBe(false);
    expect(b.calls()).toBe(1);

    // A test-only edit is not a build input.
    write(repo, "packages/cli/src/__tests__/a.test.ts", "// changed");
    expect(run().built).toBe(false);

    // Changed inputs rebuild: source, core asset, root lockfile, tool versions.
    write(repo, "packages/cli/src/a.ts", "export const a = 2;");
    expect(run().built).toBe(true);
    write(repo, "packages/core/core-assets/x.md", "y");
    expect(run().built).toBe(true);
    write(repo, "bun.lock", "lock2");
    expect(run().built).toBe(true);
    expect(
      ensureDist({ packageRoot: pkg, lockHeld: true, build: b.run, versions: "other" }).built,
    ).toBe(true);
    expect(run().built).toBe(true); // back to V: different from "other"
    expect(run().built).toBe(false);

    // A deleted input (tracked, so git still lists it) rebuilds and does not crash.
    spawnSync("git", ["add", "-A"], { cwd: repo });
    expect(run().built).toBe(false);
    rmSync(join(repo, "packages/cli/src/a.ts"));
    expect(run().built).toBe(true);
    expect(run().built).toBe(false);

    // No seal: rebuild.
    rmSync(join(pkg, "dist/.build-fingerprint"));
    expect(run().built).toBe(true);
    // No dist/index.js: rebuild even with a seal.
    rmSync(join(pkg, "dist/index.js"));
    expect(run().built).toBe(true);
  });

  // Covers: R5
  it("an edit during the build leaves dist unsealed, and a failed build throws without sealing", () => {
    const { repo, pkg } = fixture();
    const racing = stubBuild(pkg, () =>
      write(repo, "packages/cli/src/a.ts", "export const a = 9;"),
    );
    expect(
      ensureDist({ packageRoot: pkg, lockHeld: true, build: racing.run, versions: V }),
    ).toEqual({ built: true, sealed: false });
    expect(existsSync(join(pkg, "dist/.build-fingerprint"))).toBe(false);

    const failing = (): { status: number } => ({ status: 1 });
    expect(() =>
      ensureDist({ packageRoot: pkg, lockHeld: true, build: failing, versions: V }),
    ).toThrow(/build failed/);
    expect(existsSync(join(pkg, "dist/.build-fingerprint"))).toBe(false);
  });
});

describe("dist lock with ensureDist", () => {
  // Covers: R5
  it("globalSetup no se bloquea a sí mismo y un lock de pid muerto se recupera", async () => {
    const { pkg } = fixture();
    const lock = await acquireDistLock({ packageRoot: pkg, waitMs: 1 });
    try {
      // The holder calls ensureDist; it must return without touching the lock (no 10 min wait).
      const b = stubBuild(pkg);
      expect(
        ensureDist({ packageRoot: pkg, lockHeld: true, build: b.run, versions: V }).built,
      ).toBe(true);
      expect(existsSync(lock.path)).toBe(true);
    } finally {
      lock.release();
    }

    // A SIGKILLed owner: a real pid that has exited answers ESRCH and is reclaimed.
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const deadPid = child.pid as number;
    await new Promise<void>((done) => child.once("exit", () => done()));
    const path = distLockPath(pkg);
    mkdirSync(path);
    writeFileSync(
      join(path, "owner.json"),
      JSON.stringify({ token: "dead", packageRoot: pkg, pid: deadPid, host: hostname() }),
    );
    const reclaimed = await acquireDistLock({ packageRoot: pkg, waitMs: 1 });
    reclaimed.release();

    // A live pid on this host, a foreign host and a legacy owner (no pid) are never reclaimed.
    for (const owner of [
      { token: "live", packageRoot: pkg, pid: process.pid, host: hostname() },
      { token: "far", packageRoot: pkg, pid: deadPid, host: "some-other-host" },
      { token: "legacy", packageRoot: pkg },
    ]) {
      mkdirSync(path);
      writeFileSync(join(path, "owner.json"), JSON.stringify(owner));
      await expect(
        acquireDistLock({ packageRoot: pkg, waitMs: 1, pollMs: 0, warn: () => {} }),
      ).rejects.toThrow(/timed out waiting/);
      rmSync(path, { recursive: true, force: true });
    }
  });
});

describe("checkRenderLocked", () => {
  // Covers: R6
  it("check:render reutiliza dist con sello vigente", async () => {
    const { pkg } = fixture();
    const b = stubBuild(pkg);
    const ensure = (o: Parameters<typeof ensureDist>[0]): ReturnType<typeof ensureDist> =>
      ensureDist({ ...o, build: b.run, versions: V });
    let lockedDuringCheck = false;
    const runCheck = (): number => {
      lockedDuringCheck = existsSync(distLockPath(pkg));
      return 0;
    };

    expect(await checkRenderLocked({ packageRoot: pkg, ensure, runCheck })).toBe(0);
    expect(await checkRenderLocked({ packageRoot: pkg, ensure, runCheck })).toBe(0);
    // Sealed by the first call (or a suite run before it): the second one built nothing.
    expect(b.calls()).toBe(1);
    // dist/ is read under the lock, which is released afterwards.
    expect(lockedDuringCheck).toBe(true);
    expect(existsSync(distLockPath(pkg))).toBe(false);
    // The check's own status propagates.
    expect(await checkRenderLocked({ packageRoot: pkg, ensure, runCheck: () => 3 })).toBe(3);

    // The root script wires the check to this entry point.
    const root = JSON.parse(
      readFileSync(join(import.meta.dirname, "../../../../package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(root.scripts["check:render"]).toContain("scripts/check-render-locked.ts");
  });
});
