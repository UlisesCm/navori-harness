import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** A prebuilt repo directory that tests copy instead of rebuilding it per case. */
export interface RepoTemplate {
  /** Realpath of the template directory; never hand it to a test, copy it. */
  readonly dir: string;
  /** Copy the template into a fresh directory and return its realpath. */
  copy(): string;
  /** Copy the template INTO an existing directory (for tests that own their `dir`). */
  copyInto(target: string): void;
  /** Remove the template and every copy it handed out that is still on disk. */
  dispose(): void;
}

/**
 * Build a repo fixture once (typically in `beforeAll`) and copy it per test with `cpSync`.
 *
 * The template must hold only state created BEFORE any call that records absolute paths
 * (`git remote add`, `core.hooksPath`, evidence with `cwd`, receipts): such calls belong in the
 * test, after `copy()`. `git worktree` is deliberately not used because worktrees share refs.
 *
 * @param prefix Directory-name prefix for the template and its copies.
 * @param build Populates the empty template directory (e.g. `git init`, config, fixture files).
 */
export function createRepoTemplate(prefix: string, build: (dir: string) => void): RepoTemplate {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `${prefix}tpl-`)));
  const copies: string[] = [];
  try {
    build(dir);
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return {
    dir,
    copy(): string {
      const target = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
      cpSync(dir, target, { recursive: true, verbatimSymlinks: true });
      copies.push(target);
      return target;
    },
    copyInto(target: string): void {
      cpSync(dir, target, { recursive: true, verbatimSymlinks: true });
    },
    dispose(): void {
      for (const copy of copies.splice(0)) rmSync(copy, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Options shared by {@link emptyRepo} and {@link committedRepo}. */
export interface GitRepoOptions {
  /** Initial branch name; defaults to `main`. */
  branch?: string;
  /** Directory-name prefix for the template and its copies. */
  prefix?: string;
}

/** Runs the real git binary; the hermetic env (`GIT_CONFIG_GLOBAL`, `GIT_TEMPLATE_DIR`) applies. */
function git(dir: string, args: readonly string[]): void {
  execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
}

/**
 * Template of an empty git repo (`git init` once per file, spec 0055 D7). Create it in
 * `beforeAll`, call `copy()` per case and `dispose()` in `afterAll`. Tests that exercise
 * `git worktree`, `.git` as a file, an external `GIT_DIR` or `init` itself keep a real `git init`.
 */
export function emptyRepo(options: GitRepoOptions = {}): RepoTemplate {
  return createRepoTemplate(options.prefix ?? "navori-repo-", (dir) =>
    git(dir, ["init", "-q", "-b", options.branch ?? "main"]),
  );
}

/**
 * Template of a git repo with one commit holding `files` (relative path to content). The commit
 * identity is passed per call, never written to `.git/config`, so the template holds no absolute
 * path and no user data.
 */
export function committedRepo(
  files: Readonly<Record<string, string>>,
  options: GitRepoOptions = {},
): RepoTemplate {
  return createRepoTemplate(options.prefix ?? "navori-repo-", (dir) => {
    git(dir, ["init", "-q", "-b", options.branch ?? "main"]);
    for (const [path, content] of Object.entries(files)) {
      const target = join(dir, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    git(dir, ["add", "-A"]);
    git(dir, [
      "-c",
      "user.name=navori-test",
      "-c",
      "user.email=test@navori.invalid",
      "commit",
      "-q",
      "-m",
      "init",
    ]);
  });
}
