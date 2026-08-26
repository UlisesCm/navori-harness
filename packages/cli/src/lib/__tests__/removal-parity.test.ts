import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { NavoriConfig } from "../config.ts";

/**
 * PARITY between the delete paths — the test that keeps #496's whole CLASS of
 * bug from coming back.
 *
 * navori deletes a file the user already had from exactly three places:
 *   A. `commitWrites` (engines/shared/execute-plan.ts) — a stale managed file.
 *   B. `render --prune` (commands/render.ts) — an orphaned engine's output.
 *   C. the Claude engine's skill prunes (engines/claude/index.ts §8.6–8.8) —
 *      a library skill navori no longer renders, in flat or directory form.
 *
 * The three shipped with three different criteria: A demanded navori's marker;
 * B deleted whatever a static per-engine path map named, recursively, without
 * reading a byte; C checked the marker id but not the version, so it deleted a
 * file a NEWER navori wrote — the anti-rollback rule the other two enforce.
 * Separate patches would not have stopped a fourth from appearing: one
 * criterion, one function, and a test that fails when a caller stops using it —
 * or when a delete path shows up that nobody accounted for — does.
 *
 * So this file asserts the SAME fixture gets the SAME verdict from ALL paths,
 * that none of them grows a private copy of the rule, and that the inventory of
 * delete sites in `src/` is the one this file declares.
 */

const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("../home.ts", () => ({ safeHomedir: () => home.dir }));
vi.mock("../../lib/home.ts", () => ({ safeHomedir: () => home.dir }));

const { renderCodexEngine } = await import("../../engines/codex/index.ts");
const { renderClaudeEngine } = await import("../../engines/claude/index.ts");
const { runRender } = await import("../../commands/render.ts");
const { writeConfig } = await import("../config.ts");
const { injectManagedSection } = await import("../marker.ts");
const { readCliVersion } = await import("../bundled-assets.ts");
const { isRemovableNavoriFile } = await import("../removable.ts");

const CODEX_CONFIG = {
  name: "demo",
  engines: ["codex"],
  preset: "custom",
  version: "1.0.0",
  language: "es",
  branchBase: "main",
  commits: "conventional-es",
  qualityGate: { fast: "pnpm typecheck", full: "pnpm test" },
} as unknown as NavoriConfig;

/** Same repo, rendered by the Claude engine — route C's stage. `libraries: []`
 *  is what makes an on-disk library skill an orphan §8.7 must judge. */
const CLAUDE_CONFIG = {
  ...CODEX_CONFIG,
  engines: ["claude"],
  project: { libraries: [] },
} as unknown as NavoriConfig;

type FixtureName = "navori" | "foreign" | "fromTheFuture";

/**
 * The three authorship shapes every path must judge identically, stamped with
 * the managed id the route reads. Routes A and B accept any navori marker; route
 * C only deletes `<id>.md` when the block inside carries that skill's own id, so
 * the fixture has to be built per route instead of shared as a constant.
 */
function fixture(name: FixtureName, id: string): string {
  switch (name) {
    /** navori's own output at the current version — the only deletable one. */
    case "navori":
      return injectManagedSection("", id, "managed body\n", {
        version: readCliVersion(),
        source: "@navori/core",
      }).output;
    /** The user typed it. No marker, no deletion, ever. */
    case "foreign":
      return "# escrito a mano\n\nprosa del usuario\n";
    /** Written by a navori newer than this CLI: not ours to remove (#79). */
    case "fromTheFuture":
      return injectManagedSection("", id, "del futuro\n", {
        version: "99.0.0",
        source: "@navori/core",
      }).output;
  }
}

/** The three shapes as route A/B see them (any id works there). */
const FIXTURES = {
  navori: fixture("navori", "parity"),
  foreign: fixture("foreign", "parity"),
  fromTheFuture: fixture("fromTheFuture", "parity"),
} as const;

const CASES: Array<{ name: FixtureName; deletable: boolean }> = [
  { name: "navori", deletable: true },
  { name: "foreign", deletable: false },
  { name: "fromTheFuture", deletable: false },
];

/**
 * The library skill route C is driven with: a valid registry lib that the
 * fixture repo does NOT select, so §8.7 (orphaned library skill) considers it on
 * every render. Its managed id is the bare id by construction.
 */
const ORPHAN_LIB = "zod-validation";

