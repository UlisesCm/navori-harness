import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkspaceConfigSchema,
  WorkspaceError,
  loadWorkspace,
  resolveWorkspaceUri,
  workspaceDirectory,
} from "../workspace.ts";

// findWorkspacesForPath (#1054) isolates HOME the same way workspace-link.test.ts
// does: safeHomedir mocked to a throwaway dir so tests never touch ~/.navori.
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock(import("../../primitives/home.ts"), () => ({ safeHomedir: () => home.dir }));

const { findWorkspacesForPath, writeWorkspace: writeWs } = await import("../workspace.ts");

describe("WorkspaceConfigSchema — ticketsDir security", () => {
  it("accepts a plain relative dir name", () => {
    const result = WorkspaceConfigSchema.safeParse({
      name: "bonum",
      ticketsDir: "tickets",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a nested relative path", () => {
    const result = WorkspaceConfigSchema.safeParse({
      name: "bonum",
      ticketsDir: "data/tickets",
    });
    expect(result.success).toBe(true);
  });

  it("rejects absolute paths", () => {
    const result = WorkspaceConfigSchema.safeParse({
      name: "bonum",
      ticketsDir: "/etc/passwd",
    });
    expect(result.success).toBe(false);
  });

  it("rejects '..' segments (path traversal)", () => {
    const result = WorkspaceConfigSchema.safeParse({
      name: "bonum",
      ticketsDir: "../../etc",
    });
    expect(result.success).toBe(false);
  });

  it("rejects mid-string '..' segments", () => {
    const result = WorkspaceConfigSchema.safeParse({
      name: "bonum",
      ticketsDir: "tickets/../etc",
    });
    expect(result.success).toBe(false);
  });

  it("rejects leading dot dirs", () => {
    const result = WorkspaceConfigSchema.safeParse({
      name: "bonum",
      ticketsDir: ".hidden",
    });
    // leading "." not alphanumeric — should fail regex
    expect(result.success).toBe(false);
  });

  it("rejects shell special characters", () => {
    const result = WorkspaceConfigSchema.safeParse({
      name: "bonum",
      ticketsDir: "tickets;rm -rf",
    });
    expect(result.success).toBe(false);
  });
});

describe("resolveWorkspaceUri — path traversal (#200)", () => {
  it("resolves a plain relative path inside the workspace", () => {
    const r = resolveWorkspaceUri("workspace://bonum/tickets/X.md");
    expect(r).not.toBeNull();
    expect(r?.workspaceName).toBe("bonum");
    expect(r?.absPath.endsWith("/bonum/tickets/X.md")).toBe(true);
  });

  it("rejects a `..` traversal in the relative path", () => {
    expect(resolveWorkspaceUri("workspace://bonum/../../etc/passwd")).toBeNull();
  });

  it("rejects a `..` traversal in the workspace name", () => {
    expect(resolveWorkspaceUri("workspace://../evil/file.md")).toBeNull();
  });

  it("returns null for a non-workspace scheme", () => {
    expect(resolveWorkspaceUri("file:///etc/passwd")).toBeNull();
  });
});

describe("workspaceDirectory / loadWorkspace — path traversal guard (#263)", () => {
  it("returns a path for a valid kebab-case name", () => {
    const dir = workspaceDirectory("bonum");
    expect(dir.endsWith("/workspaces/bonum")).toBe(true);
  });

  it("throws WorkspaceError for a `..` traversal name (never joins outside the root)", () => {
    expect(() => workspaceDirectory("../x")).toThrow(WorkspaceError);
    expect(() => workspaceDirectory("../../../outside/leg")).toThrow(WorkspaceError);
  });

  it("throws WorkspaceError for a name with a path separator", () => {
    expect(() => workspaceDirectory("a/b")).toThrow(WorkspaceError);
  });

  it("loadWorkspace refuses a traversal name before touching disk", () => {
    // The legacy-layout migration (mkdir/copy/rm) runs first inside loadWorkspace;
    // the guard must fire before any of that escapes ~/.navori/workspaces/.
    expect(() => loadWorkspace("../../../outside/leg")).toThrow(WorkspaceError);
  });
});

describe("findWorkspacesForPath (#1054)", () => {
  let repoDir: string;

  beforeEach(() => {
    home.dir = mkdtempSync(join(tmpdir(), "navori-home-"));
    repoDir = mkdtempSync(join(tmpdir(), "navori-repo-"));
  });
  afterEach(() => {
    rmSync(home.dir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  });

  // Covers: A1 (0 matches)
  it("returns an empty array when no workspace registers the path", () => {
    writeWs({ name: "bonum", ticketsDir: "tickets", defaults: {}, repos: [] });

    expect(findWorkspacesForPath(repoDir)).toEqual([]);
  });

  // Covers: A1 (1 match)
  it("returns the single workspace that registers the path", () => {
    writeWs({
      name: "bonum",
      ticketsDir: "tickets",
      defaults: {},
      repos: [{ name: "webapp", path: repoDir }],
    });

    expect(findWorkspacesForPath(repoDir)).toEqual(["bonum"]);
  });

  // Covers: A1 (2+ matches, ambiguous)
  it("returns every workspace when the path is registered in more than one", () => {
    writeWs({
      name: "bonum",
      ticketsDir: "tickets",
      defaults: {},
      repos: [{ name: "webapp", path: repoDir }],
    });
    writeWs({
      name: "personal",
      ticketsDir: "tickets",
      defaults: {},
      repos: [{ name: "webapp", path: repoDir }],
    });

    expect(findWorkspacesForPath(repoDir)).toEqual(["bonum", "personal"]);
  });

  // Covers: A1 (canonicalPath normalization — trailing slash)
  it("matches a registered path even when queried with a trailing slash", () => {
    writeWs({
      name: "bonum",
      ticketsDir: "tickets",
      defaults: {},
      repos: [{ name: "webapp", path: repoDir }],
    });

    expect(findWorkspacesForPath(`${repoDir}/`)).toEqual(["bonum"]);
  });

  // Covers: A1 (canonicalPath normalization — symlink)
  it("matches a registered path even when queried through a symlink", () => {
    writeWs({
      name: "bonum",
      ticketsDir: "tickets",
      defaults: {},
      repos: [{ name: "webapp", path: repoDir }],
    });
    const linkPath = join(tmpdir(), `navori-link-${Date.now()}`);
    symlinkSync(repoDir, linkPath);
    try {
      expect(findWorkspacesForPath(linkPath)).toEqual(["bonum"]);
    } finally {
      rmSync(linkPath, { force: true });
    }
  });

  // Covers: A1 (a corrupted, unrelated workspace must not crash the scan — review #1054)
  it("skips a corrupted workspace manifest and still returns the valid match", () => {
    writeWs({
      name: "bonum",
      ticketsDir: "tickets",
      defaults: {},
      repos: [{ name: "webapp", path: repoDir }],
    });
    // "broken" has nothing to do with repoDir and its manifest fails schema
    // validation — loadWorkspace throws WorkspaceError for it, which must not
    // abort the scan of the other, unrelated, valid workspaces.
    const brokenDir = join(home.dir, ".navori", "workspaces", "broken");
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(join(brokenDir, "workspace.json"), JSON.stringify({ name: "not-kebab_ok!" }));

    expect(findWorkspacesForPath(repoDir)).toEqual(["bonum"]);
  });
});
