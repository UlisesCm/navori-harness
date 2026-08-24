import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NavoriConfig } from "../../../lib/config.ts";

/**
 * #348: the pre-render backup used to copy `.claude/worktrees/` — a full repo
 * clone per worktree — so every `render --apply` weighed gigabytes (131 GB of
 * backups on a real machine, until the disk filled and the backup itself failed
 * with ENOSPC). The engine must exclude every path the harness never versions.
 * createBackup writes under ~/.navori/backups, so safeHomedir is mocked to a
 * throwaway home.
 */
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("../../../lib/home.ts", () => ({ safeHomedir: () => home.dir }));

const { renderClaudeEngine } = await import("../index.ts");
const { renderCodexEngine } = await import("../../codex/index.ts");

const CONFIG = {
  name: "demo",
  engines: ["claude"],
  preset: "custom",
  version: "1.0.0",
  language: "es",
  branchBase: "main",
  commits: "conventional-es",
  qualityGate: { fast: "pnpm typecheck", full: "pnpm test" },
} as unknown as NavoriConfig;

let cwd: string;

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "navori-home-"));
  cwd = mkdtempSync(join(tmpdir(), "navori-backup-exclude-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home.dir, { recursive: true, force: true });
});

describe("renderClaudeEngine — backup excludes never-versioned state (#348)", () => {
  it("backs up `.claude` without the worktrees, progress and local settings", () => {
    renderClaudeEngine(cwd, CONFIG); // seed a rendered harness

    // Machine-local state the harness never versions.
    mkdirSync(join(cwd, ".claude/worktrees/feat-x/src"), { recursive: true });
    writeFileSync(join(cwd, ".claude/worktrees/feat-x/src/clone.ts"), "a whole repo clone");
    mkdirSync(join(cwd, ".claude/progress"), { recursive: true });
    writeFileSync(join(cwd, ".claude/progress/impl_x.md"), "handoff");
    writeFileSync(join(cwd, ".claude/settings.local.json"), '{"private":1}');

    // A config change so the second render actually rewrites existing files and
    // therefore takes a backup.
    const second = renderClaudeEngine(cwd, {
      ...CONFIG,
      qualityGate: { fast: "pnpm check", full: "pnpm test" },
    } as unknown as NavoriConfig);

    expect(second.backupPath).not.toBeNull();
    const backup = second.backupPath as string;
    expect(existsSync(join(backup, ".claude/worktrees"))).toBe(false);
    expect(existsSync(join(backup, ".claude/progress"))).toBe(false);
    expect(existsSync(join(backup, ".claude/settings.local.json"))).toBe(false);
    // …while the versioned harness itself is still snapshotted.
    expect(existsSync(join(backup, ".claude/agents/leader.md"))).toBe(true);
  });
});

// Audit v0.5.1 A2: the Codex engine called commitWrites WITHOUT backupExclude,
// so every `render --apply` snapshotted `.codex/progress/` (receipts + subagent
// handoffs) — and a `navori backup restore` could resurrect a stale receipt that
// blocks the next commit. The exclusion now lives in commitWrites itself, so it
// must hold for EVERY engine, not just Claude.
describe("renderCodexEngine — backup excludes never-versioned state (audit A2)", () => {
  it("backs up `.codex` without the ephemeral progress dir", () => {
    renderCodexEngine(cwd, { ...CONFIG, engines: ["codex"] } as unknown as NavoriConfig);

    // Machine-local Codex state the harness never versions (receipt + handoffs).
    mkdirSync(join(cwd, ".codex/progress"), { recursive: true });
    writeFileSync(join(cwd, ".codex/progress/receipt.txt"), "stale receipt");
    writeFileSync(join(cwd, ".codex/progress/impl_x.md"), "handoff");

    // A config change so the second render rewrites existing files → backup.
    const second = renderCodexEngine(cwd, {
      ...CONFIG,
      engines: ["codex"],
      qualityGate: { fast: "pnpm check", full: "pnpm test" },
    } as unknown as NavoriConfig);

    expect(second.backupPath).not.toBeNull();
    const backup = second.backupPath as string;
    expect(existsSync(join(backup, ".codex/progress"))).toBe(false);
    // …while the versioned harness file this render rewrites IS snapshotted.
    expect(existsSync(join(backup, "AGENTS.md"))).toBe(true);
    // `.codex/config.toml` is versioned harness too, but the quality-gate change
    // does not rewrite it — and since #405 the backup is proportional to the
    // diff, so an untouched file is no longer copied. Nothing is at risk: the
    // render never writes it this run.
    expect(existsSync(join(backup, ".codex/config.toml"))).toBe(false);
  });
});
