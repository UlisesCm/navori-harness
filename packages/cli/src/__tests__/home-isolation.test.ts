import { describe, it, expect, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { backupRoot } from "../lib/backup.ts";
import {
  type HomeSnapshot,
  UNWATCHED_FINGERPRINT,
  describeNavoriHomeLeak,
  realNavoriHome,
  snapshotNavoriHome,
} from "../../vitest.homeGuard.ts";

/**
 * #404 — the suite used to write ~1,200 fixture backups into the developer's
 * real `~/.navori/backups` and then `purgeOldBackups()` deleted from it. The
 * backup store has an env override (`NAVORI_BACKUP_ROOT`, installed by
 * `vitest.globalSetup.ts` + `vitest.setup.ts`); nothing else under `~/.navori`
 * does, so #424 widened the guard to the whole root. These specs cover the guard
 * that catches the day someone forgets a mock.
 */
describe("suite backup isolation (#404)", () => {
  it("resolves the backup store outside the real ~/.navori", () => {
    const root = backupRoot();
    expect(process.env.NAVORI_BACKUP_ROOT).toBeTruthy();
    expect(root).toBe(process.env.NAVORI_BACKUP_ROOT);
    expect(root.startsWith(join(homedir(), ".navori"))).toBe(false);
  });
});

/** Build a snapshot from plain entries, so the diff specs don't need a real FS. */
function snapshotOf(entries: Record<string, string>): HomeSnapshot {
  return new Map(Object.entries(entries));
}

describe("realNavoriHome", () => {
  it("points at the real ~/.navori root, not at a subdirectory", () => {
    expect(realNavoriHome()).toBe(join(homedir(), ".navori"));
  });
});

describe("snapshotNavoriHome", () => {
  it("returns null when there is no root to guard", () => {
    expect(snapshotNavoriHome(null)).toBeNull();
  });

  it("treats a missing root as empty, without creating it", () => {
    const missing = join(tmpdir(), `navori-guard-missing-${process.pid}`);
    expect(snapshotNavoriHome(missing)).toEqual(new Map());
    expect(existsSync(missing)).toBe(false);
  });

  it("lists every level, capping only backups/", () => {
    const root = mkdtempSync(join(tmpdir(), "navori-guard-"));
    try {
      mkdirSync(join(root, "backups", "repo-a-2026-1", "harness"), { recursive: true });
      mkdirSync(join(root, "workspaces", "bonum", "dominio"), { recursive: true });
      mkdirSync(join(root, "workspaces", "bonum", "tickets", "_archive"), { recursive: true });
      writeFileSync(join(root, "registry.json"), "{}");
      writeFileSync(join(root, "workspaces", "bonum", "workspace.json"), "{}"); // depth 3
      writeFileSync(join(root, "workspaces", "bonum", "dominio", "DOMINIO.md"), "#"); // depth 4
      writeFileSync(join(root, "workspaces", "bonum", "tickets", "_archive", "T-1.md"), "#"); // 5
      // Under backups/ the walk stops at the entry: a snapshot holds thousands
      // of files below it and none of them add signal.
      writeFileSync(join(root, "backups", "repo-a-2026-1", "manifest.json"), "{}");

      const snapshot = snapshotNavoriHome(root);
      expect([...(snapshot as HomeSnapshot).keys()].sort()).toEqual([
        "backups",
        "backups/repo-a-2026-1",
        "registry.json",
        "workspaces",
        "workspaces/bonum",
        "workspaces/bonum/dominio",
        "workspaces/bonum/dominio/DOMINIO.md",
        "workspaces/bonum/tickets",
        "workspaces/bonum/tickets/_archive",
        "workspaces/bonum/tickets/_archive/T-1.md",
        "workspaces/bonum/workspace.json",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("catches a deep rewrite inside directories that survived the run", () => {
    const root = mkdtempSync(join(tmpdir(), "navori-guard-"));
    try {
      // The shape a used workspace leaves: its directories persist between runs,
      // so a leaking spec creates nothing at the top — the only real writes land
      // several levels down (the manifest at 3, the dominio index and its
      // hand-written entries at 4). Under a depth ceiling the before/after
      // listings come out identical and the guard says nothing.
      const dominio = join(root, "workspaces", "bonum", "dominio");
      mkdirSync(dominio, { recursive: true });
      writeFileSync(join(root, "workspaces", "bonum", "workspace.json"), '{"repos":[]}');
      writeFileSync(join(dominio, "DOMINIO.md"), "# index");
      writeFileSync(join(dominio, "cohorts.md"), "curated by hand, machine-local");
      const before = snapshotNavoriHome(root) as HomeSnapshot;

      writeFileSync(join(root, "workspaces", "bonum", "workspace.json"), '{"repos":["gone"]}');
      writeFileSync(join(dominio, "DOMINIO.md"), "# index, rewritten in place");
      rmSync(join(dominio, "cohorts.md"));
      const after = snapshotNavoriHome(root) as HomeSnapshot;

      const leak = describeNavoriHomeLeak(root, before, after);
      expect(leak).toContain("MODIFIED 2 entries");
      expect(leak).toContain("workspaces/bonum/workspace.json");
      expect(leak).toContain("workspaces/bonum/dominio/DOMINIO.md");
      expect(leak).toContain("DELETED 1 entry");
      expect(leak).toContain("workspaces/bonum/dominio/cohorts.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stops watching a subtree over the entry budget, loudly", () => {
    const root = mkdtempSync(join(tmpdir(), "navori-guard-"));
    const warnings: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string) => {
      warnings.push(chunk);
      return true;
    }) as never);
    try {
      mkdirSync(join(root, "huge", "nested"), { recursive: true });
      for (let i = 0; i < 5; i++) writeFileSync(join(root, "huge", `f${i}.md`), "x");
      mkdirSync(join(root, "workspaces", "bonum"), { recursive: true });

      const snapshot = snapshotNavoriHome(root, 3) as HomeSnapshot;

      // The runaway subtree is dropped, not half-listed: a listing truncated at
      // an arbitrary entry would fake a diff against the next snapshot.
      expect(snapshot.get("huge")).toBe(UNWATCHED_FINGERPRINT);
      expect([...snapshot.keys()].filter((key) => key.startsWith("huge/"))).toEqual([]);
      // The rest of the root keeps its coverage.
      expect(snapshot.get("workspaces/bonum")).toBe("dir");
      expect(warnings.join("")).toContain("'huge/'");
      expect(warnings.join("")).toContain("NO LONGER WATCHED");
    } finally {
      stderr.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores .DS_Store, which Finder can touch mid-run", () => {
    const root = mkdtempSync(join(tmpdir(), "navori-guard-"));
    try {
      writeFileSync(join(root, ".DS_Store"), "finder");
      mkdirSync(join(root, "workspaces"));
      writeFileSync(join(root, "workspaces", ".DS_Store"), "finder");
      expect([...(snapshotNavoriHome(root) as HomeSnapshot).keys()]).toEqual(["workspaces"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fingerprints files by size and mtime, so an in-place rewrite is visible", () => {
    const root = mkdtempSync(join(tmpdir(), "navori-guard-"));
    try {
      const registry = join(root, "registry.json");
      writeFileSync(registry, '{"repos":[]}');
      const before = snapshotNavoriHome(root) as HomeSnapshot;

      // Same byte length: only the mtime betrays the rewrite.
      writeFileSync(registry, '{"repos":[1]}'.slice(0, 12));
      utimesSync(registry, new Date(0), new Date(0));
      const after = snapshotNavoriHome(root) as HomeSnapshot;

      expect(after.get("registry.json")).not.toBe(before.get("registry.json"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("describeNavoriHomeLeak", () => {
  const root = "/home/dev/.navori";

  it("stays silent when the run left the real root untouched", () => {
    const entries = { "backups/a": "dir", "registry.json": "10:1" };
    expect(describeNavoriHomeLeak(root, snapshotOf(entries), snapshotOf(entries))).toBeNull();
    expect(describeNavoriHomeLeak(root, new Map(), new Map())).toBeNull();
  });

  it("names the entries a leaking run created", () => {
    const leak = describeNavoriHomeLeak(
      root,
      snapshotOf({ "backups/mine-1": "dir" }),
      snapshotOf({ "backups/mine-1": "dir", "backups/navori-engine-Xy7-2026-1-0": "dir" }),
    );
    expect(leak).toContain(root);
    expect(leak).toContain("Created 1 entry");
    expect(leak).toContain("backups/navori-engine-Xy7-2026-1-0");
    expect(leak).not.toContain("backups/mine-1"); // an untouched entry is never reported
  });

  it("reports entries a run DELETED — the .trash flow removes for real", () => {
    const leak = describeNavoriHomeLeak(
      root,
      snapshotOf({ "workspaces/precious": "dir", "workspaces/kept": "dir" }),
      snapshotOf({ "workspaces/kept": "dir" }),
    );
    expect(leak).toContain("DELETED 1 entry");
    expect(leak).toContain("workspaces/precious");
  });

  it("reports a file rewritten in place, which adds no entry", () => {
    const leak = describeNavoriHomeLeak(
      root,
      snapshotOf({ "registry.json": "2717:100" }),
      snapshotOf({ "registry.json": "31:200" }),
    );
    expect(leak).toContain("MODIFIED 1 entry");
    expect(leak).toContain("registry.json");
  });

  it("caps a long list instead of dumping hundreds of lines", () => {
    const after = Object.fromEntries(
      Array.from({ length: 25 }, (_, i) => [`backups/leaked-${String(i).padStart(2, "0")}`, "dir"]),
    );
    const leak = describeNavoriHomeLeak(root, new Map(), snapshotOf(after));
    expect(leak).toContain("Created 25 entries");
    expect(leak).toContain("backups/leaked-19");
    expect(leak).not.toContain("backups/leaked-20");
    expect(leak).toContain("…and 5 more");
  });

  it("compares an unwatched subtree in neither snapshot, but still sees it vanish", () => {
    const watched = snapshotOf({ backups: "dir", "backups/a": "dir", workspaces: "dir" });
    const dropped = snapshotOf({ backups: UNWATCHED_FINGERPRINT, workspaces: "dir" });

    // Crossing the entry budget between the two listings is not a diff: the
    // contents are unknown on one side, so they are ignored on both.
    expect(describeNavoriHomeLeak(root, watched, dropped)).toBeNull();
    expect(describeNavoriHomeLeak(root, dropped, watched)).toBeNull();

    // Losing the subtree itself is still reported — only its contents go unwatched.
    const gone = describeNavoriHomeLeak(root, dropped, snapshotOf({ workspaces: "dir" }));
    expect(gone).toContain("DELETED 1 entry");
    expect(gone).toContain("backups");
  });

  it("skips the comparison when a snapshot could not be read", () => {
    expect(describeNavoriHomeLeak(root, null, snapshotOf({ a: "dir" }))).toBeNull();
    expect(describeNavoriHomeLeak(root, snapshotOf({ a: "dir" }), null)).toBeNull();
  });
});