/** `src/`, the tree the structural specs below read. */
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Every `.ts` file under src/, excluding tests. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Every temp repo a spec here creates; each route gets a pristine one so the
 *  two never observe each other's output. */
const repos: string[] = [];

function newRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "navori-removal-parity-"));
  repos.push(dir);
  return dir;
}

let cwd: string;

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "navori-home-"));
  cwd = newRepo();
});

afterEach(() => {
  for (const dir of repos) rmSync(dir, { recursive: true, force: true });
  repos.length = 0;
  rmSync(home.dir, { recursive: true, force: true });
});

/**
 * Route A — `commitWrites`: an agent `.toml` the plan no longer wants is an
 * orphan, and `collectOrphans` decides its fate. (The Codex engine is used
 * because it is the one whose adapter declares real `orphanScans`.)
 * @returns whether the file was gone after the render.
 */
function deletedByCommitWrites(content: string): boolean {
  const repo = newRepo();
  renderCodexEngine(repo, CODEX_CONFIG);
  const stale = join(repo, ".codex/agents/agente-que-ya-no-existe.toml");
  writeFileSync(stale, content, "utf-8");
  renderCodexEngine(repo, CODEX_CONFIG);
  return !existsSync(stale);
}

/**
 * Route B — `render --prune`: `AGENTS.md` is owned only by the disabled
 * `codex`/`agents-md` engines, so it is reported as an orphan and pruned.
 * @returns whether the file was gone after the render.
 */
function deletedByPrune(content: string): boolean {
  const repo = newRepo();
  writeConfig(join(repo, "navori.config.json"), {
    name: "demo",
    engines: ["claude"],
    preset: "custom",
  });
  const orphan = join(repo, "AGENTS.md");
  writeFileSync(orphan, content, "utf-8");
  runRender(repo, { dryRun: false, prune: true });
  return !existsSync(orphan);
}

/**
 * Route C — the Claude engine's skill prunes. A library skill the config does
 * not select is an orphan §8.7 sweeps on every render, in BOTH shapes: the
 * legacy flat `<id>.md` (planFlatSkillRemoval) and the current
 * `<id>/SKILL.md` (planDirSkillRemoval). Both are exercised because they are two
 * functions, and the version guard had to be added to each.
 * @returns whether the file was gone after the render.
 */
function deletedByClaudeSkillPrune(content: string, shape: "flat" | "dir"): boolean {
  const repo = newRepo();
  const skills = join(repo, ".claude/skills");
  const stale =
    shape === "flat" ? join(skills, `${ORPHAN_LIB}.md`) : join(skills, ORPHAN_LIB, "SKILL.md");
  mkdirSync(dirname(stale), { recursive: true });
  writeFileSync(stale, content, "utf-8");
  renderClaudeEngine(repo, CLAUDE_CONFIG);
  return !existsSync(stale);
}

describe("every delete path shares ONE authorship criterion (#496)", () => {
  for (const { name, deletable } of CASES) {
    it(`agrees on a ${name} file: ${deletable ? "deleted" : "kept"} by ALL paths`, () => {
      // Asserted as one object, not as independent expectations: the failure this
      // guards against is the paths DISAGREEING, so the diff must show them all.
      expect({
        commitWrites: deletedByCommitWrites(FIXTURES[name]),
        prune: deletedByPrune(FIXTURES[name]),
        claudeFlatSkill: deletedByClaudeSkillPrune(fixture(name, ORPHAN_LIB), "flat"),
        claudeDirSkill: deletedByClaudeSkillPrune(fixture(name, ORPHAN_LIB), "dir"),
      }).toEqual({
        commitWrites: deletable,
        prune: deletable,
        claudeFlatSkill: deletable,
        claudeDirSkill: deletable,
      });
    });
  }
});

/**
 * The guard route C did NOT have, spelled out on its own: navori 0.x must not
 * delete the file navori 99.x wrote. The flat prune is the one that runs on a
 * SELECTED skill (§8.8's flat→directory migration), so this is also the case
 * where keeping the file has a visible cost — a duplicate — and the trade-off is
 * argued in `planFlatSkillRemoval`'s JSDoc. Pinned here so nobody "simplifies"
 * it back to a marker-only check to make the duplicate go away.
 */
