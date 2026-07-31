import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The Dominio store lives under ~/.navori/workspaces/<name>/dominio/ (machine-
 * local). safeHomedir is mocked so every test writes to a throwaway fake home,
 * never the developer's real ~/.navori. Entries are the source of truth and the
 * index is derived — these tests pin that contract (spec 0011 §5.4).
 */
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("../home.ts", () => ({ safeHomedir: () => home.dir }));

const {
  ensureDominio,
  reindex,
  findEntry,
  readEntry,
  validateDominio,
  resolveWorkspacesForCwd,
  dominioDir,
  dominioIndexPath,
  toSlug,
} = await import("../dominio.ts");
const { writeWorkspace, WorkspaceConfigSchema } = await import("../workspace.ts");

function makeWorkspace(name: string, repos: Array<{ name: string; path: string }> = []) {
  writeWorkspace(WorkspaceConfigSchema.parse({ name, repos }));
}

function writeEntry(ws: string, id: string, frontmatter: Record<string, string>, body: string) {
  const dir = dominioDir(ws);
  mkdirSync(dir, { recursive: true });
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  writeFileSync(join(dir, `${id}.md`), `---\n${fm}\n---\n\n${body}\n`);
}

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "navori-dominio-"));
});
afterEach(() => {
  rmSync(home.dir, { recursive: true, force: true });
});

describe("ensureDominio", () => {
  it("creates the dir + an empty index for an existing workspace", () => {
    makeWorkspace("bonum");
    const res = ensureDominio("bonum");
    expect(res.created).toBe(true);
    expect(res.indexPath).toBe(dominioIndexPath("bonum"));
    const index = readFileSync(res.indexPath, "utf-8");
    expect(index).toContain("# Dominio — workspace: bonum");
    expect(index).toContain("sin entradas todavía");
  });

  it("throws for an unknown workspace", () => {
    expect(() => ensureDominio("ghost")).toThrow(/not found/);
  });

  it("is idempotent (created=false the second time)", () => {
    makeWorkspace("bonum");
    expect(ensureDominio("bonum").created).toBe(true);
    expect(ensureDominio("bonum").created).toBe(false);
  });
});

describe("readEntry — tolerant frontmatter parsing", () => {
  it("parses lists, enums and derives the summary", () => {
    makeWorkspace("bonum");
    writeEntry(
      "bonum",
      "user-profile-model",
      {
        title: "Modelo user-profile",
        type: "migration",
        "applies-to": "[nexus, webapp, dashboard]",
        status: "canonical",
        supersedes: "[]",
        updated: "2026-07-30",
        updated_by: "ulises",
      },
      "coach/coachee ya no existen; ahora es user-profile.kind.",
    );
    const e = readEntry(join(dominioDir("bonum"), "user-profile-model.md"));
    expect(e.id).toBe("user-profile-model");
    expect(e.title).toBe("Modelo user-profile");
    expect(e.type).toBe("migration");
    expect(e.appliesTo).toEqual(["nexus", "webapp", "dashboard"]);
    expect(e.status).toBe("canonical");
    expect(e.updatedBy).toBe("ulises");
    expect(e.summary).toContain("coach/coachee ya no existen");
  });

  it("parses applies-to: all", () => {
    makeWorkspace("bonum");
    writeEntry("bonum", "glosario", { title: "Glosario", "applies-to": "all" }, "términos.");
    const e = readEntry(join(dominioDir("bonum"), "glosario.md"));
    expect(e.appliesTo).toBe("all");
  });

  it("falls back on unknown enum values instead of throwing", () => {
    makeWorkspace("bonum");
    writeEntry("bonum", "weird", { title: "Weird", type: "nonsense", status: "bogus" }, "body");
    const e = readEntry(join(dominioDir("bonum"), "weird.md"));
    expect(e.type).toBe("gotcha");
    expect(e.status).toBe("canonical");
  });
});

