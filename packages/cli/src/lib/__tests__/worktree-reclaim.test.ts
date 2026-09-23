import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  chmodSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { getCoreRoot } from "../render/bundled-assets.ts";

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
/** Every `gh` invocation the stub saw, one line of arguments each. */
let ghCalls: string;

/** Where the sweep hands its KEPT notice to the next SessionStart (#774). */
function keptNotice(): string {
  return join(repo, ".claude", "worktrees", ".navori-kept-notice");
}

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

/**
 * A `gh` on PATH answering the ONE batched query the hook makes since #774:
 * `gh pr list --state merged --json number,headRefName --jq …`, whose output is
 * a `<branch> <number>` line per merged PR. It also records every invocation,
 * which is what lets a test assert the call count instead of trusting it.
 */
function stubGh(mergedBranches: string[]): void {
  const lines = mergedBranches.map((b, i) => `${b} ${42 + i}`).join("\n");
  writeFileSync(
    join(binDir, "gh"),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> '${ghCalls}'\n` +
      (lines ? `printf '%s\\n' '${lines}'\n` : ""),
    "utf-8",
  );
  chmodSync(join(binDir, "gh"), 0o755);
}

/** The argument lines the stubbed `gh` recorded, one per invocation. */
function ghInvocations(): string[] {
  if (!existsSync(ghCalls)) return [];
  return readFileSync(ghCalls, "utf-8").trim().split("\n").filter(Boolean);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "navori-wt-"));
  // #909 — this hook spawns 8 real `git` processes (bare repo init + a repo
  // with an actual push) under Vitest's default 10s hookTimeout. That budget
  // is fine in isolation but flakes under CPU contention from other suites
  // running concurrently (multi-agent sessions, CI matrix). A per-hook
  // override keeps the fix local instead of raising `hookTimeout` globally in
  // vitest.config.ts, which would mask real timeout regressions elsewhere.
  binDir = join(root, "bin");
  ghCalls = join(root, "gh-calls.log");
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
}, 20_000);

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

/**
 * A PATH with `git` (and `cat`, which the hook reads its payload with) but
 * provably NO `gh`. Hardcoding `/usr/bin:/bin` was wrong: `gh` IS installed
 * there on the GitHub runner, so the "no gh" case silently became the "no
 * merged PR" case and the test asserted the wrong branch.
 */
function pathWithoutGh(): string {
  const dir = join(root, "nogh");
  mkdirSync(dir, { recursive: true });
  // `bash` included because execFileSync resolves the interpreter through this
  // same PATH; `cat` because the hook reads its payload with it.
  for (const bin of ["bash", "git", "cat"]) {
    const real = execFileSync("bash", ["-c", `command -v ${bin}`], { encoding: "utf-8" }).trim();
    symlinkSync(real, join(dir, bin));
  }
  return dir;
}

/** Run the hook against `repo` with the stubbed PATH; returns stdout. */
function runHook(withGh = true): string {
  return execFileSync("bash", [hookPath], {
    input: JSON.stringify({ cwd: repo }),
    encoding: "utf-8",
    env: {
      ...process.env,
      PATH: withGh ? `${binDir}:${process.env.PATH}` : pathWithoutGh(),
      CLAUDE_PROJECT_DIR: repo,
    },
  });
}

describe.runIf(runsBash)("worktree-reclaim.sh (#527)", () => {
  it("removes a worktree that is clean, pushed and whose PR merged", () => {
    const wt = addWorktree("feat/done");
    stubGh(["feat/done"]);

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
    stubGh(["feat/dirty"]);

    const out = runHook();

    expect(existsSync(wt)).toBe(true);
    expect(out).toContain("uncommitted");
  });

  it("KEEPS a worktree whose only untracked file is the work", () => {
    // `--porcelain` reports untracked too, and it must: a file nobody added is
    // still the only copy of it.
    const wt = addWorktree("feat/untracked");
    writeFileSync(join(wt, "notes.md"), "not staged", "utf-8");
    stubGh(["feat/untracked"]);

    runHook();

    expect(existsSync(wt)).toBe(true);
  });

  it("KEEPS a branch that was never pushed", () => {
    const wt = addWorktree("feat/local", { push: false });
    stubGh(["feat/local"]);

    const out = runHook();

    expect(existsSync(wt)).toBe(true);
    expect(out).toContain("no upstream");
  });

  it("KEEPS a branch with commits ahead of its upstream", () => {
    const wt = addWorktree("feat/ahead");
    writeFileSync(join(wt, "more.txt"), "extra", "utf-8");
    git(wt, "add", "-A");
    git(wt, "commit", "-m", "unpushed work");
    stubGh(["feat/ahead"]);

    const out = runHook();

    expect(existsSync(wt)).toBe(true);
    expect(out).toContain("not pushed");
  });

  it("KEEPS everything when no PR is merged — squash merge is why gh decides", () => {
    // The repo squash-merges, so the branch SHA is never an ancestor of the
    // base: `git merge-base --is-ancestor` would answer "not merged" for work
    // that shipped days ago. gh is the only cheap source of truth.
    const wt = addWorktree("feat/open-pr");
    stubGh([]);

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
    stubGh(["feat/mine"]);

    const out = runHook();

    expect(existsSync(mine)).toBe(true);
    expect(out).not.toContain("my-own-worktree");
  });

  it("says nothing when there is nothing to sweep", () => {
    stubGh([]);
    expect(runHook().trim()).toBe("");
  });

  /**
   * #774: one network call for the whole sweep, not one per worktree.
   *
   * SessionEnd hooks share a budget — "the overall budget is automatically
   * raised to the highest per-hook timeout configured", so audit-close (10s)
   * and this hook (30s) get 30s TOTAL — and the scenario this hook was written
   * for is the 27-worktree cleanup of #527. At ~1s per `gh pr list` that sweep
   * died halfway through with no signal, which is worse than not sweeping:
   * whoever reads the disk usage believes cleanup ran.
   */
  it("consulta gh UNA vez para todo el barrido, no una por worktree", () => {
    addWorktree("feat/one");
    addWorktree("feat/two");
    addWorktree("feat/three");
    stubGh(["feat/one", "feat/two", "feat/three"]);

    runHook();

    const calls = ghInvocations();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--state merged");
    // Batched means the query cannot be per-branch any more.
    expect(calls[0]).not.toContain("--head");
  });

  it("no gasta la llamada de red cuando ningún worktree llega al paso del PR", () => {
    const wt = addWorktree("feat/dirty-only");
    writeFileSync(join(wt, "wip.txt"), "half a thought", "utf-8");
    stubGh(["feat/dirty-only"]);

    runHook();

    expect(ghInvocations()).toEqual([]);
  });

  /**
   * The KEPT half of the report used to go to stdout with a comment claiming it
   * reached the transcript. It does not: on SessionEnd "Claude Code writes
   * stdout to the debug log" and "discards their JSON output fields". So the
   * one warning that protects live work had no reader. It is persisted for the
   * next SessionStart instead (#774).
   */
  it("deja el aviso KEPT donde el próximo SessionStart lo lee", () => {
    const wt = addWorktree("feat/dirty");
    writeFileSync(join(wt, "wip.txt"), "half a thought", "utf-8");
    stubGh([]);

    runHook();

    // The file carries the LIST only; the sentence that frames it is written by
    // `session-start-context.sh`, which is the side that knows the repo's
    // language (this script's runtime strings are fixed English, #422).
    const notice = readFileSync(keptNotice(), "utf-8");
    expect(notice).toContain("uncommitted changes");
    expect(notice).toContain("feat/dirty");
  });

  it("limpia un aviso pendiente cuando ya no queda nada conservado", () => {
    writeFileSync(keptNotice(), "navori: aviso viejo de la sesión pasada\n", "utf-8");
    stubGh([]);

    runHook();

    // Truncated, never deleted: this hook removes the worktrees it was asked to
    // remove and nothing else. An empty notice is a notice the reader skips.
    expect(existsSync(keptNotice())).toBe(true);
    expect(readFileSync(keptNotice(), "utf-8").trim()).toBe("");
  });

  it("no crea el archivo de aviso cuando nunca hubo nada que conservar", () => {
    stubGh([]);
    runHook();
    expect(existsSync(keptNotice())).toBe(false);
  });
});
