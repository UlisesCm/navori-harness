import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

/**
 * #504 — "replace" adoption deletes the user's ENTIRE existing harness
 * (`.claude/`, `CLAUDE.md`, `progress/`, `specs/`, ...) and `lib/migrate.ts`
 * had 0% coverage: the only spec that named it (`interactive-flows.test.ts`)
 * MOCKED it, so it pinned that the flow CALLS it — never what it does.
 *
 * These specs run the real functions over a throwaway repo and assert the
 * SAFEGUARD, not the action: that the backup holds the bytes before anything is
 * removed, that a backup which cannot complete throws instead of handing the
 * caller a path list to delete, and that removal touches nothing it was not
 * given.
 *
 * `safeHomedir` is mocked (same pattern as registry.test.ts): the store lives at
 * `~/.navori/migrations`, and the suite's home guard (#404/#424) fails the run
 * if a spec writes into the developer's real one.
 */
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("../home.ts", () => ({ safeHomedir: () => home.dir }));

const { createMigrationBackup, migrationsRoot, removeOriginals } = await import("../migrate.ts");

/** Every file under `dir`, as sorted paths relative to it. */
function listFiles(dir: string, root: string = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, root));
    else if (entry.isFile()) out.push(relative(root, full));
  }
  return out.sort();
}

/** Write `content` at `repo/rel`, creating parent dirs. */
function write(repo: string, rel: string, content: string): void {
  const path = join(repo, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

/**
 * Harness files migrate.ts is meant to move, mapped to their content. Nested on
 * purpose: `.claude/` is a tree, and a copy that flattens it would still pass a
 * top-level existsSync.
 */
const HARNESS: Record<string, string> = {
  "CLAUDE.md": "# CLAUDE.md del usuario\n",
  "AGENTS.md": "# AGENTS.md del usuario\n",
  ".claude/settings.json": '{"hooks":{}}\n',
  ".claude/agents/leader.md": "# leader\n",
  ".claude/skills/debug/SKILL.md": "# debug skill\n",
  "progress/current.md": "idle\n",
  "specs/0001-feature/requirements.md": "R1: ...\n",
};

/**
 * Files that are NOT harness: nothing in this module may copy or delete them.
 * `.git/config` is the sharpest one — a recursive removal that overreaches
 * takes the repo's history with it.
 */
const KEEP: Record<string, string> = {
  "package.json": '{"name":"demo"}\n',
  "README.md": "# demo\n",
  "src/index.ts": "export const x = 1;\n",
  ".git/config": "[core]\n",
};

let repo: string;

function seedRepo(files: Record<string, string> = { ...HARNESS, ...KEEP }): void {
  for (const [rel, content] of Object.entries(files)) write(repo, rel, content);
}

/** Assert the non-harness files are still on disk with their original bytes. */
function expectKeepIntact(): void {
  for (const [rel, content] of Object.entries(KEEP)) {
    expect(readFileSync(join(repo, rel), "utf-8"), `${rel} must survive`).toBe(content);
  }
}

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "navori-home-"));
  repo = mkdtempSync(join(tmpdir(), "navori-repo-"));
});

