import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { getCoreRoot } from "../bundled-assets.ts";

/**
 * Behavioral tests for core-assets/hooks/worktree-reclaim.sh (#527).
 *
 * This hook DELETES checkouts, so the tests that matter are the ones proving it
 * refuses to. A worktree holding uncommitted or unpushed work is the only copy
 * of that work: deleting one is unrecoverable, while keeping one costs disk.
 * Every "kept" case below is therefore a safety property, not an edge case.
 *
 * `gh` is stubbed through PATH so the merged/not-merged answer is controlled
 * without touching the network.
 */

const runsBash = process.platform !== "win32";
const hookPath = resolve(getCoreRoot(), "core-assets/hooks/worktree-reclaim.sh");

let root: string;
let repo: string;
let binDir: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t.t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t.t",
    },
  });
}

/** A `gh` on PATH that reports every branch as merged (or as never merged). */
function stubGh(merged: boolean): void {
  const body = merged ? '[{"number":42}]' : "[]";
  writeFileSync(
    join(binDir, "gh"),
    `#!/usr/bin/env bash\nif [ "\${*}" = "\${*/--jq/}" ]; then echo '${body}'; else echo '${merged ? "42" : ""}'; fi\n`,
    "utf-8",
  );
  chmodSync(join(binDir, "gh"), 0o755);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "navori-wt-"));
  binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });

  const origin = join(root, "origin.git");
  mkdirSync(origin, { recursive: true });
  git(origin, "init", "--bare", "-b", "main", ".");

  repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-b", "main", ".");
  writeFileSync(join(repo, "README.md"), "seed", "utf-8");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "seed");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-u", "origin", "main");
  mkdirSync(join(repo, ".claude", "worktrees"), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Add an agent worktree on `branch`; returns its path. */
function addWorktree(branch: string, opts: { push?: boolean } = {}): string {
  const wt = join(repo, ".claude", "worktrees", branch.replace(/\//g, "-"));
  git(repo, "worktree", "add", "-b", branch, wt);
  writeFileSync(join(wt, "work.txt"), "done", "utf-8");
  git(wt, "add", "-A");
  git(wt, "commit", "-m", `work on ${branch}`);
  if (opts.push !== false) git(wt, "push", "-u", "origin", branch);
  return wt;
}

/** Run the hook against `repo` with the stubbed PATH; returns stdout. */
function runHook(withGh = true): string {
  return execFileSync("bash", [hookPath], {
    input: JSON.stringify({ cwd: repo }),
    encoding: "utf-8",
    env: {
      ...process.env,
      // A PATH holding only the stub dir plus the real git/bash locations, so
      // "no gh installed" is reproducible.
      PATH: withGh ? `${binDir}:${process.env.PATH}` : "/usr/bin:/bin",
      CLAUDE_PROJECT_DIR: repo,
    },
  });
}

describe.runIf(runsBash)("worktree-reclaim.sh (#527)", () => {
  it("removes a worktree that is clean, pushed and whose PR merged", () => {
    const wt = addWorktree("feat/done");
    stubGh(true);

    const out = runHook();

    expect(existsSync(wt)).toBe(false);
    expect(out).toContain("reclaimed");
    expect(out).toContain("feat/done");
    // `git worktree remove` (not `rm -rf`) leaves no stale entry behind.
    expect(git(repo, "worktree", "list")).not.toContain(wt);
  });

  it("KEEPS a worktree with uncommitted changes", () => {
    const wt = addWorktree("feat/dirty");
    writeFileSync(join(wt, "wip.txt"), "half a thought", "utf-8");
    stubGh(true);

    const out = runHook();

    expect(existsSync(wt)).toBe(true);
    expect(out).toContain("uncommitted");
  });

  it("KEEPS a worktree whose only untracked file is the work", () => {
    // `--porcelain` reports untracked too, and it must: a file nobody added is
    // still the only copy of it.
    const wt = addWorktree("feat/untracked");
    writeFileSync(join(wt, "notes.md"), "not staged", "utf-8");
    stubGh(true);

    runHook();

    expect(existsSync(wt)).toBe(true);
  });

  it("KEEPS a branch that was never pushed", () => {
    const wt = addWorktree("feat/local", { push: false });
    stubGh(true);

    const out = runHook();

    expect(existsSync(wt)).toBe(true);
    expect(out).toContain("no upstream");
  });

  it("KEEPS a branch with commits ahead of its upstream", () => {
    const wt = addWorktree("feat/ahead");
    writeFileSync(join(wt, "more.txt"), "extra", "utf-8");
    git(wt, "add", "-A");
    git(wt, "commit", "-m", "unpushed work");
    stubGh(true);

    const out = runHook();

    expect(existsSync(wt)).toBe(true);
    expect(out).toContain("not pushed");
  });

  it("KEEPS everything when no PR is merged — squash merge is why gh decides", () => {
    // The repo squash-merges, so the branch SHA is never an ancestor of the
    // base: `git merge-base --is-ancestor` would answer "not merged" for work
    // that shipped days ago. gh is the only cheap source of truth.
    const wt = addWorktree("feat/open-pr");
    stubGh(false);

    const out = runHook();

    expect(existsSync(wt)).toBe(true);
    expect(out).toContain("no merged PR");
  });

  it("KEEPS everything when gh is unavailable — no answer means no deletion", () => {
    const wt = addWorktree("feat/no-gh");

    const out = runHook(false);

    expect(existsSync(wt)).toBe(true);
    expect(out).toContain("gh not available");
  });

  it("never touches a worktree outside .claude/worktrees — that one is the user's", () => {
    const mine = join(root, "my-own-worktree");
    git(repo, "worktree", "add", "-b", "feat/mine", mine);
    git(mine, "push", "-u", "origin", "feat/mine");
    stubGh(true);

    const out = runHook();

    expect(existsSync(mine)).toBe(true);
    expect(out).not.toContain("my-own-worktree");
  });

  it("says nothing when there is nothing to sweep", () => {
    stubGh(true);
    expect(runHook().trim()).toBe("");
  });
});
