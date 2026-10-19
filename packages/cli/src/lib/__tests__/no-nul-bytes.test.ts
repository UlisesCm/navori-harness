import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Repo-hygiene guard: no versioned source under `packages/` may contain a raw
 * NUL byte (U+0000).
 *
 * A single NUL flips git and ripgrep into binary mode for the WHOLE file, and
 * both fail silently: `git log -p` / the GitHub PR view print "Binary files …
 * differ" instead of a diff, and `grep`/`rg` hide every match inside it. The
 * file becomes unreviewable and unsearchable while looking perfectly normal in
 * an editor. `engines/codex/compat.ts` carried two of them for months — the
 * sentinel that shields the commit-hygiene phrase was typed as raw NULs — and
 * that is why a path rewrite living at its line 48 could not be found by grep.
 *
 * A NUL is always expressible as an escape sequence, which keeps the runtime
 * value byte-identical and the source ASCII. So this guard has no legitimate
 * exception, and the failure message says which escape to use.
 */

const HERE = resolve(fileURLToPath(import.meta.url), "..");
// packages/cli/src/lib/__tests__ → repo root is five levels up.
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..", "..");

/** Build output and installed deps are not versioned sources — skip them. */
const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", ".turbo", ".git"]);

/** Text sources a human reads in a diff. A real binary asset is not swept. */
const SOURCE_EXT = /\.(ts|tsx|js|mjs|cjs|json|md|sh|toml|ya?ml)$/;

/** Enumerate tracked sources, without following working-tree symlinks. */
function trackedSources(repoRoot: string): string[] {
  const paths: string[] = execFileSync("git", ["ls-files", "-z", "--", "packages/"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .split("\u0000")
    .filter((path: string): boolean => path.length > 0);
  return paths
    .filter((path: string): boolean => {
      const parts: string[] = path.split("/");
      if (
        !SOURCE_EXT.test(path) ||
        parts.slice(0, -1).some((part: string): boolean => SKIP_DIRS.has(part))
      ) {
        return false;
      }
      // lstat preserves the walker's symlink semantics, including directory links.
      // Missing or unreadable tracked sources must still fail, not silently pass.
      return parts.every((_: string, index: number): boolean => {
        const entry = lstatSync(join(repoRoot, ...parts.slice(0, index + 1)));
        return index === parts.length - 1 ? entry.isFile() : entry.isDirectory();
      });
    })
    .map((path: string): string => join(repoRoot, path));
}

/** Read current working-tree bytes, not the staged or HEAD blob. */
function nulSources(files: string[]): string[] {
  return files.filter((file: string): boolean => readFileSync(file).includes(0));
}

describe("no versioned source carries a raw NUL byte", () => {
  it("packages/** is grep-able and diff-able", () => {
    const files: string[] = trackedSources(REPO_ROOT);
    expect(files.length).toBeGreaterThan(100);

    const offenders: string[] = nulSources(files).map(
      (file: string): string =>
        `${relative(REPO_ROOT, file)} — write the NUL as a \\u0000 escape instead`,
    );
    expect(offenders).toEqual([]);
  });
});

describe("tracked-source enumeration", () => {
  let repoRoot: string;

  beforeEach((): void => {
    repoRoot = mkdtempSync(join(tmpdir(), "navori-nul-"));
    execFileSync("git", ["init", "--quiet"], { cwd: repoRoot });
    mkdirSync(join(repoRoot, "packages"));
  });

  afterEach((): void => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function track(path: string, content: string): string {
    const file: string = join(repoRoot, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    execFileSync("git", ["add", "--force", "--", path], { cwd: repoRoot });
    return file;
  }

  it("detects NUL in modified working-tree content, including newline filenames", (): void => {
    const file: string = track("packages/source\nfile.ts", "export {};\n");
    expect(nulSources(trackedSources(repoRoot))).toEqual([]);
    writeFileSync(file, "export {};\u0000\n");
    expect(nulSources(trackedSources(repoRoot))).toEqual([file]);
  });

  it("excludes untracked temporaries even when removed between enumeration and reading", (): void => {
    const file: string = track("packages/source.ts", "export {};\n");
    const temporary: string = join(repoRoot, "packages/temporary.json");
    writeFileSync(temporary, "\u0000");
    const files: string[] = trackedSources(repoRoot);
    expect(files).toEqual([file]);
    rmSync(temporary);
    expect(nulSources(files)).toEqual([]);
    expect(trackedSources(repoRoot)).toEqual([file]);
  });

  it("fails on missing tracked sources during enumeration and reading", (): void => {
    const file: string = track("packages/source.ts", "export {};\n");
    const files: string[] = trackedSources(repoRoot);
    rmSync(file);
    expect((): string[] => trackedSources(repoRoot)).toThrow(/ENOENT/);
    expect((): string[] => nulSources(files)).toThrow(/ENOENT/);
  });

  it("preserves source extensions, directory exclusions and symlink semantics", (): void => {
    const file: string = track("packages/source.ts", "export {};\n");
    track("outside.ts", "\u0000");
    track("packages/image.png", "\u0000");
    for (const dir of SKIP_DIRS) {
      if (dir !== ".git") track(`packages/${dir}/ignored.ts`, "\u0000");
    }
    symlinkSync("missing.ts", join(repoRoot, "packages/link.ts"));
    execFileSync("git", ["add", "--", "packages/link.ts"], { cwd: repoRoot });
    const nested: string = track("packages/nested/source.ts", "export {};\n");
    rmSync(dirname(nested), { recursive: true });
    symlinkSync("missing-dir", dirname(nested));
    expect(trackedSources(repoRoot)).toEqual([file]);
    expect(nulSources(trackedSources(repoRoot))).toEqual([]);
  });
});
