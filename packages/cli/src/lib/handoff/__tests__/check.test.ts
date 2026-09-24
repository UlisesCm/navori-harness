// Covers: R13, R14, R15, R16, R24
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkHandoff, handoffExitCode, type HandoffCheckResult } from "../check.ts";
import { REQUIRED_IMPL_KEYS } from "../schema.ts";

const workspaces: string[] = [];
afterEach(() =>
  workspaces.splice(0).forEach((path) => rmSync(path, { force: true, recursive: true })),
);

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A throwaway git repo, used as both the `--cwd` checkout and the
 * `worktree` a handoff registers, unless a test says otherwise. */
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "navori-handoff-"));
  workspaces.push(root);
  git(root, "init", "-b", "feat/demo");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  writeFileSync(join(root, "base.txt"), "base\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "base");
  return root;
}

interface HandoffFixture {
  feature: string;
  status: "DONE" | "BLOCKED";
  worktree: string;
  branch: string;
  commits: string[];
  filesTouched: string[];
  verification: { command: string; exitCode: number; summary: string };
  markdownRequests: Array<{ path: string; intent: string; evidence: string }>;
  head?: string;
}

function validHandoff(cwd: string, overrides: Partial<HandoffFixture> = {}): HandoffFixture {
  return {
    feature: "demo",
    status: "DONE",
    worktree: cwd,
    branch: "feat/demo",
    commits: [git(cwd, "rev-parse", "HEAD")],
    filesTouched: ["src/demo.ts"],
    verification: { command: "bun lint", exitCode: 0, summary: "0 errors" },
    markdownRequests: [],
    head: git(cwd, "rev-parse", "HEAD"),
    ...overrides,
  };
}

function writeHandoff(cwd: string, dir: string, feature: string, data: unknown): void {
  mkdirSync(join(cwd, dir), { recursive: true });
  writeFileSync(join(cwd, dir, `impl_${feature}.json`), JSON.stringify(data, null, 2));
}

describe("checkHandoff — exists / parse / feature (R14, R15)", () => {
  it("fails 'exists' when impl_<feature>.json is absent", () => {
    const cwd = repo();
    const result = checkHandoff({
      cwd,
      dir: ".claude/progress",
      feature: "demo",
      consumer: "orchestrator",
    });
    expect(result.status).toBe("findings");
    expect(handoffExitCode(result)).toBe(2);
    expect(result.failures.map((f) => f.check)).toContain("exists");
  });

  it("fails 'parse' on invalid JSON", () => {
    const cwd = repo();
    mkdirSync(join(cwd, ".claude/progress"), { recursive: true });
    writeFileSync(join(cwd, ".claude/progress/impl_demo.json"), "{not json");
    const result = checkHandoff({
      cwd,
      dir: ".claude/progress",
      feature: "demo",
      consumer: "orchestrator",
    });
    expect(result.status).toBe("findings");
    expect(result.failures.map((f) => f.check)).toContain("parse");
  });

  it("fails 'parse' when a required key is missing", () => {
    const cwd = repo();
    const { verification: _verification, ...data } = validHandoff(cwd);
    writeHandoff(cwd, ".claude/progress", "demo", data);
    const result = checkHandoff({
      cwd,
      dir: ".claude/progress",
      feature: "demo",
      consumer: "orchestrator",
    });
    expect(result.status).toBe("findings");
    expect(result.failures.map((f) => f.check)).toContain("parse");
  });

  it("fails 'feature' when impl_<other>.json belongs to a different feature", () => {
    const cwd = repo();
    writeHandoff(cwd, ".claude/progress", "other", validHandoff(cwd, { feature: "other" }));
    // Asking for "demo" never opens impl_other.json — it must be reported absent.
    const result = checkHandoff({
      cwd,
      dir: ".claude/progress",
      feature: "demo",
      consumer: "orchestrator",
    });
    expect(result.failures.map((f) => f.check)).toContain("exists");
  });

  it("fails 'feature' when impl_<feature>.json's own field disagrees with the requested feature", () => {
    const cwd = repo();
    writeHandoff(cwd, ".claude/progress", "demo", validHandoff(cwd, { feature: "not-demo" }));
    const result = checkHandoff({
      cwd,
      dir: ".claude/progress",
      feature: "demo",
      consumer: "orchestrator",
    });
    expect(result.status).toBe("findings");
    expect(result.failures.map((f) => f.check)).toContain("feature");
  });

  it("passes with a valid handoff and no warnings when head matches HEAD", () => {
    const cwd = repo();
    writeHandoff(cwd, ".claude/progress", "demo", validHandoff(cwd));
    const result = checkHandoff({
      cwd,
      dir: ".claude/progress",
      feature: "demo",
      consumer: "orchestrator",
    });
    expect(result.status).toBe("ok");
    expect(handoffExitCode(result)).toBe(0);
    expect(result.warnings).toEqual([]);
  });
});

