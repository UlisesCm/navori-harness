import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NavoriConfig } from "../../lib/config/config.ts";

/**
 * doctor's workspace-link check (#76): `workspace` in navori.config.json is
 * checked in and travels with the repo, but the registry it points at
 * (~/.navori/workspaces/) is machine-local. A teammate's clone used to get a
 * dangling reference (or another machine's paths) with zero feedback.
 * safeHomedir is mocked so the registry lives in a throwaway fake home.
 */

const home = vi.hoisted(() => ({ dir: "" }));
vi.mock(import("../../lib/primitives/home.ts"), () => ({ safeHomedir: () => home.dir }));

const { scanWorkspaceLink, scanWorkspaceDeadRepos } = await import("../doctor.ts");
const { writeWorkspace } = await import("../../lib/workspace/workspace.ts");

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

// Covers: #1269
describe("scanWorkspaceLink without a declared workspace (#1269)", () => {
  it("flags the repo registered by name under a stale path", () => {
    writeWorkspace({
      name: "bonum",
      ticketsDir: "tickets",
      defaults: {},
      repos: [{ name: "webapp", path: "/old/parent/webapp" }],
    });
    expect(scanWorkspaceLink(repoDir, config({ workspace: undefined }))).toEqual({
      kind: "undeclared-path-mismatch",
      workspace: "bonum",
      repoName: "webapp",
      registeredPath: "/old/parent/webapp",
    });
  });

  it("stays quiet when the registered path is this checkout or the name is unknown", () => {
    writeWorkspace({
      name: "bonum",
      ticketsDir: "tickets",
      defaults: {},
      repos: [{ name: "webapp", path: repoDir }],
    });
    writeWorkspace({
      name: "other",
      ticketsDir: "tickets",
      defaults: {},
      repos: [{ name: "api", path: "/old/api" }],
    });
    expect(scanWorkspaceLink(repoDir, config({ workspace: undefined }))).toBeNull();
  });

  it("skips an invalid manifest instead of throwing", () => {
    writeWorkspace({ name: "bonum", ticketsDir: "tickets", defaults: {}, repos: [] });
    writeFileSync(join(home.dir, ".navori", "workspaces", "bonum", "workspace.json"), "{nope");
    expect(scanWorkspaceLink(repoDir, config({ workspace: undefined }))).toBeNull();
  });
});

// Covers: #1269
describe("scanWorkspaceDeadRepos (#1269)", () => {
  it("lists the other repos whose registered path does not exist", () => {
    writeWorkspace({
      name: "bonum",
      ticketsDir: "tickets",
      defaults: {},
      repos: [
        { name: "webapp", path: repoDir },
        { name: "api", path: "/old/parent/api" },
        { name: "dashboard", path: "/old/parent/dashboard" },
      ],
    });
    expect(scanWorkspaceDeadRepos(repoDir, config({ workspace: undefined }))).toEqual([
      {
        workspace: "bonum",
        repos: [
          { name: "api", path: "/old/parent/api" },
          { name: "dashboard", path: "/old/parent/dashboard" },
        ],
      },
    ]);
  });

  it("returns [] for a healthy workspace and ignores workspaces the repo is not in", () => {
    writeWorkspace({
      name: "bonum",
      ticketsDir: "tickets",
      defaults: {},
      repos: [
        { name: "webapp", path: repoDir },
        { name: "api", path: tmpdir() },
      ],
    });
    writeWorkspace({
      name: "unrelated",
      ticketsDir: "tickets",
      defaults: {},
      repos: [{ name: "x", path: "/gone/x" }],
    });
    expect(scanWorkspaceDeadRepos(repoDir, config())).toEqual([]);
  });
});
