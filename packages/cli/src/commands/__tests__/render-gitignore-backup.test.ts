import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import type { NavoriConfigInput } from "../../lib/schema.ts";

/**
 * #458 — `.gitignore` was the last render write that skipped the backup.
 *
 * It matters more than a generated file: navori does not author `.gitignore`,
 * it injects a managed block INTO a file the user already owns, preserving
 * every line outside it. A bad injection therefore destroys the user's own
 * rules, and until this fix there was no snapshot to go back to.
 *
 * These specs pin the recovery path end to end: the pre-write `.gitignore` is
 * in the snapshot, `backup restore` brings it back with the user's lines
 * intact, and the "nothing to destroy" cases (creating the file, a no-op
 * re-render, a preview) still take no backup at all.
 *
 * @clack is mocked because `backup restore` prints and would prompt;
 * `safeHomedir` too, so nothing reaches the real `~/.navori`. The backup store
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
const { writeConfig } = await import("../../lib/config.ts");
const { runRender } = await import("../render.ts");
const { backupCommand } = await import("../backup.ts");
const { backupRoot } = await import("../../lib/backup.ts");

let cwd: string;

/** A `.gitignore` the user wrote before navori ever ran: the content at risk. */
const USER_RULES = [
  "node_modules/",
  "dist/",
  "# my own rules, not navori's",
  ".env.local",
  "",
].join("\n");

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "navori-home-"));
  cwd = mkdtempSync(join(tmpdir(), "navori-gitignore-backup-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home.dir, { recursive: true, force: true });
});

function config(input: Partial<NavoriConfigInput> & Pick<NavoriConfigInput, "engines">): void {
  writeConfig(join(cwd, "navori.config.json"), { name: "demo", preset: "custom", ...input });
}

/** Every file inside a backup snapshot, as repo-relative paths, sorted. */
function snapshotFiles(dir: string, root = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...snapshotFiles(full, root));
    else if (entry.isFile()) out.push(relative(root, full));
  }
  return out.sort();
}

/** Ids currently in the (per-spec-file) backup store. */
function backupIds(): string[] {
  const root = backupRoot();
  return existsSync(root) ? readdirSync(root).sort() : [];
}

const gitignore = (): string => readFileSync(join(cwd, ".gitignore"), "utf-8");

const restore = (backupId: string): Promise<unknown> =>
  runCommand(backupCommand, { rawArgs: ["restore", backupId, "--cwd", cwd, "--yes"] });

describe("render .gitignore — pre-write backup (#458)", () => {
  it("snapshots the user's file before injecting the managed block into it", () => {
    config({ engines: ["claude", "codex"], gitignoreHarness: "full" });
    writeFileSync(join(cwd, ".gitignore"), USER_RULES);

    const result = runRender(cwd, { dryRun: false });

    // The BLOCK is created, but the FILE already existed — that is exactly the
    // case with something to lose.
    expect(result.gitignore?.status).toBe("created");
    const backup = result.gitignore?.backupPath;
    expect(backup).toBeTruthy();
    // Proportional (#405): the one file at risk, holding the user's bytes as
    // they were before navori touched them.
    expect(snapshotFiles(backup as string)).toEqual([".gitignore"]);
    expect(readFileSync(join(backup as string, ".gitignore"), "utf-8")).toBe(USER_RULES);
  });

  it("snapshots it before UPDATING the block, and restore brings the user's lines back", async () => {
    config({ engines: ["claude", "codex"], gitignoreHarness: "full" });
    writeFileSync(join(cwd, ".gitignore"), USER_RULES);
    runRender(cwd, { dryRun: false });
    const beforeUpdate = gitignore();
    expect(beforeUpdate).toContain(".env.local");

    // Dropping an engine rewrites the block body (cubo B shrinks).
    config({ engines: ["claude"], gitignoreHarness: "full" });
    const second = runRender(cwd, { dryRun: false });
    expect(second.gitignore?.status).toBe("updated");
    const backup = second.gitignore?.backupPath as string;
    expect(readFileSync(join(backup, ".gitignore"), "utf-8")).toBe(beforeUpdate);

    // The scenario the snapshot exists for: the file comes back wrong (here,
    // clobbered outright) and the user has to get their own rules back.
    writeFileSync(join(cwd, ".gitignore"), "# clobbered, user rules gone\n");
    await restore(basename(backup));

    expect(gitignore()).toBe(beforeUpdate);
    expect(gitignore()).toContain(".env.local");
    expect(gitignore()).toContain("node_modules/");
  });

  it("takes no backup when it CREATES .gitignore — a new file destroys nothing", () => {
    config({ engines: ["claude"], gitignoreHarness: "local" });

    const result = runRender(cwd, { dryRun: false });

    expect(result.gitignore?.status).toBe("created");
    expect(result.gitignore?.backupPath ?? null).toBeNull();
  });

  it("takes no backup on a no-op re-render", () => {
    config({ engines: ["claude"], gitignoreHarness: "full" });
    writeFileSync(join(cwd, ".gitignore"), USER_RULES);
    runRender(cwd, { dryRun: false });
    const before = backupIds();

    const second = runRender(cwd, { dryRun: false });

    expect(second.gitignore?.status).toBe("unchanged");
    expect(second.gitignore?.backupPath ?? null).toBeNull();
    // The #405 no-op guard, extended: a render that changes nothing adds no
    // snapshot — not even an empty one.
    expect(backupIds()).toEqual(before);
  });

  it("takes no backup in preview — a preview touches nothing", () => {
    config({ engines: ["claude"], gitignoreHarness: "full" });
    writeFileSync(join(cwd, ".gitignore"), USER_RULES);
    const before = backupIds();

    const result = runRender(cwd, { dryRun: true });

    expect(result.gitignore?.status).toBe("created");
    expect(result.gitignore?.backupPath ?? null).toBeNull();
    expect(gitignore()).toBe(USER_RULES);
    expect(backupIds()).toEqual(before);
  });
});