afterEach(() => {
  rmSync(home.dir, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

describe("createMigrationBackup", () => {
  it("copies the whole harness — and ONLY the harness — into the migration store", () => {
    seedRepo();

    const result = createMigrationBackup(repo, "demo");

    // Candidate order, and the two absent candidates (CHECKPOINTS.md,
    // feature_list.json) are reported as not moved.
    expect(result.movedPaths).toEqual([".claude", "CLAUDE.md", "AGENTS.md", "progress", "specs"]);
    // A listing, not an existsSync per path: this also fails if the backup grows
    // a file it had no business copying (package.json, src/, .git/).
    expect(listFiles(result.path)).toEqual(Object.keys(HARNESS).sort());
  });

  it("copies byte-identical content, nested directories included", () => {
    seedRepo();

    const result = createMigrationBackup(repo, "demo");

    for (const [rel, content] of Object.entries(HARNESS)) {
      expect(readFileSync(join(result.path, rel), "utf-8"), rel).toBe(content);
    }
  });

  it("is a COPY: the originals stay until the caller removes them (#240)", () => {
    seedRepo();

    createMigrationBackup(repo, "demo");

    // Removal is deferred past every wizard prompt, so the backup step alone
    // must leave the repo exactly as it found it.
    for (const rel of Object.keys(HARNESS)) {
      expect(existsSync(join(repo, rel)), `${rel} must still exist`).toBe(true);
    }
    expectKeepIntact();
  });

  it("skips candidates that do not exist instead of inventing them", () => {
    seedRepo({ "CLAUDE.md": HARNESS["CLAUDE.md"] as string, ...KEEP });

    const result = createMigrationBackup(repo, "demo");

    expect(result.movedPaths).toEqual(["CLAUDE.md"]);
    expect(listFiles(result.path)).toEqual(["CLAUDE.md"]);
    expect(existsSync(join(result.path, ".claude"))).toBe(false);
  });

  it("lands under ~/.navori/migrations/<timestamp>/<repo>", () => {
    seedRepo();

    const result = createMigrationBackup(repo, "demo");

    expect(migrationsRoot()).toBe(join(home.dir, ".navori", "migrations"));
    const rel = relative(migrationsRoot(), result.path).split(/[\\/]/);
    expect(rel).toHaveLength(2); // <timestamp>/<repoName> — never outside the store
    expect(rel[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/);
    expect(rel[1]).toBe("demo");
  });

  it("THROWS when the copy cannot complete, rather than returning a half-made backup", () => {
    seedRepo();
    // A dangling symlink inside `.claude` (a plugin dir removed by hand, a
    // node_modules link): copyRecursive stats the target and fails. What matters
    // is the shape of the failure — the caller never gets a movedPaths list for
    // content that was not copied, so `removeOriginals` is never reached.
    symlinkSync(join(repo, "nowhere"), join(repo, ".claude", "dangling"));

    expect(() => createMigrationBackup(repo, "demo")).toThrow();

    for (const rel of Object.keys(HARNESS)) {
      expect(existsSync(join(repo, rel)), `${rel} must survive a failed backup`).toBe(true);
    }
    expectKeepIntact();
  });

  it("THROWS when the migration store itself is unusable", () => {
    seedRepo();
    // `~/.navori/migrations` occupied by a FILE — the store cannot be created.
    mkdirSync(join(home.dir, ".navori"), { recursive: true });
    writeFileSync(join(home.dir, ".navori", "migrations"), "not a directory", "utf-8");

    expect(() => createMigrationBackup(repo, "demo")).toThrow();

    for (const rel of Object.keys(HARNESS)) {
      expect(existsSync(join(repo, rel)), `${rel} must survive a failed backup`).toBe(true);
    }
  });
});

describe("removeOriginals", () => {
  it("removes exactly the paths it is given, trees included", () => {
    seedRepo();

    removeOriginals(repo, [".claude", "CLAUDE.md"]);

    expect(existsSync(join(repo, ".claude"))).toBe(false);
    expect(existsSync(join(repo, "CLAUDE.md"))).toBe(false);
    // Harness paths NOT in the list are none of its business.
    expect(existsSync(join(repo, "progress/current.md"))).toBe(true);
    expect(existsSync(join(repo, "specs/0001-feature/requirements.md"))).toBe(true);
    expect(existsSync(join(repo, "AGENTS.md"))).toBe(true);
    expectKeepIntact();
  });

  it("ignores a path that is not there, without touching the rest", () => {
    seedRepo();

    expect(() => removeOriginals(repo, ["CHECKPOINTS.md", "feature_list.json"])).not.toThrow();

    expect(listFiles(repo)).toEqual([...Object.keys(HARNESS), ...Object.keys(KEEP)].sort());
  });

  it("removes nothing when given an empty list (a backup that found nothing)", () => {
    seedRepo();

    removeOriginals(repo, []);

    expect(listFiles(repo)).toEqual([...Object.keys(HARNESS), ...Object.keys(KEEP)].sort());
  });
});

describe("adoption round trip (backup → remove)", () => {
  it("every byte it deletes is readable from the backup afterwards", () => {
    seedRepo();
    const before = Object.fromEntries(
      Object.keys(HARNESS).map((rel) => [rel, readFileSync(join(repo, rel), "utf-8")]),
    );

    const backup = createMigrationBackup(repo, "demo");
    removeOriginals(repo, backup.movedPaths);

    // The action: the harness is gone from the repo.
    for (const rel of Object.keys(HARNESS)) {
      expect(existsSync(join(repo, rel)), `${rel} must be gone`).toBe(false);
    }
    // The SAFEGUARD — the half nothing asserted before #504: the deleted tree is
    // recoverable in full, file by file, byte for byte.
    expect(listFiles(backup.path)).toEqual(Object.keys(before).sort());
    for (const [rel, content] of Object.entries(before)) {
      expect(readFileSync(join(backup.path, rel), "utf-8"), `${rel} must be recoverable`).toBe(
        content,
      );
    }
    expectKeepIntact();
  });
});
