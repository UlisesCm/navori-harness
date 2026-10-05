import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTempFile, createTempRun } from "../../vitest.tempLifecycle.ts";

describe("owned test temporaries", () => {
  it("routes fixtures, HOME, backups and Node/Bun children, then restores environment", async () => {
    const original = {
      TMPDIR: process.env.TMPDIR,
      TMP: process.env.TMP,
      TEMP: process.env.TEMP,
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      NAVORI_BACKUP_ROOT: process.env.NAVORI_BACKUP_ROOT,
    };
    const run = createTempRun();
    const file = createTempFile(run.root);
    const fixture = mkdtempSync(join(tmpdir(), "fixture-"));
    writeFileSync(join(fixture, "data"), "x");
    expect(homedir()).toBe(file.home);
    expect(file.home.startsWith(tmpdir())).toBe(true);
    expect(process.env.NAVORI_BACKUP_ROOT).toBe(join(file.root, "backups"));
    for (const executable of ["node", "bun"]) {
      const result = spawnSync(
        executable,
        ["-e", "process.stdout.write(require('node:os').tmpdir())"],
        { encoding: "utf8" },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(file.root);
    }
    await file.dispose();
    expect(existsSync(fixture)).toBe(false);
    for (const [key, value] of Object.entries(original)) expect(process.env[key]).toBe(value);
    run.dispose();
    expect(existsSync(run.root)).toBe(false);
  });

  it("never removes another run or caller-owned sibling", async () => {
    const a = createTempRun();
    const b = createTempRun();
    const file = createTempFile(a.root);
    writeFileSync(join(b.root, "sentinel"), "caller");
    await file.dispose();
    a.dispose();
    expect(existsSync(join(b.root, "sentinel"))).toBe(true);
    rmSync(join(b.root, "sentinel"));
    b.dispose();
  });

  it("retains exact HOME evidence without retaining unrelated completed files", async () => {
    const run = createTempRun();
    const file = createTempFile(run.root);
    writeFileSync(join(file.home, "evidence"), "inspect");
    await file.dispose("HOME isolation evidence");
    const completed = createTempFile(run.root);
    await completed.dispose();
    run.dispose();
    expect(existsSync(join(file.home, "evidence"))).toBe(true);
    expect(existsSync(completed.root)).toBe(false);
    rmSync(run.root, { recursive: true, force: true });
  });

  it("retains exact evidence and restores environment if the final check fails", async () => {
    const original = process.env.TMPDIR;
    const run = createTempRun();
    const file = createTempFile(run.root);
    try {
      await expect(
        file.dispose(() => {
          throw new Error("final evidence check failed");
        }),
      ).rejects.toThrow("final evidence check failed");
      expect(existsSync(file.root)).toBe(true);
      expect(process.env.TMPDIR).toBe(original);
      run.dispose();
      expect(existsSync(run.root)).toBe(true);
    } finally {
      rmSync(run.root, { recursive: true, force: true });
    }
  });

  it("retains a file root under a live direct child and observes actual channel events", async () => {
    const run = createTempRun();
    const file = createTempFile(run.root);
    const child = spawn(
      process.execPath,
      ["-e", "process.stdout.write('ready'); setInterval(() => {},1000)"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const closed = new Promise<void>((done) => child.once("close", () => done()));
    try {
      await new Promise<void>((ready, fail) => {
        child.once("error", fail);
        child.stdout.once("data", () => ready());
      });
      let checked = false;
      await file.dispose(() => {
        checked = true;
        return undefined;
      });
      expect(checked).toBe(false);
      expect(existsSync(file.root)).toBe(true);
      run.dispose();
      expect(existsSync(run.root)).toBe(true);
    } finally {
      child.kill();
      await closed;
      rmSync(run.root, { recursive: true, force: true });
    }
  });
});
