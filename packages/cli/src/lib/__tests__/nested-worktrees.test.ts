import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanNestedWorktrees } from "../nested-worktrees.ts";

/**
 * #522: an agent worktree lives at `.claude/worktrees/<id>/` — inside the repo
 * — and installs its own `node_modules`. eslint resolves config upward, so a
 * run inside the worktree loads the parent repo's config too and dies with
 * "couldn't determine the plugin uniquely". With eslint in a pre-commit hook
 * the agent cannot commit at all, so the branch never ships and the only
 * visible symptom is a fat abandoned worktree (measured: 3 worktrees, 2.6 GB,
 * 3 unpushed branches).
 *
 * These cover the scan; the copy lives in i18n and the `--json` publication in
 * doctor-json-checks.e2e.test.ts.
 */

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "nested-worktrees-"));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

/** A nested worktree, with or without the install that causes the conflict. */
function seedWorktree(id: string, opts: { install: boolean } = { install: true }): string {
  const path = join(repo, ".claude", "worktrees", id);
  mkdirSync(path, { recursive: true });
  // Every worktree is a full checkout, so it carries the repo's config too.
  writeFileSync(join(path, ".eslintrc.js"), "module.exports = {};\n");
  if (opts.install) mkdirSync(join(path, "node_modules", "eslint-plugin-x"), { recursive: true });
  return `.claude/worktrees/${id}`;
}

describe("scanNestedWorktrees (#522)", () => {
  it("flags the measured case: an eslint repo with an installed nested worktree", () => {
    writeFileSync(join(repo, ".eslintrc.js"), "module.exports = { plugins: ['x'] };\n");
    const worktree = seedWorktree("agent-a028");

    expect(scanNestedWorktrees(repo)).toEqual({
      eslintConfig: ".eslintrc.js",
      worktrees: [worktree],
    });
  });

  it("returns null for a repo with no worktrees at all", () => {
    writeFileSync(join(repo, ".eslintrc.js"), "module.exports = {};\n");
    expect(scanNestedWorktrees(repo)).toBeNull();
  });

  it("returns null when the worktrees exist but carry no install", () => {
    // No node_modules in the worktree means no second copy of any plugin, so
    // eslint resolves exactly one — nothing to warn about.
    writeFileSync(join(repo, ".eslintrc.js"), "module.exports = {};\n");
    seedWorktree("agent-a107", { install: false });
    expect(scanNestedWorktrees(repo)).toBeNull();
  });

  it("returns null when the repo has no eslint config", () => {
    // Same worktree that fires above: the eslint half is what makes it a
    // finding, so a Python or Go repo never sees this warning.
    seedWorktree("agent-a028");
    expect(scanNestedWorktrees(repo)).toBeNull();
  });

  it("lists only the installed worktrees, sorted", () => {
    writeFileSync(join(repo, ".eslintrc.js"), "module.exports = {};\n");
    seedWorktree("agent-c");
    seedWorktree("agent-a");
    seedWorktree("agent-b", { install: false });

    expect(scanNestedWorktrees(repo)?.worktrees).toEqual([
      ".claude/worktrees/agent-a",
      ".claude/worktrees/agent-c",
    ]);
  });

  it("ignores a stray FILE inside the worktrees directory", () => {
    writeFileSync(join(repo, ".eslintrc.js"), "module.exports = {};\n");
    mkdirSync(join(repo, ".claude", "worktrees"), { recursive: true });
    writeFileSync(join(repo, ".claude", "worktrees", ".DS_Store"), "junk");
    expect(scanNestedWorktrees(repo)).toBeNull();
  });

  it.each([
    ".eslintrc",
    ".eslintrc.js",
    ".eslintrc.cjs",
    ".eslintrc.json",
    ".eslintrc.yml",
    ".eslintrc.yaml",
    "eslint.config.js",
    "eslint.config.mjs",
    "eslint.config.ts",
  ])("detects the config as %s", (filename) => {
    writeFileSync(join(repo, filename), "{}\n");
    seedWorktree("agent-a028");
    expect(scanNestedWorktrees(repo)?.eslintConfig).toBe(filename);
  });

  it("detects the config declared inside package.json", () => {
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ name: "demo", eslintConfig: { extends: ["eslint:recommended"] } }),
    );
    seedWorktree("agent-a028");
    expect(scanNestedWorktrees(repo)?.eslintConfig).toBe("package.json#eslintConfig");
  });

  it("does not read a package.json without eslintConfig as a config", () => {
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "demo" }));
    seedWorktree("agent-a028");
    expect(scanNestedWorktrees(repo)).toBeNull();
  });

  it("survives a malformed package.json", () => {
    writeFileSync(join(repo, "package.json"), "{ not json");
    seedWorktree("agent-a028");
    expect(scanNestedWorktrees(repo)).toBeNull();
  });

  it("returns null for a directory that does not exist", () => {
    expect(scanNestedWorktrees(join(repo, "absent"))).toBeNull();
  });
});
