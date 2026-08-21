import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate ~/.navori to a throwaway home so the scan never measures the real
// machine-global backups dir (same pattern as backup.test.ts).
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("../home.ts", () => ({ safeHomedir: () => home.dir }));

const { scanDiskUsage, humanBytes } = await import("../disk-usage.ts");

let repo: string;

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "disk-usage-home-"));
  repo = mkdtempSync(join(tmpdir(), "disk-usage-repo-"));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(home.dir, { recursive: true, force: true });
});

// #393: doctor's disk surveillance — report real size + the cleanup command,
// never delete. These cover the scan; the copy lives in i18n.
describe("scanDiskUsage (#393)", () => {
  it("reports nothing when neither directory exists (zero footprint)", () => {
    expect(scanDiskUsage(repo)).toEqual([]);
  });

  it("flags ~/.navori/backups when it exceeds its threshold", () => {
    const backups = join(home.dir, ".navori", "backups");
    mkdirSync(backups, { recursive: true });
    writeFileSync(join(backups, "snapshot.md"), "x".repeat(4096));

    const issues = scanDiskUsage(repo, { backupsBytes: 1 });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ target: "backups", path: backups, thresholdBytes: 1 });
    expect(issues[0]!.bytes).toBeGreaterThan(1);
  });

  it("flags .claude/worktrees when it exceeds its threshold", () => {
    const worktrees = join(repo, ".claude", "worktrees");
    mkdirSync(join(worktrees, "agent-abc"), { recursive: true });
    writeFileSync(join(worktrees, "agent-abc", "big.ts"), "x".repeat(4096));

    const issues = scanDiskUsage(repo, { worktreesBytes: 1 });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ target: "worktrees", path: worktrees, thresholdBytes: 1 });
  });

  it("stays silent while both directories sit under their thresholds", () => {
    const backups = join(home.dir, ".navori", "backups");
    const worktrees = join(repo, ".claude", "worktrees");
    mkdirSync(backups, { recursive: true });
    mkdirSync(worktrees, { recursive: true });
    writeFileSync(join(backups, "small.md"), "x");
    writeFileSync(join(worktrees, "small.ts"), "x");

    const huge = 10 * 1024 ** 3;
    expect(scanDiskUsage(repo, { backupsBytes: huge, worktreesBytes: huge })).toEqual([]);
  });

  it("can flag both directories in one scan", () => {
    mkdirSync(join(home.dir, ".navori", "backups"), { recursive: true });
    mkdirSync(join(repo, ".claude", "worktrees"), { recursive: true });
    writeFileSync(join(home.dir, ".navori", "backups", "a.md"), "x".repeat(4096));
    writeFileSync(join(repo, ".claude", "worktrees", "b.ts"), "x".repeat(4096));

    const issues = scanDiskUsage(repo, { backupsBytes: 1, worktreesBytes: 1 });
    expect(issues.map((i) => i.target).sort()).toEqual(["backups", "worktrees"]);
  });
});

describe("humanBytes", () => {
  it("renders MB under a GiB and GB above", () => {
    expect(humanBytes(500)).toBe("1 MB"); // never "0 MB" for a non-empty dir
    expect(humanBytes(122 * 1024 ** 2)).toBe("122 MB");
    expect(humanBytes(4.2 * 1024 ** 3)).toBe("4.2 GB");
    expect(humanBytes(12 * 1024 ** 3)).toBe("12 GB");
  });
});
