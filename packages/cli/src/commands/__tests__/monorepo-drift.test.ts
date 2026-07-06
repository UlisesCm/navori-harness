import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanMonorepoDrift } from "../doctor.ts";
import type { NavoriConfig } from "../../lib/config.ts";

/**
 * doctor's monorepo drift check (#70): a config with workspaces:[] or one that
 * drifted from disk used to show "all good" while the apps got no harness.
 */

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-mdrift-"));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

function makeWorkspace(rel: string, name: string): void {
  mkdirSync(join(cwd, rel), { recursive: true });
  writeFileSync(join(cwd, rel, "package.json"), JSON.stringify({ name }));
}

function config(workspaces: Array<{ name: string; path: string }>): NavoriConfig {
  return { monorepo: { enabled: true, tool: "pnpm", workspaces } } as unknown as NavoriConfig;
}

describe("scanMonorepoDrift", () => {
  it("returns null when the config has no monorepo", () => {
    expect(scanMonorepoDrift(cwd, {} as NavoriConfig)).toBeNull();
  });

  it("flags emptyDeclared + added when workspaces[] is empty but apps exist on disk", () => {
    writeFileSync(join(cwd, "pnpm-workspace.yaml"), "packages:\n  - 'apps/*'\n");
    makeWorkspace("apps/backend", "backend");
    makeWorkspace("apps/store", "store");

    const drift = scanMonorepoDrift(cwd, config([]));
    expect(drift?.emptyDeclared).toBe(true);
    expect(drift?.added.sort()).toEqual(["apps/backend", "apps/store"]);
    expect(drift?.orphan).toEqual([]);
  });

  it("flags an orphan config workspace whose dir is gone", () => {
    writeFileSync(join(cwd, "pnpm-workspace.yaml"), "packages:\n  - 'apps/*'\n");
    makeWorkspace("apps/backend", "backend");

    const drift = scanMonorepoDrift(cwd, config([
      { name: "backend", path: "apps/backend" },
      { name: "ghost", path: "apps/ghost" },
    ]));
    expect(drift?.orphan).toEqual(["apps/ghost"]);
    expect(drift?.added).toEqual([]);
    expect(drift?.emptyDeclared).toBe(false);
  });

  it("is clean when config matches disk", () => {
    writeFileSync(join(cwd, "pnpm-workspace.yaml"), "packages:\n  - 'apps/*'\n");
    makeWorkspace("apps/backend", "backend");

    const drift = scanMonorepoDrift(cwd, config([{ name: "backend", path: "apps/backend" }]));
    expect(drift?.added).toEqual([]);
    expect(drift?.orphan).toEqual([]);
    expect(drift?.emptyDeclared).toBe(false);
  });
});
