import { describe, it, expect } from "vitest";
import { WorkspaceConfigSchema } from "../workspace.ts";

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
