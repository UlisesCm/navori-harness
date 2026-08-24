import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
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
const SCAN_ROOT = join(REPO_ROOT, "packages");

/** Build output and installed deps are not versioned sources — skip them. */
const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", ".turbo", ".git"]);

/** Text sources a human reads in a diff. A real binary asset is not swept. */
const SOURCE_EXT = /\.(ts|tsx|js|mjs|cjs|json|md|sh|toml|ya?ml)$/;

function walk(dir: string, out: string[]): void {
  // `withFileTypes` classifies from the dirent the OS already returned: no
  // stat(2) per entry, and — unlike statSync — it never follows a symlink, so a
  // broken one under `packages/` is skipped instead of throwing ENOENT.
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), out);
    } else if (entry.isFile() && SOURCE_EXT.test(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
}

describe("no versioned source carries a raw NUL byte", () => {
  it("packages/** is grep-able and diff-able", () => {
    const files: string[] = [];
    walk(SCAN_ROOT, files);
    expect(files.length).toBeGreaterThan(100);

    const offenders = files
      .filter((f) => readFileSync(f).includes(0))
      .map((f) => `${relative(REPO_ROOT, f)} — write the NUL as a \\u0000 escape instead`);
    expect(offenders).toEqual([]);
  });
});
