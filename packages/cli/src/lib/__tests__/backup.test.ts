import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

// Isolate ~/.navori to a throwaway home so backups never touch the real home
// dir and can't race other test files that also write to ~/.navori/backups.
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("../home.ts", () => ({ safeHomedir: () => home.dir }));

const { createBackup, backupRepoLabel, backupIdRepoLabel, purgeOldBackups } = await import(
  "../backup.ts"
);

let repo: string;

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "backup-home-"));
  repo = mkdtempSync(join(tmpdir(), "backup-test-"));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(home.dir, { recursive: true, force: true });
});

describe("createBackup — file inputs (back-compat)", () => {
  it("copies individual existing files preserving repo-relative paths", () => {
    writeFileSync(join(repo, "CLAUDE.md"), "claude content");
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src/foo.ts"), "ts content");

    const handle = createBackup(repo, ["CLAUDE.md", "src/foo.ts"]);
    expect(handle.files).toEqual(["CLAUDE.md", "src/foo.ts"]);
    expect(readFileSync(join(handle.path, "CLAUDE.md"), "utf-8")).toBe("claude content");
    expect(readFileSync(join(handle.path, "src/foo.ts"), "utf-8")).toBe("ts content");

    rmSync(handle.path, { recursive: true });
  });

  it("silently skips files that don't exist", () => {
    writeFileSync(join(repo, "CLAUDE.md"), "x");
    const handle = createBackup(repo, ["CLAUDE.md", "missing.md"]);
    expect(handle.files).toEqual(["CLAUDE.md"]);
    rmSync(handle.path, { recursive: true });
  });
});

describe("createBackup — directory inputs (E3)", () => {
  it("walks a directory recursively", () => {
    mkdirSync(join(repo, ".claude/agents"), { recursive: true });
    mkdirSync(join(repo, ".claude/skills"), { recursive: true });
    writeFileSync(join(repo, ".claude/settings.json"), "{}");
    writeFileSync(join(repo, ".claude/agents/leader.md"), "leader");
    writeFileSync(join(repo, ".claude/skills/verify.md"), "verify");

    const handle = createBackup(repo, [".claude"]);
    expect(handle.files.sort()).toEqual([
      ".claude/agents/leader.md",
      ".claude/settings.json",
      ".claude/skills/verify.md",
    ]);
    expect(readFileSync(join(handle.path, ".claude/agents/leader.md"), "utf-8")).toBe("leader");
    rmSync(handle.path, { recursive: true });
  });

  it("respects `exclude` for file paths", () => {
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(join(repo, ".claude/settings.json"), "{}");
    writeFileSync(join(repo, ".claude/settings.local.json"), '{"private":1}');

    const handle = createBackup(repo, [".claude"], {
      exclude: [".claude/settings.local.json"],
    });
    expect(handle.files).toEqual([".claude/settings.json"]);
    expect(existsSync(join(handle.path, ".claude/settings.local.json"))).toBe(false);
    rmSync(handle.path, { recursive: true });
  });

  it("respects `exclude` for whole subtrees (trailing slash optional)", () => {
    mkdirSync(join(repo, ".claude/progress"), { recursive: true });
    mkdirSync(join(repo, ".claude/agents"), { recursive: true });
    writeFileSync(join(repo, ".claude/progress/current.md"), "live");
    writeFileSync(join(repo, ".claude/progress/history.md"), "log");
    writeFileSync(join(repo, ".claude/agents/leader.md"), "leader");

    const handle = createBackup(repo, [".claude"], {
      exclude: [".claude/progress"],
    });
    expect(handle.files).toEqual([".claude/agents/leader.md"]);
    expect(existsSync(join(handle.path, ".claude/progress"))).toBe(false);
    rmSync(handle.path, { recursive: true });
  });

  // #348: `.claude/worktrees/` is a full repo clone per worktree. Backing it up
  // made every `render --apply` weigh gigabytes until the disk filled and the
  // backup itself failed with ENOSPC. The engine's `backupExclude` must keep the
  // whole subtree out, however deep the tree goes.
  it("keeps `.claude/worktrees` out of a `.claude` backup, at any depth", () => {
    mkdirSync(join(repo, ".claude/worktrees/feat-x/src"), { recursive: true });
    mkdirSync(join(repo, ".claude/agents"), { recursive: true });
    writeFileSync(join(repo, ".claude/worktrees/feat-x/src/big.ts"), "huge clone");
    writeFileSync(join(repo, ".claude/worktrees/feat-x/CLAUDE.md"), "clone root");
    writeFileSync(join(repo, ".claude/agents/leader.md"), "leader");

    const handle = createBackup(repo, [".claude"], {
      exclude: [".claude/settings.local.json", ".claude/worktrees/", ".claude/progress/"],
    });
    expect(handle.files).toEqual([".claude/agents/leader.md"]);
    expect(existsSync(join(handle.path, ".claude/worktrees"))).toBe(false);
    rmSync(handle.path, { recursive: true });
  });

  it("mixes files and directories in one call", () => {
    writeFileSync(join(repo, "CLAUDE.md"), "claude");
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(join(repo, ".claude/settings.json"), "{}");

    const handle = createBackup(repo, ["CLAUDE.md", ".claude"]);
    expect(handle.files.sort()).toEqual([".claude/settings.json", "CLAUDE.md"]);
    rmSync(handle.path, { recursive: true });
  });
});

