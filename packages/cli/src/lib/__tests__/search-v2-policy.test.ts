import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getCoreRoot, getPluginPath } from "../bundled-assets.ts";

/**
 * search-v2.md §7 P2 — policy content and the removal of the instructions it
 * replaces.
 *
 * What this file does NOT re-check, because a generic suite already pins it:
 *   - word caps / `maxWords` / `maxWordsComposed`        -> skill-caps.test.ts,
 *     skill-caps-composed.test.ts (iterates every plugin's `skills/*.md`,
 *     `codegraph-access-v2.md` included)
 *   - activation triggers on skill descriptions           -> skill-caps.test.ts
 *   - MCP server/permission/tools: wiring, by-role pairing
 *     and the explorer/researcher by-name carve-out        -> mcp-capability-wiring.test.ts
 *
 * This file is for the two things those don't cover: that the THREE managed
 * bodies actually state the seven routing distinctions (not just that they
 * mention "CodeGraph"/"tgrep" somewhere), and that the specific instructions
 * search-v2 replaced are gone from the specific files P2 edited — not a
 * repo-wide grep where the same words are legitimate as negative examples.
 */

const coreManaged = (file: string) => join(getCoreRoot(), "core-assets/managed", file);
const coreAgent = (file: string) => join(getCoreRoot(), "core-assets/agents", file);
const coreSkill = (file: string) => join(getCoreRoot(), "core-assets/skills", file);
const pluginManaged = (plugin: string, file: string) =>
  join(getPluginPath(plugin), "managed", file);

const read = (path: string): string => readFileSync(path, "utf-8");

describe("the routing distinctions are stated where the policy actually lives", () => {
  const core = read(coreManaged("code-discovery-routing.md"));

  it("core block: no-search — enough evidence already in context", () => {
    expect(core).toContain("Enough current evidence in this context: do not search.");
  });

  it("core block: known-file — a bounded local change goes straight to Read/Edit", () => {
    expect(core).toContain("Known file and a bounded local change: Read/Edit directly.");
  });

  it("core block: filename — a name/path pattern routes to Glob", () => {
    expect(core).toContain("Filename/path patterns: Glob.");
  });

  it("core block: structural — behavior/definitions/relationships/impact route to structural discovery", () => {
    expect(core).toContain(
      "Behavior, definitions, architecture, relationships or impact: structural discovery.",
    );
  });

  it("core block: literal — strings/regex/comments/config route to textual discovery", () => {
    expect(core).toContain(
      "Strings, regex, comments, configuration or literal occurrences: textual discovery.",
    );
  });

  it("core block: mixed — literal-first vs structure-first by entry clue, second provider only for the unanswered dimension", () => {
    expect(core).toContain("Mixed tasks: locate the literal first when it is the entry clue");
    expect(core).toContain("Add the second provider only for the unanswered dimension.");
  });

  it("core block: validation — discovery never substitutes for compiler/linter/tests", () => {
    expect(core).toContain(
      "Validate changes with the project's compiler, linter and tests; discovery is not validation.",
    );
  });

  it("codegraph block: structural provider, scoped to projectPath, never auto-indexes", () => {
    const codegraph = read(pluginManaged("codegraph", "codegraph-search-v2.md"));
    expect(codegraph).toContain("### Structural provider: CodeGraph");
    expect(codegraph).toContain("codegraph_explore");
    expect(codegraph).toContain("projectPath");
    expect(codegraph).toContain("Never initialize an index during ordinary discovery.");
  });

  it("tgrep block: textual provider, index-freshness caveat, never a bare wildcard flag", () => {
    const tgrep = read(pluginManaged("tgrep", "tgrep-search-v2.md"));
    expect(tgrep).toContain("### Textual provider: tgrep");
    expect(tgrep).toContain("tgrep search -n [flags] -- PATTERN ROOT");
    expect(tgrep).toContain("status is not proof of freshness");
    expect(tgrep).toContain("Do not install, start servers or reindex during ordinary discovery.");
  });
});

describe("textual-first-universal is gone from researcher.md, replaced by routing", () => {
  const researcher = read(coreAgent("researcher.md"));

  it("no longer orders Grep/Glob as the universal primary method", () => {
    expect(researcher).not.toContain(
      "Primary method: the native `Grep` (content) and `Glob` (files by name/pattern) tools.",
    );
  });

  it("routes by the nature of the question instead", () => {
    expect(researcher).toContain("Resolve the scoped question by following Code discovery routing");
    expect(researcher).toContain("the enabled structural provider");
  });

  it("no longer requires structural-search as a mandatory preflight for every question", () => {
    expect(researcher).not.toContain(
      "For semantic questions (not just string match), apply `.claude/skills/structural-search/SKILL.md`: locate the right region and open only the confirmed span; don't read whole files by reflex.",
    );
    expect(researcher).toContain(
      "Don't load `.claude/skills/structural-search/SKILL.md` as a mandatory preflight for every question",
    );
  });
});

describe("mandatory entrypoint traversal is gone from explorer.md, demoted to a fallback", () => {
  const explorer = read(coreAgent("explorer.md"));

  it("no longer opens with an unconditional entry-to-leaves walk", () => {
    expect(explorer).not.toContain(
      "Apply `.claude/skills/structural-search/SKILL.md` to locate shapes and entry points without reading whole files.",
    );
  });

  it("asks the structural provider for the map first, and only walks manually when none is available", () => {
    expect(explorer).toContain("Get the map from the enabled structural provider first");
    expect(explorer).toContain("Only when no provider is enabled/available, walk manually");
  });
});

