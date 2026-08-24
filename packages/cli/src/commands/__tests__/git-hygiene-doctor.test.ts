import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { NavoriConfigSchema, type NavoriConfig, type NavoriConfigInput } from "../../lib/schema.ts";
import { scanGitHygiene } from "../doctor.ts";

/**
 * #325 — the harness ordered agents to write the SDD board into `specs/` while
 * the repo's `.gitignore` threw that directory away, and nothing reported it:
 * doctor said OK, render said "up to date". The drift was in git's view of the
 * tree, which no check looked at. The symmetric failure (ephemeral agent dirs
 * NOT ignored, on their way into a commit) is checked here too.
 */
function tempRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "navori-git-hygiene-"));
  execFileSync("git", ["-C", cwd, "init", "-q"], { stdio: "ignore" });
  return cwd;
}

function gitignore(cwd: string, ...lines: string[]): void {
  writeFileSync(join(cwd, ".gitignore"), `${lines.join("\n")}\n`);
}

function makeDir(cwd: string, rel: string): void {
  mkdirSync(join(cwd, rel), { recursive: true });
  writeFileSync(join(cwd, rel, "note.md"), "x\n");
}

// Overrides are typed against the schema's INPUT (not `NavoriConfig`, its parse
// output): they are merged before `.parse()`, so a nested block whose fields all
// carry `.default()` — `sdd`, say — may legitimately be given partially.
function config(overrides: Partial<NavoriConfigInput> = {}): NavoriConfig {
  return NavoriConfigSchema.parse({
    name: "gh",
    engines: ["claude"],
    preset: "custom",
    branchBase: "main",
    qualityGate: { fast: "pnpm test", full: "pnpm test" },
    ...overrides,
  });
}

describe("scanGitHygiene (#325)", () => {
  it("returns null outside a git work tree", () => {
    const cwd = mkdtempSync(join(tmpdir(), "navori-git-hygiene-nogit-"));
    expect(scanGitHygiene(cwd, config())).toBeNull();
  });

  it("flags an ignored specs/ while the sdd block is active", () => {
    const cwd = tempRepo();
    gitignore(cwd, "specs/");
    expect(scanGitHygiene(cwd, config())?.specsIgnored).toBe("specs");
  });

  it("does not flag specs/ when it isn't ignored", () => {
    const cwd = tempRepo();
    gitignore(cwd, "node_modules/");
    expect(scanGitHygiene(cwd, config())?.specsIgnored).toBeNull();
  });

  it("stays quiet when SDD is off — an ignored specs/ is then intentional", () => {
    const cwd = tempRepo();
    gitignore(cwd, "specs/");
    expect(scanGitHygiene(cwd, config({ sdd: { enabled: false } }))?.specsIgnored).toBeNull();
  });

  it("stays quiet when the repo opted out of the sdd block", () => {
    const cwd = tempRepo();
    gitignore(cwd, "specs/");
    const cfg = config({ blocks: { exclude: ["sdd"] } });
    expect(scanGitHygiene(cwd, cfg)?.specsIgnored).toBeNull();
  });

  it("honours a custom specsDir", () => {
    const cwd = tempRepo();
    gitignore(cwd, "docs/specs/");
    const cfg = config({ sdd: { specsDir: "docs/specs" } });
    expect(scanGitHygiene(cwd, cfg)?.specsIgnored).toBe("docs/specs");
  });

  it("flags ephemeral agent paths that exist on disk and aren't ignored", () => {
    const cwd = tempRepo();
    makeDir(cwd, ".claude/progress");
    makeDir(cwd, ".claude/worktrees");
    // Order follows the shared EPHEMERAL_HARNESS_PATHS list (#348), which keeps
    // the `.gitignore` cubo A order: settings.local.json, worktrees, progress.
    expect(scanGitHygiene(cwd, config())?.ephemeralNotIgnored).toEqual([
      ".claude/worktrees/",
      ".claude/progress/",
    ]);
  });

  it("ignores ephemeral paths that don't exist yet (no risk, no noise)", () => {
    const cwd = tempRepo();
    expect(scanGitHygiene(cwd, config())?.ephemeralNotIgnored).toEqual([]);
  });

  it("is quiet when the whole harness is gitignored (the Bonum shape)", () => {
    const cwd = tempRepo();
    gitignore(cwd, ".claude/");
    makeDir(cwd, ".claude/progress");
    makeDir(cwd, ".claude/worktrees");
    expect(scanGitHygiene(cwd, config())?.ephemeralNotIgnored).toEqual([]);
  });

  it("never flags the root progress/ — it is git-persisted by design", () => {
    const cwd = tempRepo();
    makeDir(cwd, "progress");
    expect(scanGitHygiene(cwd, config())?.ephemeralNotIgnored).toEqual([]);
  });
});