describe("a skill file written by a NEWER navori survives the Claude prune", () => {
  it("keeps the flat twin of a SELECTED library skill instead of rolling it back", () => {
    const repo = newRepo();
    const flat = join(repo, ".claude/skills", `${ORPHAN_LIB}.md`);
    mkdirSync(dirname(flat), { recursive: true });
    writeFileSync(flat, fixture("fromTheFuture", ORPHAN_LIB), "utf-8");

    renderClaudeEngine(repo, {
      ...CLAUDE_CONFIG,
      project: { libraries: [ORPHAN_LIB] },
    } as unknown as NavoriConfig);

    expect(existsSync(flat)).toBe(true);
    expect(readFileSync(flat, "utf-8")).toContain("del futuro");
    // …and the render still materialized the directory form it owns.
    expect(existsSync(join(repo, ".claude/skills", ORPHAN_LIB, "SKILL.md"))).toBe(true);
  });
});

/**
 * The behavioural half above proves the two paths agree TODAY. This half proves
 * they agree BY CONSTRUCTION — a third delete path, or one caller re-inlining a
 * private (and inevitably weaker) check, fails here before it can ship.
 */
describe("the criterion has exactly one definition, and every caller uses it", () => {
  const CALLERS = [
    "engines/shared/execute-plan.ts",
    "commands/render.ts",
    "engines/claude/index.ts",
  ];

  it("defines isRemovableNavoriFile in lib/removable.ts and nowhere else", () => {
    const definers = sourceFiles(SRC).filter((f) =>
      /function isRemovableNavoriFile/.test(readFileSync(f, "utf-8")),
    );
    expect(definers.map((f) => f.slice(SRC.length + 1))).toEqual(["lib/removable.ts"]);
  });

  it("routes every delete path through the shared module", () => {
    for (const caller of CALLERS) {
      const src = readFileSync(join(SRC, caller), "utf-8");
      // Imported from the shared module — matched on the `from "…"` clause, not
      // on the bare filename, so a COMMENT mentioning lib/removable.ts can never
      // stand in for an import that was deleted.
      expect(src).toMatch(/from "[^"]*\/removable\.ts"/);
      // …and actually consulted. `render.ts` reaches it through
      // `planOrphanRemoval`, which is that module's only other export.
      expect(src).toMatch(/isRemovableNavoriFile\(|planOrphanRemoval\(/);
    }
  });

  it("keeps the marker+version check out of the callers", () => {
    // How route C drifted: `engines/claude/index.ts` built the marker test
    // inline (`content.includes(`navori:managed id="${markerId}"`)`) and simply
    // forgot the version half. Interpolating a managed id into a string is that
    // exact move, so the shared module is the only place allowed to do it.
    const inliners = sourceFiles(SRC)
      .filter((f) => /navori:managed id="\$\{/.test(readFileSync(f, "utf-8")))
      .map((f) => f.slice(SRC.length + 1));
    expect(inliners).toEqual(["lib/removable.ts"]);
  });

  it("leaves no recursive rmSync on a path the user may own", () => {
    // The literal shape of the #496 defect: `rmSync(<orphan path>, {recursive:
    // true})` over a directory nobody inspected. `commitWrites` still removes a
    // skill DIRECTORY recursively, but only after `isRemovableNavoriFile` cleared
    // its SKILL.md — so the guard, not the flag, is what this pins.
    const render = readFileSync(join(SRC, "commands/render.ts"), "utf-8");
    expect(render).not.toMatch(/rmSync\([^)]*recursive:\s*true/);
  });
});

/**
 * THE INVENTORY. The bug underneath #496 was never "a guard is missing here" —
 * it was that nobody knew how many places delete a file. Three had been written
 * with three criteria and the third was found by hand, after the fix.
 *
 * So the count is pinned. Every non-test file under `src/` that removes a path
 * from disk (or plans a removal for someone else to execute) is listed with the
 * criterion that makes it safe. A file that grows a delete call and is not here
 * fails this test — the author then either routes it through
 * `isRemovableNavoriFile` or writes down, in this table, why it legitimately
 * does not need it. The list is intentionally file-grained: it survives moving
 * a call around, and breaks the moment a NEW site appears.
 *
 * WHAT IT SEES, exactly — a promise wider than its reach is the false green
 * this file exists to prevent. It matches a call to the fs delete API by name,
 * sync or promise-based, however it is qualified (`rmSync(p)`, `fs.rmSync(p)`,
 * `await rm(p)`, `fs.promises.rm(p)`), plus the API renamed on import. It does
 * NOT see a delete performed through an indirection: a helper in ANOTHER module
 * (that module is listed — the wrapper's own file matches — but its callers are
 * not), a shell-out (`execSync("rm -rf …")`), or a dynamically built name. Those
 * are on the reviewer, not on this regex.
 */
describe("the inventory of delete paths is complete (#496)", () => {
  /** The fs delete API by name — sync AND `node:fs/promises`, since
   *  `await rm(p, { recursive: true })` deletes exactly as hard as `rmSync` and
   *  used to sail past this test — or a removal planned for `commitWrites`. */
  const DELETES =
    /\b(rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync)\(|\bremovals?\.push\(|\.remove\.push\(/;

  /** The one shape a call-site regex cannot see: the API renamed on import
   *  (`import { rmSync as nuke }`), which leaves the call spelled `nuke(p)`.
   *  Caught at the import, where the real name still appears. */
  const ALIASED_DELETE = /\b(rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync)\s+as\s+\w+/;

  const DELETE_SITES: Record<string, string> = {
    // ── The three that judge a file the USER may own: shared criterion. ──
    "commands/render.ts": "route B — planOrphanRemoval → isRemovableNavoriFile, file by file",
    "engines/shared/execute-plan.ts": "route A — collectOrphans → isRemovableNavoriFile",
    "engines/claude/index.ts":
      "route C — planFlat/planDirSkillRemoval → isRemovableNavoriFile(path, markerId). " +
      "Its other two removals (disabled-plugin scripts §8.5, retired-plugin assets §8.5-bis) " +
      "are marker-FREE by construction: a shell script carries no managed block, and the path " +
      "comes from the plugin's own manifest, so navori is its only writer",
    "lib/removable.ts": "the criterion itself, plus removeEmptyDirs (rmdirSync refuses non-empty)",

    // ── Paths that are navori's OWN, not the user's content. ──
    "lib/atomic.ts": "removes the `.tmp` file it just wrote, when the rename fails",
    "lib/backup.ts": "prunes navori's own backup store (~/.navori/backups) by age and size",
    "lib/lockfile.ts": "removes its own lock file",
    "lib/global-config.ts": "deletes ~/.navori/global.json on an explicit command",
    "lib/tickets.ts": "deletes a ticket from navori's workspace store on an explicit command",
    "engines/claude/global-render.ts":
      "`navori global uninstall` removes navori's own global hook file — the whole point of " +
      "the command, so a marker gate would only make uninstalling fail",

    // ── Deletes the USER's files on purpose, after copying them. ──
    "lib/migrate.ts":
      "removeOriginals: the pre-navori harness the user chose to REPLACE, deleted only after " +
      "createMigrationBackup copied it and only in `replace` adoption mode. A marker gate would " +
      "defeat the feature — these files are the user's by definition",
    "lib/workspace.ts":
      "drops the legacy `<name>.json` after copyFileSync put it in the new layout; best-effort",
  };

  it("finds no delete site that this file does not declare", () => {
    const found = sourceFiles(SRC)
      .filter((f) => {
        const src = readFileSync(f, "utf-8");
        return DELETES.test(src) || ALIASED_DELETE.test(src);
      })
      .map((f) => f.slice(SRC.length + 1))
      .sort();
    expect(found).toEqual(Object.keys(DELETE_SITES).sort());
  });

  it("sees the promise-based and the aliased spellings too", () => {
    // The regex IS the guard, so its reach is asserted directly instead of
    // being taken on faith: each of these shipped undetected before.
    for (const shape of [
      "rmSync(p)",
      "fs.rmSync(p)",
      "await rm(p, { recursive: true })",
      "await fs.promises.rm(p)",
      "await unlink(p)",
      "await rmdir(p)",
    ]) {
      expect(DELETES.test(shape)).toBe(true);
    }
    expect(ALIASED_DELETE.test('import { rmSync as nuke } from "node:fs";')).toBe(true);
    // …and it does not fire on words that merely contain the API's name.
    for (const innocent of ["confirm(x)", "form(x)", "transform(x)", "unlinked(x)"]) {
      expect(DELETES.test(innocent)).toBe(false);
    }
  });
});

/** A directory listed as an orphan is walked, never deleted whole — the concrete
 *  loss reported in #496 (a `.cursor/` holding the user's own rules). */
describe("an orphaned DIRECTORY is emptied of navori's files only", () => {
  it("keeps the user's files and removes navori's, in the same directory", () => {
    writeConfig(join(cwd, "navori.config.json"), {
      name: "demo",
      engines: ["claude"],
      preset: "custom",
    });
    mkdirSync(join(cwd, ".codex/agents"), { recursive: true });
    writeFileSync(join(cwd, ".codex/config.toml"), FIXTURES.navori);
    writeFileSync(join(cwd, ".codex/agents/mio.toml"), FIXTURES.foreign);
    // A symlink is the user's, whatever it points at — never followed out of the
    // tree, never removed, even when its TARGET carries navori's marker.
    symlinkSync(join(cwd, ".codex/config.toml"), join(cwd, ".codex/agents/enlace.toml"));

    const result = runRender(cwd, { dryRun: false, prune: true });

    expect(result.prunedEngineOutputs).toEqual([".codex/config.toml"]);
    expect(existsSync(join(cwd, ".codex/agents/mio.toml"))).toBe(true);
    expect(lstatSync(join(cwd, ".codex/agents/enlace.toml")).isSymbolicLink()).toBe(true);
    expect(result.keptEngineOutputs).toEqual(
      expect.arrayContaining([
        { path: ".codex/agents/mio.toml", reason: "foreign" },
        // `symlink`, not `foreign`: the two are different answers. `foreign` is
        // "we read it and it is not ours"; this one is "we did not follow it".
        { path: ".codex/agents/enlace.toml", reason: "symlink" },
      ]),
    );
  });
});

/**
 * The orphan ROOT can itself be a symlink — `.codex -> ~/dotfiles`,
 * `AGENTS.md -> CLAUDE.md` — and that is where the walk escaped the repository.
 * `planOrphanRemoval` classified roots with `statSync`, which RESOLVES the link:
 * a linked directory was walked as a directory and the user's files behind it,
 * outside the repo, were deleted and `rmdir`ed. The case above could not catch
 * it because it seeds the link as a CHILD, the one position the old dirent guard
 * covered.
 *
 * Worse than what #496 reported, and a regression against `main`, where the root
 * was removed with `rmSync(root, { recursive: true, force: true })` — `rm -rf`
 * semantics unlink the LINK and leave its target alone. So `main` lost a link;
 * the walk lost the files behind it. The fix keeps both, which is the third
 * behaviour of the three: the link survives the prune, on purpose, and the run
 * reports it as `symlink` so a `.cursor` still standing does not read as a prune
 * that silently failed.
 */
describe("an orphan root that is itself a symlink (#496)", () => {
  it("judges a link as a link, never by the bytes on the other side", () => {
    // The criterion itself, one layer below the walk: `existsSync`/`readFileSync`
    // both resolve the link, so the answer to "may navori delete this path?"
    // used to be read out of the TARGET's file. Every caller of it — all three
    // delete routes — inherits this.
    const target = join(cwd, "objetivo.md");
    writeFileSync(target, FIXTURES.navori);
    const link = join(cwd, "enlace.md");
    symlinkSync(target, link);

    expect(isRemovableNavoriFile(target)).toBe(true);
    expect(isRemovableNavoriFile(link)).toBe(false);
  });

  it("never deletes the target of a linked DIRECTORY, outside the repository", () => {
    writeConfig(join(cwd, "navori.config.json"), {
      name: "demo",
      engines: ["claude"],
      preset: "custom",
    });
    // A temp dir of its own: not under `cwd`, i.e. genuinely outside the repo,
    // the way `~/dotfiles` is.
    const outside = newRepo();
    mkdirSync(join(outside, "rules"), { recursive: true });
    // navori's marker on a file behind the link is NOT a licence to delete it:
    // the question is "is this path in this repository", and it is not.
    writeFileSync(join(outside, "rules/shared.md"), FIXTURES.navori);
    writeFileSync(join(outside, "notes.md"), FIXTURES.foreign);
    // An EMPTY directory of the user's: what `removeEmptyDirs` sweeps. It is in
    // here so this spec pins BOTH halves of the walk — the planner AND the
    // sweeper, which follows a link through `readdirSync` just as easily.
    mkdirSync(join(outside, "vacio"), { recursive: true });
    symlinkSync(outside, join(cwd, ".codex"));
    // A real removable orphan alongside the link: without it the prune deletes
    // nothing, `removeEmptyDirs` is never reached, and half the fix goes untested.
    writeFileSync(join(cwd, "AGENTS.md"), FIXTURES.navori);

    const result = runRender(cwd, { dryRun: false, prune: true });

    expect(result.prunedEngineOutputs).toEqual(["AGENTS.md"]);
    expect(result.keptEngineOutputs).toContainEqual({ path: ".codex", reason: "symlink" });
    // Everything the user had behind the link, files AND directories.
    expect(readFileSync(join(outside, "rules/shared.md"), "utf-8")).toBe(FIXTURES.navori);
    expect(existsSync(join(outside, "rules"))).toBe(true);
    expect(existsSync(join(outside, "notes.md"))).toBe(true);
    expect(existsSync(join(outside, "vacio"))).toBe(true);
    // And the link, which `main` would have unlinked.
    expect(lstatSync(join(cwd, ".codex")).isSymbolicLink()).toBe(true);
  });

  it("does not unlink AGENTS.md when it is a link to CLAUDE.md", () => {
    // A common layout, and `AGENTS.md` is an orphan path whenever the
    // agents-md/codex engines are off — so the prune meets this one for real.
    writeConfig(join(cwd, "navori.config.json"), {
      name: "demo",
      engines: ["claude"],
      preset: "custom",
    });
    symlinkSync("CLAUDE.md", join(cwd, "AGENTS.md"));

    const result = runRender(cwd, { dryRun: false, prune: true });

    // The marker read THROUGH the link is CLAUDE.md's, and it made the link
    // removable. Now the link is judged as a link.
    expect(result.prunedEngineOutputs).not.toContain("AGENTS.md");
    expect(result.keptEngineOutputs).toContainEqual({ path: "AGENTS.md", reason: "symlink" });
    expect(lstatSync(join(cwd, "AGENTS.md")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(cwd, "CLAUDE.md"))).toBe(true);
  });

  it("still prunes a REAL directory of the same shape — the control", () => {
    // The guard is about links, not about the prune giving up: the identical
    // layout with a real `.codex/` is emptied and swept exactly as before.
    writeConfig(join(cwd, "navori.config.json"), {
      name: "demo",
      engines: ["claude"],
      preset: "custom",
    });
    mkdirSync(join(cwd, ".codex/rules"), { recursive: true });
    writeFileSync(join(cwd, ".codex/rules/shared.md"), FIXTURES.navori);

    const result = runRender(cwd, { dryRun: false, prune: true });

    expect(result.prunedEngineOutputs).toEqual([".codex/rules/shared.md"]);
    expect(existsSync(join(cwd, ".codex"))).toBe(false);
  });
});

/**
 * Keeping the link is a deliberate change of behaviour against `main`, which
 * unlinked it (`rm -rf` semantics on the root). The user SEES the difference —
 * `.cursor` is still there after a prune — so the run has to say why, or it
 * reads as a prune that silently failed. That makes the copy part of the fix,
 * not decoration, and it has to exist in both locales.
 */
describe("a spared symlink says so, in both locales (#496)", () => {
  it("gives the symlink reason its own words, not the generic 'not ours'", async () => {
    const { tc, SUPPORTED_LANGS } = await import("../i18n.ts");
    for (const lang of SUPPORTED_LANGS) {
      const tr = tc(lang).render;
      const symlink = tr.keptEngineOutputReason("symlink");
      expect(symlink).not.toBe(tr.keptEngineOutputReason("foreign"));
      expect(symlink).not.toBe(tr.keptEngineOutputReason("ephemeral"));
      expect(symlink.toLowerCase()).toMatch(/symlink|enlace/);
    }
  });
});

/**
 * The third face of #496: doctor RECOMMENDS the prune, and it used to call the
 * operation "safe to delete" over a directory whose contents it had never read
 * (the row is built from the static per-engine map). The prune is now file by
 * file, so the copy must promise exactly that — and never again promise safety
 * on behalf of bytes nobody looked at, in either locale.
 */
describe("doctor never promises a path is safe to delete (#496)", () => {
  it("says what the prune actually does, in both locales", async () => {
    const { tc, SUPPORTED_LANGS } = await import("../i18n.ts");
    for (const lang of SUPPORTED_LANGS) {
      const row = tc(lang).doctor.orphanedEngineOutputRow("cursor");
      expect(row).toContain("cursor");
      expect(row.toLowerCase()).not.toContain("safe to delete");
      expect(row.toLowerCase()).not.toContain("seguro de borrar");
      // It names the criterion instead of asserting safety.
      expect(row.toLowerCase()).toMatch(/marker|marcador/);
    }
  });
});