describe("createBackup — repo identity + collision resistance (#82)", () => {
  it("names the backup dir with the repo label and round-trips it back", () => {
    writeFileSync(join(repo, "CLAUDE.md"), "x");
    const handle = createBackup(repo, ["CLAUDE.md"]);
    try {
      const dirName = basename(handle.path);
      const label = backupRepoLabel(repo);
      expect(dirName.startsWith(`${label}-`)).toBe(true);
      expect(backupIdRepoLabel(dirName)).toBe(label);
    } finally {
      rmSync(handle.path, { recursive: true, force: true });
    }
  });

  it("two backups of the same repo never share a directory", () => {
    writeFileSync(join(repo, "CLAUDE.md"), "x");
    const a = createBackup(repo, ["CLAUDE.md"]);
    const b = createBackup(repo, ["CLAUDE.md"]);
    try {
      expect(a.path).not.toBe(b.path); // per-process seq disambiguates same-ms calls
    } finally {
      rmSync(a.path, { recursive: true, force: true });
      rmSync(b.path, { recursive: true, force: true });
    }
  });

  it("distinct repos get distinct, self-identifying backup dirs", () => {
    const other = mkdtempSync(join(tmpdir(), "backup-test-other-"));
    writeFileSync(join(repo, "CLAUDE.md"), "x");
    writeFileSync(join(other, "CLAUDE.md"), "y");
    const a = createBackup(repo, ["CLAUDE.md"]);
    const b = createBackup(other, ["CLAUDE.md"]);
    try {
      expect(backupIdRepoLabel(basename(a.path))).toBe(backupRepoLabel(repo));
      expect(backupIdRepoLabel(basename(b.path))).toBe(backupRepoLabel(other));
      expect(basename(a.path)).not.toBe(basename(b.path));
    } finally {
      rmSync(a.path, { recursive: true, force: true });
      rmSync(b.path, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("backupIdRepoLabel returns null for a legacy timestamp-only id", () => {
    expect(backupIdRepoLabel("2026-07-14T12-00-00")).toBeNull();
  });
});

// #393: age alone never bounds the footprint — a busy repo can pile up
// gigabytes of sub-30-day backups. Size is the second criterion, oldest-first.
describe("purgeOldBackups — retention + size cap (#393)", () => {
  /** One backup with a payload of `bytes` bytes, its dir mtime `ageDays` old. */
  function makeBackup(bytes: number, ageDays: number): string {
    writeFileSync(join(repo, "CLAUDE.md"), "x".repeat(bytes));
    const handle = createBackup(repo, ["CLAUDE.md"]);
    const when = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
    utimesSync(handle.path, when, when);
    return handle.path;
  }

  it("still prunes by age first (default 30 days)", () => {
    const old = makeBackup(10, 40);
    const fresh = makeBackup(10, 1);
    const pruned = purgeOldBackups();
    expect(pruned).toEqual([old]);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it("deletes oldest-first until the total is under maxTotalBytes", () => {
    const oldest = makeBackup(1000, 3);
    const middle = makeBackup(1000, 2);
    const newest = makeBackup(1000, 1);
    // total 3000 > cap 1500: drop oldest (2000, still over), then middle (1000, under)
    const pruned = purgeOldBackups({ maxTotalBytes: 1500 });
    expect(pruned.sort()).toEqual([middle, oldest].sort());
    expect(existsSync(oldest)).toBe(false);
    expect(existsSync(middle)).toBe(false);
    expect(existsSync(newest)).toBe(true);
  });

  it("leaves everything in place when the total sits under the cap", () => {
    const a = makeBackup(100, 2);
    const b = makeBackup(100, 1);
    expect(purgeOldBackups({ maxTotalBytes: 10_000 })).toEqual([]);
    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(true);
  });

  it("applies both criteria in one call: age pass, then size pass", () => {
    const expired = makeBackup(10, 40);
    const heavyOld = makeBackup(1000, 5);
    const light = makeBackup(100, 1);
    const pruned = purgeOldBackups({ maxTotalBytes: 500 });
    expect(pruned.sort()).toEqual([expired, heavyOld].sort());
    expect(existsSync(light)).toBe(true);
  });
});