describe("checkHandoff — head (R13)", () => {
  it("warns, but stays ok, when head is missing", () => {
    const cwd = repo();
    const { head: _head, ...data } = validHandoff(cwd);
    writeHandoff(cwd, ".claude/progress", "demo", data);
    const result = checkHandoff({
      cwd,
      dir: ".claude/progress",
      feature: "demo",
      consumer: "orchestrator",
    });
    expect(result.status).toBe("ok");
    expect(result.warnings.map((w) => w.check)).toContain("head");
  });

  it("warns when head differs from the checkout's current HEAD", () => {
    const cwd = repo();
    writeHandoff(cwd, ".claude/progress", "demo", validHandoff(cwd, { head: "a".repeat(40) }));
    const result = checkHandoff({
      cwd,
      dir: ".claude/progress",
      feature: "demo",
      consumer: "orchestrator",
    });
    expect(result.status).toBe("ok");
    expect(result.warnings.map((w) => w.check)).toContain("head");
  });
});

describe("checkHandoff — scribe identity (R16)", () => {
  it("fails 'worktree' when --cwd is a different checkout than the one registered", () => {
    const registered = repo();
    const other = repo();
    // The handoff claims `registered` as its worktree, but the scribe runs
    // the check from `other` — a different checkout, same feature name.
    writeHandoff(other, ".claude/progress", "demo", validHandoff(registered));
    const result = checkHandoff({
      cwd: other,
      dir: ".claude/progress",
      feature: "demo",
      consumer: "scribe",
    });
    expect(result.status).toBe("findings");
    expect(result.failures.map((f) => f.check)).toContain("worktree");
  });

  it("fails 'branch' when --cwd is on a different branch", () => {
    const cwd = repo();
    writeHandoff(cwd, ".claude/progress", "demo", validHandoff(cwd, { branch: "other-branch" }));
    const result = checkHandoff({
      cwd,
      dir: ".claude/progress",
      feature: "demo",
      consumer: "scribe",
    });
    expect(result.status).toBe("findings");
    expect(result.failures.map((f) => f.check)).toContain("branch");
  });

  it("passes with matching worktree, branch and no markdownRequests", () => {
    const cwd = repo();
    writeHandoff(cwd, ".claude/progress", "demo", validHandoff(cwd));
    const result = checkHandoff({
      cwd,
      dir: ".claude/progress",
      feature: "demo",
      consumer: "scribe",
    });
    expect(result.status).toBe("ok");
    expect(typeof result.worktree).toBe("string");
    expect(result.branch).toBe("feat/demo");
  });

  it.each([
    ["/etc/passwd.md", "an absolute path"],
    ["../outside.md", "a .. segment"],
    [".claude/progress/impl_demo.md", "a session/handoff state path"],
    ["docs/note.txt", "the wrong extension"],
  ])("fails 'path' for %s (%s)", (badPath) => {
    const cwd = repo();
    writeHandoff(
      cwd,
      ".claude/progress",
      "demo",
      validHandoff(cwd, {
        markdownRequests: [{ path: badPath, intent: "x", evidence: "y" }],
      }),
    );
    const result = checkHandoff({
      cwd,
      dir: ".claude/progress",
      feature: "demo",
      consumer: "scribe",
    });
    expect(result.status).toBe("findings");
    expect(result.failures.map((f) => f.check)).toContain("path");
  });

  it("fails 'path' when a symlinked parent directory escapes the worktree", () => {
    const cwd = repo();
    const outside = mkdtempSync(join(tmpdir(), "navori-handoff-outside-"));
    workspaces.push(outside);
    mkdirSync(join(cwd, "docs"));
    symlinkSync(outside, join(cwd, "docs", "escape"));
    writeHandoff(
      cwd,
      ".claude/progress",
      "demo",
      validHandoff(cwd, {
        markdownRequests: [{ path: "docs/escape/note.md", intent: "x", evidence: "y" }],
      }),
    );
    const result = checkHandoff({
      cwd,
      dir: ".claude/progress",
      feature: "demo",
      consumer: "scribe",
    });
    expect(result.status).toBe("findings");
    expect(result.failures.map((f) => f.check)).toContain("path");
  });

  it("passes a relative markdownRequests path under the worktree", () => {
    const cwd = repo();
    mkdirSync(join(cwd, "docs"));
    writeHandoff(
      cwd,
      ".claude/progress",
      "demo",
      validHandoff(cwd, {
        markdownRequests: [{ path: "docs/note.md", intent: "x", evidence: "y" }],
      }),
    );
    const result = checkHandoff({
      cwd,
      dir: ".claude/progress",
      feature: "demo",
      consumer: "scribe",
    });
    expect(result.status).toBe("ok");
  });
});

