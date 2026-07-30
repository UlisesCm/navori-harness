import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NavoriConfigSchema, type NavoriConfig } from "../../lib/schema.ts";
import { hasBinary } from "../../lib/which.ts";
import { scanCodegraphHealth } from "../doctor.ts";

// The freshness / index-built checks gate on the `codegraph` binary being in
// PATH. Mock it so the git-hygiene tests are isolated from whatever is (or
// isn't) installed on the machine running the suite.
vi.mock("../../lib/which.ts", () => ({ hasBinary: vi.fn(() => false) }));

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), "navori-codegraph-doctor-"));
}

function gitInit(cwd: string): void {
  execFileSync("git", ["-C", cwd, "init", "-q"], { stdio: "ignore" });
}

function makeIndexDir(cwd: string): void {
  mkdirSync(join(cwd, ".codegraph"), { recursive: true });
  writeFileSync(join(cwd, ".codegraph/codegraph.db"), "binary\n");
}

function config(overrides: Partial<NavoriConfig> = {}): NavoriConfig {
  return NavoriConfigSchema.parse({
    name: "cg",
    engines: ["claude"],
    preset: "custom",
    branchBase: "main",
    qualityGate: { fast: "pnpm test", full: "pnpm test" },
    plugins: { codegraph: { enabled: true } },
    ...overrides,
  });
}

beforeEach(() => {
  vi.mocked(hasBinary).mockReturnValue(false); // binary absent by default
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("scanCodegraphHealth (Spec 0009 F2)", () => {
  it("returns null when the codegraph plugin is not enabled", () => {
    const cwd = tempRepo();
    expect(scanCodegraphHealth(cwd, config({ plugins: {} }))).toBeNull();
    expect(
      scanCodegraphHealth(cwd, config({ plugins: { codegraph: { enabled: false } } })),
    ).toBeNull();
  });

  it("flags '.codegraph/' when it is not gitignored (churning binary index)", () => {
    const cwd = tempRepo();
    gitInit(cwd);
    makeIndexDir(cwd); // present, but no .gitignore rule
    const health = scanCodegraphHealth(cwd, config());
    expect(health?.notIgnored).toBe(true);
    expect(health?.tracked).toBe(false);
  });

  it("passes when '.codegraph/' is gitignored", () => {
    const cwd = tempRepo();
    gitInit(cwd);
    writeFileSync(join(cwd, ".gitignore"), ".codegraph/\n");
    makeIndexDir(cwd);
    const health = scanCodegraphHealth(cwd, config());
    expect(health?.notIgnored).toBe(false);
    expect(health?.tracked).toBe(false);
  });

  it("flags '.codegraph/' when it is tracked by git (index was committed)", () => {
    const cwd = tempRepo();
    gitInit(cwd);
    makeIndexDir(cwd);
    execFileSync("git", ["-C", cwd, "add", ".codegraph/codegraph.db"], { stdio: "ignore" });
    const health = scanCodegraphHealth(cwd, config());
    expect(health?.tracked).toBe(true);
    // A tracked path outranks the not-ignored warning (mutually exclusive).
    expect(health?.notIgnored).toBe(false);
  });

  it("does not flag git hygiene outside a git work tree (no repo ⇒ no exposure)", () => {
    const cwd = tempRepo();
    makeIndexDir(cwd); // not a git repo
    const health = scanCodegraphHealth(cwd, config());
    expect(health?.notIgnored).toBe(false);
    expect(health?.tracked).toBe(false);
  });

  it("degrades gracefully when the codegraph binary is absent (no index/freshness noise)", () => {
    const cwd = tempRepo();
    gitInit(cwd);
    // binary mocked absent → index-built and freshness checks self-skip
    const health = scanCodegraphHealth(cwd, config());
    expect(health?.indexMissing).toBe(false);
    expect(health?.stale).toBe(false);
  });

  it("flags a missing index when the binary is present but '.codegraph/' was never built", () => {
    const cwd = tempRepo();
    gitInit(cwd);
    vi.mocked(hasBinary).mockReturnValue(true); // pretend codegraph is installed
    const health = scanCodegraphHealth(cwd, config()); // no makeIndexDir()
    expect(health?.indexMissing).toBe(true);
    // No index on disk ⇒ freshness is not probed.
    expect(health?.stale).toBe(false);
  });
});
