import { cpSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A prebuilt repo directory that tests copy instead of rebuilding it per case. */
export interface RepoTemplate {
  /** Realpath of the template directory; never hand it to a test, copy it. */
  readonly dir: string;
  /** Copy the template into a fresh directory and return its realpath. */
  copy(): string;
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
    dispose(): void {
      for (const copy of copies.splice(0)) rmSync(copy, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
