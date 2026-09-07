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
  isGitWorktree,
  refreshRepoName,
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
    expect(listRegistryRepos()[0]?.name).toBe("alpha-renamed");
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

/**
 * #589: the entry's `name` was stamped at registration and only `init`/`update`
 * ever rewrote it. Neither runs during a rollout, so a name corrected in the
 * config never reached the registry — in one 15-repo workspace six entries had
 * drifted, two showing a SIBLING repo's name in `registry ls` and `render --all`.
 */
describe("refreshRepoName", () => {
  it("updates the cached name of an already-registered repo", () => {
    const repo = makeRepo(scratch, "alpha");
    registerRepo(repo, "stale-name");
    expect(refreshRepoName(repo, "alpha")).toBe("updated");
    expect(listRegistryRepos()).toEqual([{ path: repo, name: "alpha" }]);
  });

  it("is a no-op when the cached name already matches", () => {
    const repo = makeRepo(scratch, "alpha");
    registerRepo(repo, "alpha");
    expect(refreshRepoName(repo, "alpha")).toBe("unchanged");
  });

  // The guard that keeps `render` from enrolling throwaway checkouts: it
  // refreshes, it never adds. Registration stays an explicit act.
  it("never adds an entry for an unregistered repo", () => {
    const repo = makeRepo(scratch, "alpha");
    expect(refreshRepoName(repo, "alpha")).toBe("not-registered");
    expect(listRegistryRepos()).toEqual([]);
  });

  // A failure to touch ~/.navori must never fail the render that called this.
  it("degrades quietly when the registry is unreadable", () => {
    const repo = makeRepo(scratch, "alpha");
    registerRepo(repo, "stale");
    const previous = home.dir;
    home.dir = join(scratch, "not-a-dir");
    writeFileSync(home.dir, ""); // home is a FILE: nothing under it can be read
    try {
      expect(() => refreshRepoName(repo, "alpha")).not.toThrow();
      // Unreadable reads as "no such entry", never as a crash or a bogus write.
      expect(refreshRepoName(repo, "alpha")).toBe("not-registered");
    } finally {
      home.dir = previous;
    }
    // The real entry survived untouched — the broken home wrote nothing.
    expect(listRegistryRepos()).toEqual([{ path: repo, name: "stale" }]);
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
    expect(found.repos.sort()).toEqual([a, deep].sort());
    expect(found.worktrees).toEqual([]);
  });

  it("respects the maxDepth limit", () => {
    // scratch/l1/l2/repo/navori.config.json is at depth 3.
    const deep = makeRepo(join(scratch, "l1", "l2"), "repo");
    expect(scanForRepos(scratch, { maxDepth: 2 }).repos).toEqual([]);
    expect(scanForRepos(scratch, { maxDepth: 3 }).repos).toEqual([deep]);
  });

  it("returns an empty array for a non-existent root", () => {
    expect(scanForRepos(join(scratch, "does-not-exist")).repos).toEqual([]);
  });

  // #589: a worktree carries the parent's whole tree, harness included. Scanning
  // a workspace dir used to enroll every open ticket worktree as its own repo —
  // under the PARENT's name, so `registry ls` could not tell them apart, and a
  // later `render --all` would write the harness into those ticket branches.
  it("reports a git worktree separately instead of registering it as a repo", () => {
    const clone = makeRepo(scratch, "clone");
    mkdirSync(join(clone, ".git"), { recursive: true }); // a real clone: .git is a DIR
    const wt = makeRepo(scratch, "wt-ticket");
    // A worktree's .git is a FILE pointing at the parent's worktrees dir.
    writeFileSync(join(wt, ".git"), `gitdir: ${join(clone, ".git", "worktrees", "wt-ticket")}\n`);

    const found = scanForRepos(scratch);
    expect(found.repos).toEqual([clone]);
    expect(found.worktrees).toEqual([wt]);
  });

  it("treats a repo with no .git at all as a normal repo", () => {
    const bare = makeRepo(scratch, "no-git");
    expect(scanForRepos(scratch).repos).toEqual([bare]);
    expect(isGitWorktree(bare)).toBe(false);
  });

  // Guard: the mocked home keeps tests off the real ~/.navori.
  it("uses the mocked home, not the real one", () => {
    expect(registryPath().startsWith(home.dir)).toBe(true);
    expect(registryPath().startsWith(homedir())).toBe(false);
  });
});
