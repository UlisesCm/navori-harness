import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

/**
 * `linkRepoToWorkspace` (#76): the workspace registry (~/.navori/workspaces/)
 * is machine-local and never travels with the repo, so a teammate cloning the
 * repos elsewhere rebuilds it with `navori workspace link`. safeHomedir is
 * mocked so every test runs against a throwaway fake home.
 */

const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("../home.ts", () => ({ safeHomedir: () => home.dir }));

const { linkRepoToWorkspace, resolveRepoPath, loadWorkspace, writeWorkspace, workspacePath, WorkspaceError } =
  await import("../workspace.ts");

let repoDir: string;

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "navori-home-"));
  repoDir = mkdtempSync(join(tmpdir(), "navori-repo-"));
});
afterEach(() => {
  rmSync(home.dir, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
});

describe("linkRepoToWorkspace", () => {
  it("creates the workspace when it does not exist and registers the repo", () => {
    const result = linkRepoToWorkspace("bonum", { name: "webapp", path: repoDir });

    expect(result.createdWorkspace).toBe(true);
    expect(result.action).toBe("added");
    expect(existsSync(workspacePath("bonum"))).toBe(true);

    const ws = loadWorkspace("bonum");
    expect(ws?.repos).toEqual([{ name: "webapp", path: repoDir }]);
  });

  it("adds the repo to an existing workspace without touching other entries", () => {
    writeWorkspace({
      name: "bonum",
      ticketsDir: "tickets",
      defaults: {},
      repos: [{ name: "nexus", path: "/somewhere/nexus" }],
    });

    const result = linkRepoToWorkspace("bonum", { name: "webapp", path: repoDir });

    expect(result.createdWorkspace).toBe(false);
    expect(result.action).toBe("added");
    const ws = loadWorkspace("bonum");
    expect(ws?.repos.map((r) => r.name).sort()).toEqual(["nexus", "webapp"]);
  });

  it("updates a stale path for an already-registered repo (teammate case)", () => {
    writeWorkspace({
      name: "bonum",
      ticketsDir: "tickets",
      defaults: {},
      repos: [{ name: "webapp", path: "/Users/someone-else/dev/webapp" }],
    });

    const result = linkRepoToWorkspace("bonum", { name: "webapp", path: repoDir });

    expect(result.action).toBe("updated-path");
    expect(result.previousPath).toBe("/Users/someone-else/dev/webapp");
    const ws = loadWorkspace("bonum");
    expect(ws?.repos).toEqual([{ name: "webapp", path: repoDir }]);
  });

  it("leaves no advisory lock file behind after linking (#82)", () => {
    linkRepoToWorkspace("bonum", { name: "webapp", path: repoDir });
    const wsRoot = join(home.dir, ".navori", "workspaces");
    const leftover = readdirSync(wsRoot).filter((e) => e.endsWith(".lock"));
    expect(leftover).toEqual([]);
  });

  it("is idempotent: linking twice is a no-op", () => {
    linkRepoToWorkspace("bonum", { name: "webapp", path: repoDir });
    const before = readFileSync(workspacePath("bonum"), "utf-8");

    const again = linkRepoToWorkspace("bonum", { name: "webapp", path: repoDir });

    expect(again.createdWorkspace).toBe(false);
    expect(again.action).toBe("unchanged");
    expect(readFileSync(workspacePath("bonum"), "utf-8")).toBe(before);
  });
});

describe("resolveRepoPath", () => {
  it("returns an absolute, symlink-resolved path for an existing dir", () => {
    const resolved = resolveRepoPath(repoDir);
    expect(isAbsolute(resolved)).toBe(true);
    expect(existsSync(resolved)).toBe(true);
  });

  it("throws a WorkspaceError for a path that does not exist", () => {
    expect(() => resolveRepoPath(join(repoDir, "ghost"))).toThrow(WorkspaceError);
  });
});
