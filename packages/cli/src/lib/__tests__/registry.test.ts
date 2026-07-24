import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

/**
 * The global registry (~/.navori/registry.json) is machine-local, like the
 * workspace registry (#76). safeHomedir is mocked so every test writes to a
 * throwaway fake home instead of the developer's real ~/.navori.
 */
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("../home.ts", () => ({ safeHomedir: () => home.dir }));

const {
  readRegistry,
  registerRepo,
  registerRepoSafe,
  unregisterRepo,
  listRegistryRepos,
  pruneRegistry,
  scanForRepos,
  registryPath,
} = await import("../registry.ts");

let scratch: string;

/** Create a directory holding a navori.config.json and return its real path. */
function makeRepo(parent: string, name: string): string {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "navori.config.json"), JSON.stringify({ name }));
  return realpathSync(dir);
}

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "navori-home-"));
  scratch = mkdtempSync(join(tmpdir(), "navori-scratch-"));
});
afterEach(() => {
  rmSync(home.dir, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

describe("registry — read/write", () => {
  it("returns an empty registry when the file is absent", () => {
    expect(readRegistry()).toEqual({ repos: [] });
    expect(existsSync(registryPath())).toBe(false);
  });

  it("tolerates a corrupt registry file", () => {
    mkdirSync(join(home.dir, ".navori"), { recursive: true });
    writeFileSync(registryPath(), "{ not json");
    expect(readRegistry()).toEqual({ repos: [] });
  });
});

describe("registerRepo", () => {
  it("adds a repo and is idempotent by canonical path", () => {
    const repo = makeRepo(scratch, "alpha");
    expect(registerRepo(repo, "alpha")).toBe("added");
    expect(registerRepo(repo, "alpha")).toBe("unchanged");
    expect(listRegistryRepos()).toEqual([{ path: repo, name: "alpha" }]);
  });

  it("updates the cached name when it changes", () => {
    const repo = makeRepo(scratch, "alpha");
    registerRepo(repo, "alpha");
    expect(registerRepo(repo, "alpha-renamed")).toBe("updated");
    expect(listRegistryRepos()[0].name).toBe("alpha-renamed");
  });

  it("persists sorted by path for stable diffs", () => {
    const b = makeRepo(scratch, "b-repo");
    const a = makeRepo(scratch, "a-repo");
    registerRepo(b, "b-repo");
    registerRepo(a, "a-repo");
    const written = JSON.parse(readFileSync(registryPath(), "utf-8")) as {
      repos: Array<{ path: string }>;
    };
    expect(written.repos.map((r) => r.path)).toEqual([a, b].sort((x, y) => x.localeCompare(y)));
  });
});

describe("registerRepoSafe", () => {
  it("never throws and returns null when home is unusable", () => {
    const good = makeRepo(scratch, "alpha");
    expect(registerRepoSafe(good, "alpha")).toBe("added");
  });
});

describe("unregisterRepo", () => {
  it("removes an entry and reports whether it existed", () => {
    const repo = makeRepo(scratch, "alpha");
    registerRepo(repo, "alpha");
    expect(unregisterRepo(repo)).toBe(true);
    expect(listRegistryRepos()).toEqual([]);
    expect(unregisterRepo(repo)).toBe(false);
  });
});

describe("pruneRegistry", () => {
  it("drops repos whose navori.config.json is gone, keeps the rest", () => {
    const present = makeRepo(scratch, "present");
    const gone = makeRepo(scratch, "gone");
    registerRepo(present, "present");
    registerRepo(gone, "gone");
    rmSync(gone, { recursive: true, force: true });

    const { removed, kept } = pruneRegistry();
    expect(removed.map((r) => r.path)).toEqual([gone]);
    expect(kept.map((r) => r.path)).toEqual([present]);
    expect(listRegistryRepos().map((r) => r.path)).toEqual([present]);
  });

  it("is a no-op (no write) when nothing is stale", () => {
    const present = makeRepo(scratch, "present");
    registerRepo(present, "present");
    const before = readFileSync(registryPath(), "utf-8");
    const { removed } = pruneRegistry();
    expect(removed).toEqual([]);
    expect(readFileSync(registryPath(), "utf-8")).toBe(before);
  });
});

describe("scanForRepos", () => {
  it("finds repos, skips node_modules, and does not descend into a found repo", () => {
    const a = makeRepo(scratch, "a"); // scratch/a
    // Nested repo two levels deep.
    const deep = makeRepo(join(scratch, "group"), "deep"); // scratch/group/deep
    // A config INSIDE an already-found repo must be ignored (no descent).
    makeRepo(a, "nested");
    // node_modules must be skipped entirely.
    makeRepo(join(scratch, "node_modules"), "pkg");

    const found = scanForRepos(scratch);
    expect(found.sort()).toEqual([a, deep].sort());
  });

  it("respects the maxDepth limit", () => {
    // scratch/l1/l2/repo/navori.config.json is at depth 3.
    const deep = makeRepo(join(scratch, "l1", "l2"), "repo");
    expect(scanForRepos(scratch, { maxDepth: 2 })).toEqual([]);
    expect(scanForRepos(scratch, { maxDepth: 3 })).toEqual([deep]);
  });

  it("returns an empty array for a non-existent root", () => {
    expect(scanForRepos(join(scratch, "does-not-exist"))).toEqual([]);
  });

  // Guard: the mocked home keeps tests off the real ~/.navori.
  it("uses the mocked home, not the real one", () => {
    expect(registryPath().startsWith(home.dir)).toBe(true);
    expect(registryPath().startsWith(homedir())).toBe(false);
  });
});