describe("checkHandoff — scribeOwnsMarkdown: false validates the .md handoff (R24)", () => {
  it("fails 'exists' when impl_<feature>.md is absent", () => {
    const cwd = repo();
    const result = checkHandoff({
      cwd,
      dir: ".claude/progress",
      feature: "demo",
      consumer: "orchestrator",
      legacyMarkdown: true,
    });
    expect(result.status).toBe("findings");
    expect(result.warnings.map((w) => w.check)).toContain("legacy-md");
    expect(result.failures.map((f) => f.check)).toContain("exists");
  });

  it("fails when impl_<feature>.md is blank", () => {
    const cwd = repo();
    mkdirSync(join(cwd, ".claude/progress"), { recursive: true });
    writeFileSync(join(cwd, ".claude/progress/impl_demo.md"), "   \n");
    const result = checkHandoff({
      cwd,
      dir: ".claude/progress",
      feature: "demo",
      consumer: "orchestrator",
      legacyMarkdown: true,
    });
    expect(result.status).toBe("findings");
  });

  it("fails when impl_<feature>.md has no Status: line", () => {
    const cwd = repo();
    mkdirSync(join(cwd, ".claude/progress"), { recursive: true });
    writeFileSync(join(cwd, ".claude/progress/impl_demo.md"), "# Report\nAll good.\n");
    const result = checkHandoff({
      cwd,
      dir: ".claude/progress",
      feature: "demo",
      consumer: "orchestrator",
      legacyMarkdown: true,
    });
    expect(result.status).toBe("findings");
  });

  it("passes a well-formed impl_<feature>.md, still with the legacy-md warning", () => {
    const cwd = repo();
    mkdirSync(join(cwd, ".claude/progress"), { recursive: true });
    writeFileSync(join(cwd, ".claude/progress/impl_demo.md"), "Status: DONE\n");
    const result: HandoffCheckResult = checkHandoff({
      cwd,
      dir: ".claude/progress",
      feature: "demo",
      consumer: "orchestrator",
      legacyMarkdown: true,
    });
    expect(result.status).toBe("ok");
    expect(handoffExitCode(result)).toBe(0);
    expect(result.warnings.map((w) => w.check)).toContain("legacy-md");
  });
});

describe("REQUIRED_IMPL_KEYS", () => {
  it("has exactly the 8 keys the hook already required, no more", () => {
    expect([...REQUIRED_IMPL_KEYS].sort()).toEqual(
      [
        "feature",
        "status",
        "worktree",
        "branch",
        "commits",
        "filesTouched",
        "verification",
        "markdownRequests",
      ].sort(),
    );
  });
});
