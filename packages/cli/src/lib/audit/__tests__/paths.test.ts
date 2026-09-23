import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { rangeReportDir, repoFromCwd, sessionReportDir } from "../paths.ts";
import { NavoriError } from "../../primitives/errors.ts";

/**
 * The report directories compose a filesystem path out of an OPAQUE HOST TOKEN
 * (Claude Code's session id) and a date. That is the same shape of input that
 * produced #503, where an unvalidated id wrote outside the audit root — so the
 * guard is re-asserted here rather than assumed from the log path's copy.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "navori-audit-paths-"));
  process.env.NAVORI_AUDITS_ROOT = root;
});

afterEach(() => {
  process.env.NAVORI_AUDITS_ROOT = undefined;
  rmSync(root, { recursive: true, force: true });
});

describe("sessionReportDir (#0013, R15)", () => {
  // Covers: R15
  it("stays under the audit root for a valid id", () => {
    const dir = sessionReportDir("demo", "2026-08-25", "a6260e0b-e88c-48b2");
    expect(dir.startsWith(join(root, "demo"))).toBe(true);
    // Short id: the directory is for a human to open and the date already
    // disambiguates; the full id lives inside the log's `start` event.
    expect(dir.endsWith("2026-08-25-a6260e0b")).toBe(true);
  });

  // Covers: R15
  it.each([["a/../../escaped"], ["../climb"], ["with space"], [""]])(
    "rejects a path-shaped session id (%s)",
    (id) => {
      expect(() => sessionReportDir("demo", "2026-08-25", id)).toThrow(NavoriError);
    },
  );

  // Covers: R15
  it("rejects a day that is not YYYY-MM-DD", () => {
    // An empty range (a session whose transcript carried no timestamps) would
    // otherwise compose a nameless directory, and `..` would climb out of it.
    for (const day of ["", "..", "2026-8-5", "2026-08-25/x"]) {
      expect(() => sessionReportDir("demo", day, "sess1")).toThrow(NavoriError);
    }
  });
});

describe("rangeReportDir (#0013, R16)", () => {
  // Covers: R16
  it("composes <from>--<to> under the audit root", () => {
    const dir = rangeReportDir("demo", "2026-08-25", "2026-08-28");
    expect(dir).toBe(join(root, "demo", "ranges", "2026-08-25--2026-08-28"));
  });

  // Covers: R16
  it("rejects a malformed day on either end", () => {
    expect(() => rangeReportDir("demo", "..", "2026-08-28")).toThrow(NavoriError);
    expect(() => rangeReportDir("demo", "2026-08-25", "")).toThrow(NavoriError);
  });
});

describe("repoFromCwd (#764)", () => {
  it("derives the basename of a standard repo cwd", () => {
    expect(repoFromCwd("/Users/u/dev/navori-harness")).toBe("navori-harness");
  });

  it("truncates at /.claude/worktrees for agent worktree cwd", () => {
    expect(
      repoFromCwd("/Users/u/dev/navori-harness/.claude/worktrees/agent-a2a999b59fde9ce6c"),
    ).toBe("navori-harness");
  });

  it("truncates at /.claude/worktrees for subdirectories inside an agent worktree", () => {
    expect(
      repoFromCwd(
        "/Users/u/dev/navori-harness/.claude/worktrees/agent-a2a999b59fde9ce6c/packages/cli",
      ),
    ).toBe("navori-harness");
  });

  it("handles the .claude/worktrees root itself", () => {
    expect(repoFromCwd("/Users/u/dev/navori-harness/.claude/worktrees")).toBe("navori-harness");
  });

  it("does not truncate a directory that merely starts with worktrees", () => {
    expect(repoFromCwd("/Users/u/dev/navori-harness/.claude/worktrees-backup")).toBe(
      "worktrees-backup",
    );
  });
});

/**
 * #897: a session opened with `cwd` in a subdirectory of the project (e.g.
 * `packages/cli`) must attribute to the project root, not to the
 * subdirectory's own basename. These use REAL fixture directories (not the
 * fake `/Users/u/...` paths above) so `findProjectRoot`'s `existsSync` walk
 * has real markers to find.
 */
describe("repoFromCwd — project root resolution (#897)", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "navori-repo-root-"));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("attributes a cwd at the project root itself", () => {
    writeFileSync(join(projectDir, "navori.config.json"), "{}");
    expect(repoFromCwd(projectDir)).toBe(basename(projectDir));
  });

  it("attributes a cwd in a nested subdirectory to the project root (navori.config.json marker)", () => {
    writeFileSync(join(projectDir, "navori.config.json"), "{}");
    const nested = join(projectDir, "packages", "cli");
    mkdirSync(nested, { recursive: true });
    expect(repoFromCwd(nested)).toBe(basename(projectDir));
  });

  it("attributes a cwd in a nested subdirectory to the project root (.git marker, dir form)", () => {
    mkdirSync(join(projectDir, ".git"));
    const nested = join(projectDir, "packages", "cli");
    mkdirSync(nested, { recursive: true });
    expect(repoFromCwd(nested)).toBe(basename(projectDir));
  });

  it("attributes a cwd in a nested subdirectory to the project root (.git marker, file form — worktree checkout)", () => {
    // In a git worktree, .git is a file with a `gitdir:` pointer, not a directory.
    writeFileSync(join(projectDir, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
    const nested = join(projectDir, "packages", "cli");
    mkdirSync(nested, { recursive: true });
    expect(repoFromCwd(nested)).toBe(basename(projectDir));
  });

  it("truncates an agent worktree cwd first, then resolves the parent repo root (#764 regression)", () => {
    mkdirSync(join(projectDir, ".git"));
    const worktreeNested = join(
      projectDir,
      ".claude",
      "worktrees",
      "agent-a2a999b59fde9ce6c",
      "packages",
      "cli",
    );
    mkdirSync(worktreeNested, { recursive: true });
    expect(repoFromCwd(worktreeNested)).toBe(basename(projectDir));
  });

  it("falls back to the cwd basename when no project root marker is found", () => {
    const orphan = join(projectDir, "no-marker-here");
    mkdirSync(orphan, { recursive: true });
    expect(repoFromCwd(orphan)).toBe("no-marker-here");
  });
});
