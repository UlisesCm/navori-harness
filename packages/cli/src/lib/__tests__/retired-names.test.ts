import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { retiredIds, sweepRetiredNames, sweepRoots } from "../retired-names.ts";

/**
 * spec 0026 T17 (R43, R44) — no distributed asset (content OR path) may still
 * name a retired id, in `core-assets/agents`, `core-assets/skills`,
 * `core-assets/managed`, `core-assets/hooks`, `core-assets/lib-skills`,
 * `core-assets/settings`, `core-assets/progress`, `core-assets/presets` or
 * `packages/plugins`, including their JSON files. The R38 registries
 * (`roster.ts`'s `RETIRED_AGENTS`/`RETIRED_SKILLS`/`RETIRED_HOOKS`) are the
 * one place a retired id is SUPPOSED to live forever, so `sweepRetiredNames`
 * never reads them as a swept area — only as the id list it sweeps
 * everything else for.
 *
 * `core-assets/prompts.json` is a deliberate gap (see the comment on
 * `sweepRoots` in `retired-names.ts`): it is a single file, never copied into
 * a target repo, only read in-process to build the `init` wizard's questions.
 */

let scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  scratch = [];
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "retired-names-"));
  scratch.push(dir);
  return dir;
}

describe("sweepRetiredNames", () => {
  // Covers: R43, R44
  it("distributed assets name no retired id", () => {
    const violations = sweepRetiredNames();
    expect(violations).toEqual([]);
  });

  it("does not sweep zero files from any real area", () => {
    // A silent empty root would pass every id trivially. Asserting the
    // production call above didn't throw is not enough evidence on its own —
    // this pins that it actually walked something in every area, since a
    // throw and an empty-but-successful sweep look identical from the outer
    // `expect(violations).toEqual([])` alone.
    expect(() => sweepRetiredNames()).not.toThrow();
  });

  // The 4 areas #868 found uncovered (core-assets/hooks, lib-skills,
  // settings, progress). Each is seeded through the REAL `sweepRoots()` path
  // (not a fixture dir), so this pins that the area is actually reachable
  // from the production sweep, not just that the generic content/path
  // matching works. `pr-pilot-confirm` and `explorer` are real retired ids
  // (roster.ts), never expected to collide with real asset content.
  it.each([
    ["core-assets/hooks", ".sh"],
    ["core-assets/lib-skills", ".md"],
    ["core-assets/settings", ".json"],
    ["core-assets/progress", ".md"],
  ] as const)("catches a retired id seeded (content AND path) in %s", (label, ext) => {
    const root = sweepRoots().find((r) => r.label === label);
    if (!root) throw new Error(`no sweep root labeled "${label}"`);
    const dir = join(root.path, "explorer-retired-names-fixture");
    const file = join(dir, `fixture${ext}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, "References the retired pr-pilot-confirm hook.");
    try {
      const violations = sweepRetiredNames();
      expect(violations).toContainEqual({ file, id: "explorer", kind: "path" });
      expect(violations).toContainEqual({ file, id: "pr-pilot-confirm", kind: "content" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("catches a retired id seeded in a file's CONTENT", () => {
    const root = tempDir();
    writeFileSync(join(root, "agent.md"), "Delegates to the `ticket-audit` agent.");
    const violations = sweepRetiredNames({
      roots: [{ label: "fixture", path: root }],
      ids: ["ticket-audit"],
    });
    expect(violations).toEqual([
      { file: join(root, "agent.md"), id: "ticket-audit", kind: "content" },
    ]);
  });

  it("catches a retired id seeded in a file's PATH", () => {
    const root = tempDir();
    mkdirSync(join(root, "explorer"));
    const file = join(root, "explorer", "SKILL.md");
    writeFileSync(file, "No mention in the body.");
    const violations = sweepRetiredNames({
      roots: [{ label: "fixture", path: root }],
      ids: ["explorer"],
    });
    expect(violations).toContainEqual({ file, id: "explorer", kind: "path" });
  });

  it("normalizes with NFKC before matching, so a look-alike Unicode variant is caught", () => {
    const root = tempDir();
    // U+FF41 FULLWIDTH LATIN SMALL LETTER A etc. — NFKC folds these back to
    // plain ASCII "leader" before the pattern runs.
    const fullwidth = "Ｌｅａｄｅｒ"; // "Leader" in fullwidth forms
    writeFileSync(join(root, "note.md"), `The ${fullwidth} decides.`);
    const violations = sweepRetiredNames({
      roots: [{ label: "fixture", path: root }],
      ids: ["leader"],
    });
    expect(violations).toEqual([{ file: join(root, "note.md"), id: "leader", kind: "content" }]);
  });

  it("does not match a retired id inside an unrelated longer word", () => {
    const root = tempDir();
    writeFileSync(join(root, "note.md"), "Team leadership rotates every sprint.");
    const violations = sweepRetiredNames({
      roots: [{ label: "fixture", path: root }],
      ids: ["leader"],
    });
    expect(violations).toEqual([]);
  });

  it("throws when a swept area resolves to no files", () => {
    const empty = tempDir();
    expect(() =>
      sweepRetiredNames({ roots: [{ label: "fixture-empty", path: join(empty, "missing") }] }),
    ).toThrow(/did not traverse/);
  });

  it("retiredIds() reflects the R38 registries, not a second hand-copied list", () => {
    const ids = retiredIds();
    expect(ids).toEqual(
      expect.arrayContaining(["leader", "explorer", "researcher", "ticket-audit"]),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });
});
