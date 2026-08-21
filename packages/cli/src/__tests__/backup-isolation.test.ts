import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { backupRoot } from "../lib/backup.ts";
import { describeBackupLeak, listBackupEntries } from "../../vitest.globalSetup.ts";

/**
 * #404 — the suite used to write ~1,200 fixture backups into the developer's
 * real `~/.navori/backups` and then `purgeOldBackups()` deleted from it. The
 * isolation is env-based (`NAVORI_BACKUP_ROOT`) and installed by
 * `vitest.globalSetup.ts` + `vitest.setup.ts`; these specs cover the guard that
 * catches the day someone reintroduces the leak.
 */
describe("suite backup isolation (#404)", () => {
  it("resolves the backup store outside the real ~/.navori", () => {
    const root = backupRoot();
    expect(process.env.NAVORI_BACKUP_ROOT).toBeTruthy();
    expect(root).toBe(process.env.NAVORI_BACKUP_ROOT);
    expect(root.startsWith(join(homedir(), ".navori"))).toBe(false);
  });
});

describe("listBackupEntries", () => {
  it("returns null when there is no root to guard", () => {
    expect(listBackupEntries(null)).toBeNull();
  });

  it("treats a missing directory as an empty store, without creating it", () => {
    const missing = join(tmpdir(), `navori-guard-missing-${process.pid}`);
    expect(listBackupEntries(missing)).toEqual([]);
    expect(existsSync(missing)).toBe(false);
  });

  it("lists the entries of an existing store, sorted", () => {
    const root = mkdtempSync(join(tmpdir(), "navori-guard-"));
    try {
      mkdirSync(join(root, "repo-b"));
      mkdirSync(join(root, "repo-a"));
      writeFileSync(join(root, "stray.txt"), "x");
      expect(listBackupEntries(root)).toEqual(["repo-a", "repo-b", "stray.txt"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("describeBackupLeak", () => {
  const root = "/home/dev/.navori/backups";

  it("stays silent when the run left the real store untouched", () => {
    expect(describeBackupLeak(root, ["a", "b"], ["a", "b"])).toBeNull();
    expect(describeBackupLeak(root, [], [])).toBeNull();
  });

  it("names the fixture entries a leaking run created", () => {
    const leak = describeBackupLeak(root, ["mine-1"], ["mine-1", "navori-engine-Xy7-2026-1-0"]);
    expect(leak).toContain(root);
    expect(leak).toContain("Created 1 entry");
    expect(leak).toContain("navori-engine-Xy7-2026-1-0");
    expect(leak).not.toContain("mine-1"); // an untouched entry is never reported
  });

  it("reports entries a run DELETED from the real store", () => {
    const leak = describeBackupLeak(root, ["precious-2026", "kept"], ["kept"]);
    expect(leak).toContain("DELETED 1 entry");
    expect(leak).toContain("precious-2026");
  });

  it("caps a long list instead of dumping hundreds of lines", () => {
    const before: string[] = [];
    const after = Array.from({ length: 25 }, (_, i) => `leaked-${String(i).padStart(2, "0")}`);
    const leak = describeBackupLeak(root, before, after);
    expect(leak).toContain("Created 25 entries");
    expect(leak).toContain("leaked-19");
    expect(leak).not.toContain("leaked-20");
    expect(leak).toContain("…and 5 more");
  });

  it("skips the comparison when a snapshot could not be read", () => {
    expect(describeBackupLeak(root, null, ["a"])).toBeNull();
    expect(describeBackupLeak(root, ["a"], null)).toBeNull();
  });
});
