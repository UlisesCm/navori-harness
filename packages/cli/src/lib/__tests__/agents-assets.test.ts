import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { getCoreRoot } from "../bundled-assets.ts";

/**
 * Sanity checks for the agent assets shipped with @navori/core.
 * These don't validate semantic content (that's a human review concern);
 * they validate the shape contract the engine adapter (E1) will rely on:
 *
 *   - YAML frontmatter with `name`, `description`, `tools`, `model`.
 *   - A `<!-- navori:user-section -->` sentinel separating managed body
 *     from user-section template.
 *   - Non-empty content on both sides of the sentinel.
 *
 * A new agent role needs no edit here: the list is READ FROM THE DIRECTORY.
 * It used to be hand-maintained behind a prose instruction, and that
 * instruction failed exactly as prose does — `auditor` shipped and stayed
 * outside the shape contract until #417 caught it. Deriving the list is the
 * same move `claude-md-read-mandate.test.ts` (#399) already made.
 *
 * The "no unconditional CLAUDE.md read" guard (#399) is NOT here: it sweeps
 * every managed asset, so it lives in `claude-md-read-mandate.test.ts`.
 */

const AGENTS_DIR = resolve(getCoreRoot(), "core-assets", "agents");

/** Every agent asset on disk, so a new role joins the contract by existing. */
function listAgentIds(): string[] {
  return readdirSync(AGENTS_DIR)
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.slice(0, -".md".length))
    .sort();
}

const AGENT_IDS = listAgentIds();

const SENTINEL = "<!-- navori:user-section -->";

interface ParsedAsset {
  frontmatter: Record<string, string>;
  body: string;
}

function readAgent(id: string): string {
  const path = resolve(getCoreRoot(), "core-assets", "agents", `${id}.md`);
  expect(existsSync(path), `agent asset missing: ${path}`).toBe(true);
  return readFileSync(path, "utf-8");
}

function parseAsset(raw: string): ParsedAsset {
  // Both groups are mandatory in each pattern: either the match yields all of
  // them or there is no match at all, so an absent group IS a failed parse.
  const [, fmBlock, body] = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/) ?? [];
  if (fmBlock === undefined || body === undefined) throw new Error("frontmatter not found");
  const fm: Record<string, string> = {};
  for (const line of fmBlock.split("\n")) {
    const [, key, value] = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/) ?? [];
    if (key !== undefined && value !== undefined) fm[key] = value.trim();
  }
  return { frontmatter: fm, body };
}

describe("core agent assets — shape contract", () => {
  /**
   * A derived list can go vacuous in silence: a bad `getCoreRoot()` or a build
   * that stops copying `core-assets/agents/` would leave zero ids and every
   * case below would simply not run, reporting green. The floor is the roster
   * as of #417 (8 agents) — raise it when the roster grows, never lower it.
   */
  it("derives the agent roster from the directory, and it is not empty", () => {
    expect(AGENT_IDS.length, `no agent assets found under ${AGENTS_DIR}`).toBeGreaterThanOrEqual(8);
    expect(AGENT_IDS).toContain("auditor");
  });

  for (const id of AGENT_IDS) {
    describe(id, () => {
      const raw = readAgent(id);
      const parsed = parseAsset(raw);

      it("has frontmatter with name, description, tools, model", () => {
        expect(parsed.frontmatter.name).toBe(id);
        expect(parsed.frontmatter.description?.length ?? 0).toBeGreaterThan(20);
        expect(parsed.frontmatter.tools?.length ?? 0).toBeGreaterThan(0);
        // `model:` must be present; value is a placeholder like `{{models.X}}`
        expect(parsed.frontmatter.model?.length ?? 0).toBeGreaterThan(0);
      });

      it("`model:` references a `models.X` interpolation key", () => {
        expect(parsed.frontmatter.model).toMatch(/\{\{\s*models\.[a-zA-Z]+\s*\}\}/);
      });

      it("contains the user-section sentinel exactly once", () => {
        const count = (
          raw.match(new RegExp(SENTINEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []
        ).length;
        expect(count).toBe(1);
      });

      it("has non-empty managed body before the sentinel", () => {
        const idx = parsed.body.indexOf(SENTINEL);
        expect(idx).toBeGreaterThan(0);
        const managed = parsed.body.slice(0, idx).trim();
        expect(managed.length).toBeGreaterThan(200);
        // Body must start with a heading (the agent's title).
        expect(managed.startsWith("#")).toBe(true);
      });

      it("has non-empty user-section template after the sentinel", () => {
        const idx = parsed.body.indexOf(SENTINEL);
        const userTpl = parsed.body.slice(idx + SENTINEL.length).trim();
        expect(userTpl.length).toBeGreaterThan(40);
        // Must contain a placeholder comment for the user to fill in.
        expect(userTpl).toMatch(/<!--\s*user:/);
      });
    });
  }
});

describe("core agent assets — interpolation placeholders", () => {
  it("at least one agent references qualityGate (proves wiring path exists)", () => {
    const anyRefs = AGENT_IDS.some((id) => readAgent(id).includes("{{qualityGate."));
    expect(anyRefs).toBe(true);
  });

  it("at least one agent references branchBase", () => {
    const anyRefs = AGENT_IDS.some((id) => readAgent(id).includes("{{branchBase}}"));
    expect(anyRefs).toBe(true);
  });

  it("commit-pr-pilot opens PRs against prTarget (gh pr create --base)", () => {
    expect(readAgent("commit-pr-pilot")).toContain("--base {{prTarget}}");
  });

  it("at least one agent references project.criticalAreas", () => {
    const anyRefs = AGENT_IDS.some((id) => readAgent(id).includes("{{project.criticalAreas}}"));
    expect(anyRefs).toBe(true);
  });
});

/**
 * #344: agents run their shell snippets through the user's shell — zsh on any
 * stock macOS. zsh ties `path`, `fpath`, `cdpath`, `manpath` and `module_path`
 * to array/scalar pairs (`typeset -T PATH path`), so assigning to one of them
 * silently destroys $PATH (or the function search path) and every later command
 * dies with "command not found". The pilot's drift loop shipped exactly that bug
 * and reported false DRIFT on every reviewed file.
 */
describe("core agent assets — no assignment to a zsh-special variable (#344)", () => {
  const ZSH_TIED_ASSIGNMENT = /(^|[;&|(\s])(path|fpath|cdpath|manpath|module_path)=/m;

  for (const id of AGENT_IDS) {
    it(`${id} never assigns to path/fpath/cdpath/manpath/module_path`, () => {
      const offender = ZSH_TIED_ASSIGNMENT.exec(readAgent(id));
      expect(offender?.[2], `use an unambiguous name (file, rel, target) instead`).toBeUndefined();
    });
  }
});
