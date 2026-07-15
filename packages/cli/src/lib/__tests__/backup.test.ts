import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

// Isolate ~/.navori to a throwaway home so backups never touch the real home
// dir and can't race other test files that also write to ~/.navori/backups.
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("../home.ts", () => ({ safeHomedir: () => home.dir }));

const { createBackup, backupRepoLabel, backupIdRepoLabel } = await import("../backup.ts");

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
