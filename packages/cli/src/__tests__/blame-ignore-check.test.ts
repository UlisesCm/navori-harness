import { describe, it, expect, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * #1002 — the `.git-blame-ignore-revs` gate check (`scripts/js/check-blame-ignore.mjs`).
 *
 * Every entry must be BOTH an ancestor of `origin/main` (never the current
 * branch — a squash merge rewrites the SHA, see the script's own header) and
 * mechanical (no added/deleted file, every modified/renamed file normalizes
 * to identical content). These tests build throwaway git repos with a fake
 * `refs/remotes/origin/main` (`update-ref`, no real remote needed) instead of
 * exercising this repo's own history, which changes with every commit and
 * cannot exercise the failure paths on demand.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const SCRIPT = resolve(REPO_ROOT, "scripts", "js", "check-blame-ignore.mjs");

function git(repo: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-C",
      repo,
      "-c",
      "user.name=navori-test",
      "-c",
      "user.email=test@navori.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { encoding: "utf-8" },
  ).trim();
}

function write(repo: string, rel: string, content: string): void {
  writeFileSync(join(repo, rel), content, "utf-8");
}

function runCheck(repo: string) {
  // The script resolves its own repo root off `import.meta.url`, not off cwd
  // (see scripts/js/check-blame-ignore.mjs) — copy it into the fixture so
  // that resolution lands on the fixture repo, never on this real one.
  const script = join(repo, "scripts", "js", "check-blame-ignore.mjs");
  return spawnSync("node", [script], {
    encoding: "utf-8",
    cwd: repo,
    env: { ...process.env, NO_COLOR: "1" },
  });
}

/** Points `refs/remotes/origin/main` at `sha` without a real remote. */
function setOriginMain(repo: string, sha: string): void {
  git(repo, "update-ref", "refs/remotes/origin/main", sha);
}

function ignoreFile(repo: string, shas: string[]): void {
  write(repo, ".git-blame-ignore-revs", `# fixture\n${shas.join("\n")}\n`);
}

const fixtures: string[] = [];

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "navori-blameignore-"));
  fixtures.push(repo);
  git(repo, "init", "-q", "-b", "main");
  mkdirSync(join(repo, "scripts", "js"), { recursive: true });
  copyFileSync(SCRIPT, join(repo, "scripts", "js", "check-blame-ignore.mjs"));
  return repo;
}

afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("check-blame-ignore (#1002)", () => {
  it("zero entries is valid (pass)", () => {
    const repo = makeRepo();
    git(repo, "commit", "--allow-empty", "-qm", "base");
    setOriginMain(repo, git(repo, "rev-parse", "HEAD"));
    ignoreFile(repo, []);

    const { status, stdout } = runCheck(repo);

    expect(status).toBe(0);
    expect(stdout).toContain("zero entries");
  });

  it("no .git-blame-ignore-revs file is valid (pass)", () => {
    const repo = makeRepo();
    git(repo, "commit", "--allow-empty", "-qm", "base");
    setOriginMain(repo, git(repo, "rev-parse", "HEAD"));

    const { status, stdout } = runCheck(repo);

    expect(status).toBe(0);
    expect(stdout).toContain("nothing to validate");
  });

  it("fails loudly when origin/main cannot be resolved (no silent fallback)", () => {
    const repo = makeRepo();
    git(repo, "commit", "--allow-empty", "-qm", "base");
    ignoreFile(repo, [git(repo, "rev-parse", "HEAD")]);
    // No refs/remotes/origin/main set up on purpose.

    const { status, stderr } = runCheck(repo);

    expect(status).toBe(1);
    expect(stderr).toContain("origin/main could not be resolved");
  });

  it("ancestor pass: a SHA reachable from origin/main with an empty diff passes", () => {
    const repo = makeRepo();
    git(repo, "commit", "--allow-empty", "-qm", "base");
    git(repo, "commit", "--allow-empty", "-qm", "no-op");
    const sha = git(repo, "rev-parse", "HEAD");
    setOriginMain(repo, sha);
    ignoreFile(repo, [sha]);

    const { status, stdout } = runCheck(repo);

    expect(status).toBe(0);
    expect(stdout).toContain("1 checked");
  });

  it("non-ancestor fail: an orphan SHA never merged into origin/main fails", () => {
    const repo = makeRepo();
    write(repo, "a.txt", "base\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "base");
    const baseSha = git(repo, "rev-parse", "HEAD");
    setOriginMain(repo, baseSha);

    // A commit that exists as a git object but is not reachable from main.
    git(repo, "checkout", "-qb", "orphan-branch");
    write(repo, "a.txt", "base\nmore\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "orphan");
    const orphanSha = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "-q", "main");
    git(repo, "branch", "-D", "orphan-branch");

    ignoreFile(repo, [orphanSha]);

    const { status, stderr } = runCheck(repo);

    expect(status).toBe(1);
    expect(stderr).toContain(orphanSha);
    expect(stderr).toContain("not an ancestor of origin/main");
  });

  it("added/deleted file fail: an entry that adds a file is rejected", () => {
    const repo = makeRepo();
    write(repo, "a.txt", "base\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "base");
    write(repo, "b.txt", "new\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "adds a file");
    const sha = git(repo, "rev-parse", "HEAD");
    setOriginMain(repo, sha);
    ignoreFile(repo, [sha]);

    const { status, stderr } = runCheck(repo);

    expect(status).toBe(1);
    expect(stderr).toContain("added file b.txt");
  });

  it("added/deleted file fail: an entry that deletes a file is rejected", () => {
    const repo = makeRepo();
    write(repo, "a.txt", "base\n");
    write(repo, "b.txt", "new\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "base");
    execFileSync("git", ["-C", repo, "rm", "-q", "b.txt"]);
    git(repo, "commit", "-qm", "deletes a file");
    const sha = git(repo, "rev-parse", "HEAD");
    setOriginMain(repo, sha);
    ignoreFile(repo, [sha]);

    const { status, stderr } = runCheck(repo);

    expect(status).toBe(1);
    expect(stderr).toContain("deleted file b.txt");
  });

  it("pure reformat pass: whitespace/quote/comma-only rewrite normalizes equal", () => {
    const repo = makeRepo();
    write(repo, "a.mjs", "export function foo(a, b) {\n  return a + 'x';\n}\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "base");
    write(
      repo,
      "a.mjs",
      ["export function foo(", "  a,", "  b,", ") {", '  return a + "x";', "}", ""].join("\n"),
    );
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "reformat");
    const sha = git(repo, "rev-parse", "HEAD");
    setOriginMain(repo, sha);
    ignoreFile(repo, [sha]);

    const { status, stdout } = runCheck(repo);

    expect(status).toBe(0);
    expect(stdout).toContain("1 checked");
  });

  it("import-specifier-only change pass: a moved import path normalizes equal", () => {
    const repo = makeRepo();
    write(repo, "a.mjs", "import { foo } from './old-path.js';\nexport { foo };\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "base");
    write(repo, "a.mjs", "import { foo } from './new-path.js';\nexport { foo };\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "move import");
    const sha = git(repo, "rev-parse", "HEAD");
    setOriginMain(repo, sha);
    ignoreFile(repo, [sha]);

    const { status, stdout } = runCheck(repo);

    expect(status).toBe(0);
    expect(stdout).toContain("1 checked");
  });

  it("literal-string change fail: a rewritten string literal is not mechanical", () => {
    const repo = makeRepo();
    write(repo, "a.mjs", 'export const path = "../escape.md";\n');
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "base");
    write(repo, "a.mjs", 'export const path = "../../escape.md.ts";\n');
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "rewrites the literal");
    const sha = git(repo, "rev-parse", "HEAD");
    setOriginMain(repo, sha);
    ignoreFile(repo, [sha]);

    const { status, stderr } = runCheck(repo);

    expect(status).toBe(1);
    expect(stderr).toContain("non-mechanical change in a.mjs");
  });

  it("empty diff pass: a commit with no tree change never flags a file", () => {
    const repo = makeRepo();
    write(repo, "a.txt", "base\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "base");
    git(repo, "commit", "--allow-empty", "-qm", "no-op");
    const sha = git(repo, "rev-parse", "HEAD");
    setOriginMain(repo, sha);
    ignoreFile(repo, [sha]);

    const { status, stdout } = runCheck(repo);

    expect(status).toBe(0);
    expect(stdout).toContain("1 checked");
  });

  it('member call fail: `.from("a")` -> `.from("b")` is a real content change, not a specifier', () => {
    // A Supabase-style query builder call. `from` here is a method, never a
    // module specifier — the normalizer must not confuse the two, or a real
    // table-name rewrite would pass as mechanical.
    const repo = makeRepo();
    write(repo, "a.mjs", 'export const q = supabase.from("a").select("*");\n');
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "base");
    write(repo, "a.mjs", 'export const q = supabase.from("b").select("*");\n');
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "changes the table");
    const sha = git(repo, "rev-parse", "HEAD");
    setOriginMain(repo, sha);
    ignoreFile(repo, [sha]);

    const { status, stderr } = runCheck(repo);

    expect(status).toBe(1);
    expect(stderr).toContain("non-mechanical change in a.mjs");
  });

  it('multi-line import specifier change pass: the closing `} from "x"` line normalizes equal', () => {
    const repo = makeRepo();
    write(
      repo,
      "a.mjs",
      ["import {", "  foo,", "  bar,", '} from "./old-path.js";', "export { foo, bar };", ""].join(
        "\n",
      ),
    );
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "base");
    write(
      repo,
      "a.mjs",
      ["import {", "  foo,", "  bar,", '} from "./new-path.js";', "export { foo, bar };", ""].join(
        "\n",
      ),
    );
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "move multi-line import");
    const sha = git(repo, "rev-parse", "HEAD");
    setOriginMain(repo, sha);
    ignoreFile(repo, [sha]);

    const { status, stdout } = runCheck(repo);

    expect(status).toBe(0);
    expect(stdout).toContain("1 checked");
  });

  it("root commit (no parent) fails through fail(), never a raw stack trace", () => {
    const repo = makeRepo();
    write(repo, "a.txt", "base\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "root commit");
    const sha = git(repo, "rev-parse", "HEAD");
    setOriginMain(repo, sha);
    ignoreFile(repo, [sha]);

    const { status, stderr } = runCheck(repo);

    expect(status).toBe(1);
    expect(stderr).toContain(`${sha}: is a root commit with no parent`);
    expect(stderr).not.toContain("at Object"); // no raw Node stack trace
  });
});
