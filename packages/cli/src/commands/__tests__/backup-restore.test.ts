import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

/**
 * `navori backup restore` over the two snapshot shapes it must serve (#405):
 *
 *  - PARTIAL (the new default): `commitWrites` now snapshots only the files a
 *    render overwrites or deletes, so a backup no longer mirrors the whole
 *    `.claude/` tree.
 *  - FULL TREE (legacy): every backup taken by navori ≤0.6.0 — and the ones
 *    sitting in a developer's `~/.navori/backups` right now.
 *
 * Both work because restore is overwrite-only: it walks the backup dir and
 * copies what it finds, never deleting what the snapshot omits. That is why the
 * format needs no version field or manifest — a partial snapshot is the same
 * format with fewer entries. These specs pin that property; without them,
 * someone "fixing" restore into a true tree-sync would silently delete the
 * user's files that a proportional backup legitimately never contained.
 *
 * @clack is mocked (the command prints and would prompt); `safeHomedir` too, so
 * `readGlobalConfig()` cannot reach the real `~/.navori`. The backup store
 * itself is redirected per spec file by `NAVORI_BACKUP_ROOT` (#404).
 */
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("../../lib/home.ts", () => ({ safeHomedir: () => home.dir }));

vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  note: vi.fn(),
  confirm: vi.fn(),
  isCancel: () => false,
  log: {
    message: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    step: vi.fn(),
  },
}));

const { runCommand } = await import("citty");
const { backupCommand } = await import("../backup.ts");
const { createBackup, backupRoot } = await import("../../lib/backup.ts");

let cwd: string;

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "navori-home-"));
  cwd = mkdtempSync(join(tmpdir(), "navori-restore-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home.dir, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const abs = join(cwd, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf-8");
}

const read = (rel: string): string => readFileSync(join(cwd, rel), "utf-8");

const restore = (backupId: string): Promise<unknown> =>
  runCommand(backupCommand, { rawArgs: ["restore", backupId, "--cwd", cwd, "--yes"] });

describe("backup restore — partial snapshot (#405)", () => {
  it("restores what the snapshot holds and leaves everything else alone", async () => {
    write(".claude/agents/reviewer.md", "reviewer v1");
    write(".claude/agents/explorer.md", "explorer v1");
    write("CLAUDE.md", "claude md v1");

    // The shape a proportional render backup has: only the file about to be
    // rewritten.
    const handle = createBackup(cwd, [".claude/agents/reviewer.md"]);
    expect(handle.files).toEqual([".claude/agents/reviewer.md"]);

    // The repo moves on after the backup: the snapshotted file goes bad, an
    // unrelated file gets a hand edit, and a new file appears.
    write(".claude/agents/reviewer.md", "reviewer v2 (broken)");
    write(".claude/agents/explorer.md", "explorer edited by the user");
    write(".claude/skills/mine/SKILL.md", "written after the backup");

    await restore(basename(handle.path));

    expect(read(".claude/agents/reviewer.md")).toBe("reviewer v1");
    // Not in the snapshot → not reverted and, above all, NOT deleted. A restore
    // that treated the backup as the full desired tree would destroy both.
    expect(read(".claude/agents/explorer.md")).toBe("explorer edited by the user");
    expect(read("CLAUDE.md")).toBe("claude md v1");
    expect(existsSync(join(cwd, ".claude/skills/mine/SKILL.md"))).toBe(true);
  });

  it("recreates a file the render deleted", async () => {
    write(".claude/skills/dropped-lib/SKILL.md", "pruned orphan");
    const handle = createBackup(cwd, [".claude/skills/dropped-lib"]);

    rmSync(join(cwd, ".claude/skills/dropped-lib"), { recursive: true, force: true });
    await restore(basename(handle.path));

    expect(read(".claude/skills/dropped-lib/SKILL.md")).toBe("pruned orphan");
  });
});

describe("backup restore — legacy full-tree snapshot (back-compat)", () => {
  it("still restores a snapshot taken before backups became proportional", async () => {
    // Handcrafted so the fixture does not depend on today's createBackup: this
    // is the on-disk shape of a pre-#405 backup — a mirror of the engine's whole
    // tree — under an id with the legacy `<repo>-<timestamp>-<seq>` naming.
    const legacyId = "demo-2026-01-02T03-04-05-006-p42-0";
    const legacyDir = join(backupRoot(), legacyId);
    for (const [rel, content] of Object.entries({
      "CLAUDE.md": "claude md as of the legacy backup",
      ".claude/agents/leader.md": "leader as of the legacy backup",
      ".claude/settings.json": '{"$navori":{"managed":true}}',
      "navori.config.json": '{"name":"demo"}',
    })) {
      const abs = join(legacyDir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, "utf-8");
    }

    write("CLAUDE.md", "claude md, since corrupted");
    write(".claude/agents/leader.md", "leader, since corrupted");
    write(".claude/settings.json", "{ not json");
    write("navori.config.json", '{"name":"demo"}');
    write("src/app.ts", "user source, never in any backup");

    await restore(legacyId);

    expect(read("CLAUDE.md")).toBe("claude md as of the legacy backup");
    expect(read(".claude/agents/leader.md")).toBe("leader as of the legacy backup");
    expect(read(".claude/settings.json")).toBe('{"$navori":{"managed":true}}');
    expect(read("src/app.ts")).toBe("user source, never in any backup");

    rmSync(legacyDir, { recursive: true, force: true });
  });
});
