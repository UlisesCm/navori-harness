import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NavoriConfigSchema, type NavoriConfig } from "../../../lib/config/schema.ts";
import { loadPlugin } from "../../../lib/config/plugins.ts";
import { getCoreRoot } from "../../../lib/render/bundled-assets.ts";
import { renderClaudeEngine } from "../index.ts";

/**
 * Spec 0064 PR 4a, A3: Claude loses no doctrine when the shared blocks are neutralized. Every
 * occurrence of Claude vocabulary the shared blocks had before 4a is listed per asset and per term
 * (`CENSUS`, frozen from the pre-4a text) and mapped to the row of `claude-apendice` that now
 * carries it. A term that disappears from a shared block without a row, or a row that stops
 * carrying its term, fails here.
 */

/** Rendered text each appendix row must contain, verbatim, in `CLAUDE.md`. */
const APPENDIX_ROWS: Readonly<Record<number, string>> = {
  1: "Destructive shell commands route to `ask`/`deny` permission rules.",
  2: "Native `Glob`/`Grep` are read-only and pre-approved.",
  3: "In auto mode, apply the shell-edit check to every `sed -i` and `>`.",
  4: "A `deny`/hook block is the answer; a hook `ask` is the user's call.",
  5: "Do NOT mirror the spec's task list in `TaskCreate` (ignore its reminder).",
  6: "Code discovery here: known file → Read/Edit; filename/path patterns → Glob; textual search with no provider → Grep.",
  7: "Skills cited by name live at `.claude/skills/<name>/SKILL.md` (tickets: `.claude/skills/resolve-ticket/SKILL.md`).",
  8: "A workspace's or app's own harness is its `CLAUDE.md` + `.claude/`.",
  9: "**The permission mode decides what you CAN do — read it before planning how.** The host sets it, you never change it. `dontAsk` isn't supported today (`Edit`/`Write` aren't pre-approved, so the implement/review cycle can't run). Reference: https://code.claude.com/docs/en/permission-modes",
};

const OPERACIONES = "core-assets/managed/operaciones-seguras.md";
const ROUTING = "core-assets/managed/code-discovery-routing.md";
const TICKETS = "core-assets/managed/intake-tickets.md";
const SDD = "core-assets/managed/sdd.md";
const TGREP = "plugin:tgrep";
const stack = (preset: string): string => `core-assets/presets/${preset}/managed/stack.md`;

interface Occurrence {
  /** Asset that carried the term in `origin/dev` before 4a. */
  readonly asset: string;
  readonly term: string;
  /** How many times the pre-4a text had it. */
  readonly count: number;
  /** Row of `APPENDIX_ROWS` that carries it now. */
  readonly row: keyof typeof APPENDIX_ROWS;
  /** The pre-4a source capitalised it differently from the appendix. */
  readonly ignoreCase?: true;
}

