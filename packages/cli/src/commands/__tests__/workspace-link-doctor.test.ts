import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NavoriConfig } from "../../lib/config.ts";

/**
 * doctor's workspace-link check (#76): `workspace` in navori.config.json is
 * checked in and travels with the repo, but the registry it points at
 * (~/.navori/workspaces/) is machine-local. A teammate's clone used to get a
 * dangling reference (or another machine's paths) with zero feedback.
 * safeHomedir is mocked so the registry lives in a throwaway fake home.
 */

const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("../../lib/home.ts", () => ({ safeHomedir: () => home.dir }));

const { scanWorkspaceLink } = await import("../doctor.ts");
const { writeWorkspace } = await import("../../lib/workspace.ts");

let repoDir: string;

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "navori-home-"));
  repoDir = mkdtempSync(join(tmpdir(), "navori-repo-"));
});
afterEach(() => {
  rmSync(home.dir, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
});

function config(overrides: Partial<NavoriConfig> = {}): NavoriConfig {
  return { name: "webapp", workspace: "bonum", ...overrides } as NavoriConfig;
}

describe("scanWorkspaceLink", () => {
  it("returns null when the config has no workspace", () => {
    expect(scanWorkspaceLink(repoDir, config({ workspace: undefined }))).toBeNull();
  });

  it("flags a dangling reference when the workspace does not exist locally", () => {
    expect(scanWorkspaceLink(repoDir, config())).toEqual({
      kind: "workspace-missing",
      workspace: "bonum",
    });
  });

  it("flags a repo missing from the workspace's repos[]", () => {
    writeWorkspace({ name: "bonum", ticketsDir: "tickets", defaults: {}, repos: [] });
    expect(scanWorkspaceLink(repoDir, config())).toEqual({
      kind: "repo-not-registered",
      workspace: "bonum",
    });
  });

  it("flags a path mismatch when the repo is registered with another machine's path", () => {
    writeWorkspace({
      name: "bonum",
      ticketsDir: "tickets",
      defaults: {},
      repos: [{ name: "webapp", path: "/Users/someone-else/dev/webapp" }],
    });
    expect(scanWorkspaceLink(repoDir, config())).toEqual({
      kind: "path-mismatch",
      workspace: "bonum",
      repoName: "webapp",
      registeredPath: "/Users/someone-else/dev/webapp",
    });
  });

  it("returns null when the repo is registered with the current path", () => {
    writeWorkspace({
      name: "bonum",
      ticketsDir: "tickets",
      defaults: {},
      repos: [{ name: "webapp", path: repoDir }],
    });
    expect(scanWorkspaceLink(repoDir, config())).toBeNull();
  });

  it("matches by path even when the entry has a different repo alias", () => {
    writeWorkspace({
      name: "bonum",
      ticketsDir: "tickets",
      defaults: {},
      repos: [{ name: "webapp-alias", path: repoDir }],
    });
    expect(scanWorkspaceLink(repoDir, config())).toBeNull();
  });
});
