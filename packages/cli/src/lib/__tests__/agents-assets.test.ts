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

/**
 * Spec 0015 R5 (#573) — what made it safe to take the routing doctrine out of
 * `CLAUDE.md`.
 *
 * That block carried one paragraph aimed at subagents: where each writes its
 * report, the `Status:` / verdict line that closes it, and the ban on touching
 * `progress/current.md`. Moving the block would have dropped that on the floor
 * — except every agent already declares its own half, which is why the move
 * cost nothing.
 *
 * So the duplication is load-bearing, and it looks exactly like the redundancy
 * somebody tidies up on a slow afternoon. This is the test that makes that
 * tidy-up fail instead of silently un-teaching every subagent how to report.
 */
describe("each agent declares its own handoff contract (#573)", () => {
  /** agent id -> the strings its own asset must keep declaring. */
  const CONTRACT: ReadonlyArray<readonly [string, readonly string[]]> = [
    ["implementer", ["impl_<feature>.md", "Status:"]],
    ["reviewer", ["review_<feature>.md", "APPROVED"]],
    ["ticket-audit", ["audit_ticket_"]],
    ["explorer", ["explore_"]],
    ["researcher", ["research_"]],
    ["auditor", ["audit_deep_"]],
  ];

  it.each(CONTRACT.map(([id, needles]) => [id, needles] as const))(
    "%s names its own report file and how it closes it",
    (id, needles) => {
      const body = readFileSync(resolve(AGENTS_DIR, `${id}.md`), "utf-8");
      for (const needle of needles) {
        expect(
          body,
          `${id}.md no longer declares "${needle}". The routing doctrine used to say it for ` +
            "everyone, and since #573 that block does not reach subagents at all — so this " +
            "asset is now the only place its own agent learns how to hand work back.",
        ).toContain(needle);
      }
    },
  );

  it("keeps the ban on writing the session's own progress file where the writer reads it", () => {
    // `progress/current.md` is consolidated by the orchestrator, and implementers
    // can run in parallel: two of them writing it is a lost report, not a merge.
    expect(readFileSync(resolve(AGENTS_DIR, "implementer.md"), "utf-8")).toContain(
      "progress/current.md",
    );
  });
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