/** Census of the pre-4a shared text, counted with `git show origin/dev:<asset>` (line numbers in brackets). */
const CENSUS: readonly Occurrence[] = [
  { asset: OPERACIONES, term: "`ask`/`deny`", count: 1, row: 1 }, // [6]
  { asset: OPERACIONES, term: "Glob", count: 1, row: 2 }, // [7]
  { asset: OPERACIONES, term: "Grep", count: 1, row: 2 }, // [7]
  { asset: OPERACIONES, term: "auto mode", count: 1, row: 3 }, // [8]
  { asset: OPERACIONES, term: "`deny`/hook", count: 1, row: 4 }, // [10]
  { asset: OPERACIONES, term: "hook `ask`", count: 1, row: 4, ignoreCase: true }, // [10]: "Hook `ask`"
  { asset: OPERACIONES, term: "permission mode", count: 1, row: 9 }, // [14]
  { asset: OPERACIONES, term: "dontAsk", count: 1, row: 9 }, // [14]
  { asset: OPERACIONES, term: "`Edit`", count: 1, row: 9 }, // [14]
  { asset: OPERACIONES, term: "`Write`", count: 1, row: 9 }, // [14]
  { asset: OPERACIONES, term: "code.claude.com", count: 1, row: 9 }, // [14]
  { asset: ROUTING, term: "Read/Edit", count: 1, row: 6 }, // [5]
  { asset: ROUTING, term: "Glob", count: 1, row: 6 }, // [6]
  { asset: TICKETS, term: ".claude/skills/resolve-ticket/SKILL.md", count: 1, row: 7 }, // [3]
  { asset: SDD, term: "TaskCreate", count: 1, row: 5 }, // [9]
  { asset: TGREP, term: "Grep", count: 1, row: 6 }, // [3]
  { asset: stack("express"), term: ".claude/skills/", count: 1, row: 7 }, // [5]
  { asset: stack("express-mongoose"), term: ".claude/skills/", count: 1, row: 7 }, // [5]
  { asset: stack("monorepo-turbopnpm"), term: "CLAUDE.md", count: 2, row: 8 }, // [3], [5]
  { asset: stack("monorepo-turbopnpm"), term: ".claude/", count: 1, row: 8 }, // [3]
  { asset: stack("bun-keystone"), term: "Grep", count: 1, row: 6 }, // [13]
];

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function config(engines: NavoriConfig["engines"]): NavoriConfig {
  return NavoriConfigSchema.parse({
    name: "apendice",
    engines,
    preset: "custom",
    branchBase: "main",
    language: "en",
  });
}

function claudeMd(engines: NavoriConfig["engines"]): string {
  const cwd = mkdtempSync(join(tmpdir(), "navori-apendice-"));
  dirs.push(cwd);
  renderClaudeEngine(cwd, config(engines));
  return readFileSync(join(cwd, "CLAUDE.md"), "utf-8");
}

function sourceOf(asset: string): string {
  if (asset.startsWith("plugin:")) {
    return readFileSync(
      loadPlugin(asset.slice("plugin:".length)).managedAssets[0]!.absPath,
      "utf-8",
    );
  }
  return readFileSync(join(getCoreRoot(), asset), "utf-8");
}

function countOf(text: string, term: string, ignoreCase = false): number {
  return ignoreCase
    ? text.toLowerCase().split(term.toLowerCase()).length - 1
    : text.split(term).length - 1;
}

describe("claude-apendice: nothing the shared blocks lost is lost for Claude", () => {
  it("every occurrence left its shared asset", () => {
    for (const { asset, term, ignoreCase } of CENSUS) {
      expect(countOf(sourceOf(asset), term, ignoreCase === true), `${asset}: ${term}`).toBe(0);
    }
  });

  it("every occurrence is carried by the appendix row it maps to", () => {
    for (const { asset, term, row, ignoreCase } of CENSUS) {
      expect(APPENDIX_ROWS[row], `${asset}: ${term}`).toBeDefined();
      expect(
        countOf(APPENDIX_ROWS[row]!, term, ignoreCase === true),
        `row ${row} lacks ${term}`,
      ).toBeGreaterThan(0);
    }
  });

  it("counts every occurrence: the census total per asset matches the frozen pre-4a count", () => {
    const total = (asset: string): number =>
      CENSUS.filter((o) => o.asset === asset).reduce((sum, o) => sum + o.count, 0);
    expect(total(OPERACIONES)).toBe(11);
    expect(total(ROUTING)).toBe(2);
    expect(total(TICKETS)).toBe(1);
    expect(total(SDD)).toBe(1);
    expect(total(TGREP)).toBe(1);
    expect(total(stack("express"))).toBe(1);
    expect(total(stack("express-mongoose"))).toBe(1);
    expect(total(stack("monorepo-turbopnpm"))).toBe(3);
    expect(total(stack("bun-keystone"))).toBe(1);
  });

  for (const engines of [["claude"], ["claude", "codex"]] as const) {
    it(`CLAUDE.md of ${engines.join("+")} carries every row, once`, () => {
      const md = claudeMd([...engines]);
      for (const [row, text] of Object.entries(APPENDIX_ROWS)) {
        expect(countOf(md, text), `row ${row}`).toBe(1);
      }
      expect(md).toContain("## Claude Code specifics");
    });
  }
});
