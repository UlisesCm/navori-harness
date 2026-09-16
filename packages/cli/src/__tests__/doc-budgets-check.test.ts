import { describe, it, expect, afterEach } from "vitest";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

/**
 * #815 — `pnpm check:doc-budgets` → `packages/cli/scripts/check-doc-budgets.mjs`.
 *
 * The script reads its own manifest via a path resolved relative to itself and
 * shells out to `git ls-files` in the real repo's managed dir (there is no
 * `--cwd`/`--repo` override, unlike `check-render.mjs`), so these tests run it
 * against a throwaway REPO whose layout mimics the pieces it reads: a git repo
 * with a manifest, a `CLAUDE.md`, and a `packages/core/core-assets/managed/`
 * tree — a copy of the real script per fixture, since the script hardcodes its
 * own `..`-relative REPO_ROOT and MANIFEST_PATH from `import.meta.url`.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REAL_SCRIPT = resolve(__dirname, "..", "..", "scripts", "check-doc-budgets.mjs");

interface RunResult {
  status: number;
  combined: string;
}

function run(args: string[], cwd: string): RunResult {
  const script = join(cwd, "packages/cli/scripts/check-doc-budgets.mjs");
  const r = spawnSync("node", [script, ...args], { encoding: "utf-8", cwd });
  return {
    status: r.status ?? -1,
    combined: (r.stdout ?? "") + (r.stderr ?? ""),
  };
}

let dirs: string[] = [];

/** Build a throwaway repo shaped like the pieces this script reads. */
function seedRepo(manifest: Record<string, number>): string {
  const repo = mkdtempSync(join(tmpdir(), "navori-doc-budgets-"));
  dirs.push(repo);

  mkdirSync(join(repo, "packages/cli/scripts"), { recursive: true });
  mkdirSync(join(repo, "packages/core/core-assets/managed"), { recursive: true });

  // The real script, copied verbatim so REPO_ROOT/MANIFEST_PATH resolve inside
  // the fixture instead of the real navori-harness checkout.
  const scriptSrc = readFileSync(REAL_SCRIPT, "utf-8");
  writeFileSync(join(repo, "packages/cli/scripts/check-doc-budgets.mjs"), scriptSrc);
  writeFileSync(
    join(repo, "packages/cli/scripts/doc-budgets.manifest.json"),
    JSON.stringify(manifest, null, 2),
  );

  writeFileSync(join(repo, "CLAUDE.md"), "one two three four five\n");
  writeFileSync(join(repo, "packages/core/core-assets/managed/foo.md"), "alpha beta gamma\n");

  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-qm", "seed"], {
    cwd: repo,
  });
  return repo;
}

describe("check-doc-budgets (#815)", () => {
  afterEach(() => {
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
    dirs = [];
  });

  it("exits 0 when every budgeted file is within its ceiling", () => {
    const repo = seedRepo({
      "CLAUDE.md": 10,
      "packages/core/core-assets/managed/foo.md": 10,
    });
    const result = run([], repo);
    expect(result.status).toBe(0);
    expect(result.combined).toContain("within their word ceiling");
  });

  it("fails when a budgeted file exceeds its word ceiling", () => {
    const repo = seedRepo({
      "CLAUDE.md": 2, // "one two three four five" is 5 words > 2
      "packages/core/core-assets/managed/foo.md": 10,
    });
    const result = run([], repo);
    expect(result.status).toBe(1);
    expect(result.combined).toContain("over their word ceiling");
    expect(result.combined).toContain("CLAUDE.md: 5 words > 2 ceiling");
  });

  it("fails when a budgeted file no longer exists, naming the manifest to fix", () => {
    const repo = seedRepo({
      "CLAUDE.md": 10,
      "packages/core/core-assets/managed/foo.md": 10,
      "packages/core/core-assets/managed/ghost.md": 10,
    });
    const result = run([], repo);
    expect(result.status).toBe(1);
    expect(result.combined).toContain("no longer exist");
    expect(result.combined).toContain("packages/core/core-assets/managed/ghost.md");
    expect(result.combined).toContain("update packages/cli/scripts/doc-budgets.manifest.json");
  });

  it("fails when a managed .md exists but is missing from the manifest", () => {
    const repo = seedRepo({
      "CLAUDE.md": 10,
      // "foo.md" intentionally omitted
    });
    const result = run([], repo);
    expect(result.status).toBe(1);
    expect(result.combined).toContain("missing from the manifest");
    expect(result.combined).toContain("packages/core/core-assets/managed/foo.md");
  });

  it("--list prints words/ceiling/margin per file and exits 0, even over budget", () => {
    const repo = seedRepo({
      "CLAUDE.md": 2,
      "packages/core/core-assets/managed/foo.md": 10,
    });
    const result = run(["--list"], repo);
    expect(result.status).toBe(0);
    expect(result.combined).toContain("CLAUDE.md: 5/2 words (margin -3)");
    expect(result.combined).toContain(
      "packages/core/core-assets/managed/foo.md: 3/10 words (margin 7)",
    );
  });
});