describe("loading structural-search unconditionally is gone from implementer.md", () => {
  const implementer = read(coreAgent("implementer.md"));

  it("no longer orders structural-search as the sole discovery step", () => {
    expect(implementer).not.toContain(
      "To locate the code to touch, apply `.claude/skills/structural-search/SKILL.md`: open only the confirmed span, don't read whole files by reflex.",
    );
  });

  it("routes to the structural provider first, structural-search as its fallback", () => {
    expect(implementer).toContain("follow Code discovery routing (project instructions)");
    expect(implementer).toContain(
      "fall back to `.claude/skills/structural-search/SKILL.md` when it's unavailable",
    );
  });
});

describe("confirm-every-result-with-another-search is gone from structural-search.md", () => {
  const skill = read(coreSkill("structural-search.md"));

  it("no longer carries the Rung 0-2 ladder or its escalation ritual", () => {
    expect(skill).not.toMatch(/Rung \d/);
    expect(skill).not.toContain("Ladder Rung");
  });

  it("no longer orders confirming a memory pointer with a second search before acting", () => {
    expect(skill).not.toContain("Confirm every pointer with a cheap search.");
  });

  it("no longer states a hard ceiling at a rung ('this harness ends at Rung 2')", () => {
    expect(skill).not.toContain("this harness ends at Rung 2");
  });

  it("points to Code discovery routing as the entry point instead of being one itself", () => {
    expect(skill).toContain(
      "Apply Code discovery routing (project instructions) first to pick the right lane.",
    );
    expect(skill.split("\n")[2]).toContain(
      "Not the entry point for relationships or impact: that's Code discovery routing's structural provider.",
    );
  });
});

describe("occurrence counts alone no longer stand in for structural impact evidence", () => {
  it("auditor.md routes risk-pattern occurrences through the structural provider for relationship claims", () => {
    const auditor = read(coreAgent("auditor.md"));
    expect(auditor).toContain(
      "Apply Code discovery routing (project instructions) before collecting evidence",
    );
    expect(auditor).toContain(
      "Occurrences from a text search alone don't demonstrate structural impact",
    );
  });

  it("reviewer.md requires routed evidence for a structural impact claim, not a text match", () => {
    const reviewer = read(coreAgent("reviewer.md"));
    expect(reviewer).toContain(
      "apply Code discovery routing (project instructions) before gathering it",
    );
    expect(reviewer).toContain(
      "occurrences from a text search don't demonstrate structural impact",
    );
  });

  it("ticket-audit.md requires the structural provider to confirm relational size claims", () => {
    const ticketAudit = read(coreAgent("ticket-audit.md"));
    expect(ticketAudit).toContain(
      "applying Code discovery routing (project instructions) before gathering evidence",
    );
    expect(ticketAudit).toContain(
      "an occurrence count alone doesn't demonstrate structural impact",
    );
  });

  it("review-diff.md's guard/policy enumeration requires more than an occurrence count", () => {
    const reviewDiff = read(coreSkill("review-diff.md"));
    expect(reviewDiff).toContain("Code discovery routing's structural provider");
    expect(reviewDiff).toContain(
      "An occurrence count alone doesn't demonstrate the enumeration is complete.",
    );
  });
});

/**
 * Phase G (spec 0026 R16, R18) — tgrep and codegraph enter the routing, so no
 * distributed asset can prescribe a raw shell verb (`grep -r`, `rg PATTERN`,
 * `git grep`) as its discovery recipe, and `structural-search` must defer both
 * lanes to whichever provider is enabled instead of treating native search as
 * the default.
 */
describe("no distributed asset prescribes shell search as discovery", () => {
  // A real recipe (a command with an argument), not a bare mention of the
  // binary's name — `operaciones-seguras.md` says "`rg` is NOT (`rg --pre
  // <cmd>` runs arbitrary code)" as a PERMISSION caveat, not a discovery
  // method, and must keep passing.
  const SHELL_RECIPE = [/`grep -r[a-zA-Z]*\s/, /`rg\s+[^-]/, /`git grep/];

  const distributedAssets = [
    coreSkill("review-diff.md"),
    coreAgent("auditor.md"),
    coreAgent("ticket-audit.md"),
    coreAgent("researcher.md"),
    coreSkill("structural-search.md"),
  ];

  it("no distributed asset prescribes shell search as discovery", () => {
    // Covers: R16
    for (const path of distributedAssets) {
      const content = read(path);
      for (const pattern of SHELL_RECIPE) {
        expect(content, `${path} matched ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("operaciones-seguras keeps its rg --pre warning within its 2,000-byte cap", () => {
    const seguras = read(coreManaged("operaciones-seguras.md"));
    expect(seguras).toContain("`rg --pre <cmd>` runs arbitrary code");
    for (const pattern of SHELL_RECIPE) {
      expect(seguras).not.toMatch(pattern);
    }
    expect(Buffer.byteLength(seguras, "utf-8")).toBeLessThanOrEqual(2000);
  });

  it("structural-search defers both lanes to the enabled provider", () => {
    // Covers: R18
    const skill = read(coreSkill("structural-search.md"));
    expect(skill).toContain("Both lanes defer to the enabled provider");
    expect(skill).toContain("the textual lane resolves through tgrep when the plugin is enabled");
    expect(skill).toContain("the structural lane through CodeGraph when its plugin is enabled");
    expect(skill).toContain("Both fallbacks apply only when no provider is enabled or available");
    // The old wording treated native search as the default lane ahead of the
    // provider — that's exactly what R18 replaces.
    expect(skill).not.toContain(
      "the default lane for a literal token (name, import, config key, error string) or a filename/path pattern",
    );
  });
});