describe("reindex — the index is derived from entries", () => {
  it("lists entries, canonical first, with status suffixes", () => {
    makeWorkspace("bonum");
    writeEntry("bonum", "b-canon", { title: "Canon B", status: "canonical" }, "canonical fact");
    writeEntry(
      "bonum",
      "a-old",
      { title: "Old A", status: "superseded", supersedes: "[b-canon]" },
      "old fact",
    );
    writeEntry("bonum", "c-dep", { title: "Dep C", status: "deprecated" }, "deprecated fact");

    const res = reindex("bonum");
    expect(res.count).toBe(3);
    const index = readFileSync(res.indexPath, "utf-8");
    // canonical first, then deprecated, then superseded
    const order = ["Canon B", "Dep C", "Old A"].map((t) => index.indexOf(t));
    expect(order[0]).toBeLessThan(order[1]!);
    expect(order[1]).toBeLessThan(order[2]!);
    expect(index).toContain("_(deprecated)_");
    expect(index).toContain("_(superseded → b-canon)_");
    expect(index).toContain("[Canon B](b-canon.md)");
  });

  it("findEntry locates by id", () => {
    makeWorkspace("bonum");
    writeEntry("bonum", "auth", { title: "Auth" }, "cross-service token");
    expect(findEntry("bonum", "auth")?.title).toBe("Auth");
    expect(findEntry("bonum", "missing")).toBeNull();
  });
});

describe("validateDominio — all warnings, never throws", () => {
  it("flags unknown enum, dangling supersedes and stale index", () => {
    makeWorkspace("bonum");
    // Pass "en" so the findings come back in English (the index is written and
    // compared in the same locale, so staleness still reflects the added entries).
    ensureDominio("bonum", "en"); // writes an index...
    writeEntry("bonum", "e1", { title: "E1", type: "nope" }, "x"); // ...now stale + unknown type
    writeEntry("bonum", "e2", { title: "E2", status: "superseded", supersedes: "[ghost]" }, "y");

    const findings = validateDominio("bonum", "en");
    const msgs = findings.map((f) => f.message).join(" | ");
    expect(msgs).toMatch(/unknown type 'nope'/);
    expect(msgs).toMatch(/supersedes unknown entry 'ghost'/);
    expect(msgs).toMatch(/index out of date/);
  });

  it("is clean after reindex", () => {
    makeWorkspace("bonum");
    writeEntry("bonum", "ok", { title: "Ok", type: "architecture", status: "canonical" }, "fine");
    reindex("bonum");
    expect(validateDominio("bonum")).toEqual([]);
  });

  it("returns nothing for a workspace without a Dominio dir", () => {
    makeWorkspace("bonum");
    expect(validateDominio("bonum")).toEqual([]);
  });
});

describe("resolveWorkspacesForCwd", () => {
  it("matches a repo path and any descendant of it", () => {
    const repo = mkdtempSync(join(tmpdir(), "navori-repo-"));
    const nested = join(repo, "packages", "api");
    mkdirSync(nested, { recursive: true });
    makeWorkspace("bonum", [{ name: "nexus", path: repo }]);

    expect(resolveWorkspacesForCwd(repo)).toEqual(["bonum"]);
    expect(resolveWorkspacesForCwd(nested)).toEqual(["bonum"]);
    rmSync(repo, { recursive: true, force: true });
  });

  it("returns [] when cwd is outside every registered repo", () => {
    makeWorkspace("bonum", []);
    const outside = mkdtempSync(join(tmpdir(), "navori-outside-"));
    expect(resolveWorkspacesForCwd(outside)).toEqual([]);
    rmSync(outside, { recursive: true, force: true });
  });
});

describe("toSlug", () => {
  it("kebab-cases and strips diacritics", () => {
    expect(toSlug("Modelo User-Profile")).toBe("modelo-user-profile");
    expect(toSlug("Migración de datos")).toBe("migracion-de-datos");
    expect(toSlug("!!!")).toBe("entry");
  });
});
