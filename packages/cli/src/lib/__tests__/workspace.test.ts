import { describe, it, expect } from "vitest";
import {
  WorkspaceConfigSchema,
  WorkspaceError,
  loadWorkspace,
  resolveWorkspaceUri,
  workspaceDirectory,
} from "../workspace.ts";

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
