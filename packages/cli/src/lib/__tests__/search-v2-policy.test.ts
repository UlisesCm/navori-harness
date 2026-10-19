import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getCoreRoot, getPluginPath } from "../render/bundled-assets.ts";

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
    expect(core).toContain("do not search.");
  });

  it("core block: known-file — a bounded local change goes straight to Read/Edit", () => {
    expect(core).toContain("Read/Edit directly.");
  });

  it("core block: filename — a name/path pattern routes to Glob", () => {
    expect(core).toContain("Filename/path patterns: Glob.");
  });

  it("core block: structural — behavior/definitions/relationships/impact route to structural discovery", () => {
    expect(core).toContain("relationships or impact: structural discovery.");
  });

  it("core block: literal — strings/regex/comments/config route to textual discovery", () => {
    expect(core).toContain("literal occurrences: textual discovery.");
  });

  it("core block: mixed — literal-first vs structure-first by entry clue, second provider only for the unanswered dimension", () => {
    expect(core).toContain("locate the literal first");
    expect(core).toContain("only for the unanswered dimension.");
  });

  it("core block: validation — discovery never substitutes for compiler/linter/tests", () => {
    expect(core).toContain("discovery is not validation.");
  });

  it("codegraph block: structural provider, scoped to projectPath, never auto-indexes", () => {
    const codegraph = read(pluginManaged("codegraph", "codegraph-search-v2.md"));
    expect(codegraph).toContain("### Structural provider: CodeGraph");
    expect(codegraph).toContain("codegraph_explore");
    expect(codegraph).toContain("projectPath");
    expect(codegraph).toContain("Never initialize an index");
  });

  // Covers: R34
  it("codegraph assets do not promise maxFiles bounds unsupported by T31", () => {
    const block = read(pluginManaged("codegraph", "codegraph-search-v2.md"));
    const skill = read(join(getPluginPath("codegraph"), "skills", "codegraph-access-v2.md"));
    for (const asset of [block, skill]) {
      expect(asset).not.toContain("Pass `maxFiles` to bound");
    }
    expect(block).toContain("projectPath");
    expect(block).toContain("use scoped native exploration.");
    expect(skill).toContain("Continue with scoped native tools");
  });

  it("tgrep block: textual provider, index-freshness caveat, never a bare wildcard flag", () => {
    const tgrep = read(pluginManaged("tgrep", "tgrep-search-v2.md"));
    expect(tgrep).toContain("### Textual provider: tgrep");
    expect(tgrep).toContain("tgrep search -n [flags]");
    expect(tgrep).toContain("refreshes only under `tgrep serve`");
    expect(tgrep).toContain("shows `Server: not running`");
    expect(tgrep).toContain("Do not install, start servers");
  });
});

describe("textual-first-universal is gone from scout.md (researcher+explorer merge, spec 0026 T12), replaced by routing", () => {
  const scout = read(coreAgent("scout.md"));

  it("no longer orders Grep/Glob as the universal primary method", () => {
    expect(scout).not.toContain("Primary method: the native `Grep`");
  });

  it("routes by the nature of the question instead", () => {
    expect(scout).toContain("following Code discovery routing");
    expect(scout).toContain("the enabled structural provider");
  });

  it("no longer requires locate-code as a mandatory preflight for every question", () => {
    expect(scout).not.toContain("For semantic questions (not just");
  });

  it("no longer opens with an unconditional entry-to-leaves walk", () => {
    expect(scout).not.toContain("locate shapes and entry points");
  });

  it("asks the structural provider for the map first, and only walks manually when none is available", () => {
    expect(scout).toContain("enabled structural provider first");
    expect(scout).toContain("Only when no provider");
  });
});

describe("loading locate-code unconditionally is gone from implementer.md", () => {
  const implementer = read(coreAgent("implementer.md"));

  it("no longer orders locate-code as the sole discovery step", () => {
    expect(implementer).not.toContain("To locate the code");
  });

  it("routes to the structural provider first, locate-code as its fallback", () => {
    expect(implementer).toContain("follow Code discovery routing");
    expect(implementer).toContain("fall back to `.claude/skills/locate-code/SKILL.md`");
  });
});

describe("confirm-every-result-with-another-search is gone from locate-code.md", () => {
  const skill = read(coreSkill("locate-code.md"));

  it("no longer carries the Rung 0-2 ladder or its escalation ritual", () => {
    expect(skill).not.toMatch(/Rung \d/);
    expect(skill).not.toContain("Ladder Rung");
  });

  it("no longer orders confirming a memory pointer with a second search before acting", () => {
    expect(skill).not.toContain("Confirm every pointer");
  });

  it("no longer states a hard ceiling at a rung ('this harness ends at Rung 2')", () => {
    expect(skill).not.toContain("ends at Rung 2");
  });

  it("points to Code discovery routing as the entry point instead of being one itself", () => {
    expect(skill).toContain("to pick the right lane.");
    expect(skill.split("\n")[2]).toContain("Not the entry point for");
  });
});

describe("occurrence counts alone no longer stand in for structural impact evidence", () => {
  it("auditor.md routes risk-pattern occurrences through the structural provider for relationship claims", () => {
    const auditor = read(coreAgent("auditor.md"));
    expect(auditor).toContain("before collecting evidence");
    expect(auditor).toContain("don't demonstrate structural impact");
  });

  it("reviewer.md leaves routed evidence to the always-on routing instead of a private copy (#1264)", () => {
    // Setup 5 restated what the always-on Code discovery routing already says
    // (impact and relationships go to structural discovery; pinned above on the
    // core block, and injected into the reviewer by the codegraph/tgrep access
    // blocks, see search-v2-render.test.ts ROLE_AGENTS). Restating it cost bytes in
    // every review dispatch and could drift from the block it copies.
    const reviewer = read(coreAgent("reviewer.md"));
    expect(reviewer).not.toContain("apply Code discovery routing");
    expect(reviewer).not.toContain("don't demonstrate structural impact");
    expect(read(coreManaged("code-discovery-routing.md"))).toContain(
      "relationships or impact: structural discovery.",
    );
  });

  it("auditor.md's ticket encargo requires the structural provider to confirm relational size claims (spec 0026 T12, ticket-audit merge)", () => {
    const auditor = read(coreAgent("auditor.md"));
    expect(auditor).toContain("through the routed provider");
    expect(auditor).toContain("an occurrence count alone");
  });

  // Spec 0026 T15 (R32, R33) — the guard/policy enumeration moved from
  // review-diff §4 to security-invariants, its single owner.
  it("security-invariants's guard/policy enumeration requires more than an occurrence count", () => {
    const securityInvariants = read(coreSkill("security-invariants.md"));
    expect(securityInvariants).toContain("Code discovery routing's structural provider");
    expect(securityInvariants).toContain("An occurrence count alone");
  });
});

/**
 * Phase G (spec 0026 R16, R18) — tgrep and codegraph enter the routing, so no
 * distributed asset can prescribe a raw shell verb (`grep -r`, `rg PATTERN`,
 * `git grep`) as its discovery recipe, and `locate-code` must defer both
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
    coreAgent("scout.md"),
    coreSkill("locate-code.md"),
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
    expect(seguras).toContain("runs arbitrary code");
    for (const pattern of SHELL_RECIPE) {
      expect(seguras).not.toMatch(pattern);
    }
    expect(Buffer.byteLength(seguras, "utf-8")).toBeLessThanOrEqual(2000);
  });

  // Covers: R43, R44
  it("operaciones-seguras keeps its 2,000-byte cap AFTER the retired-names NFKC sweep", () => {
    // spec 0026 T17 DoD: this file sits at 1,993 of 2,000 bytes and is inside
    // the retired-names sweep's area (`core-assets/managed`), which
    // NFKC-normalizes content before matching. Measure both sides explicitly
    // instead of assuming normalization is a byte-for-byte no-op — a composed
    // vs. decomposed accent, or a look-alike Unicode punctuation mark, can
    // change length even with no visible edit.
    const raw = read(coreManaged("operaciones-seguras.md"));
    const before = Buffer.byteLength(raw, "utf-8");
    const after = Buffer.byteLength(raw.normalize("NFKC"), "utf-8");
    expect(before).toBeLessThanOrEqual(2000);
    expect(after).toBeLessThanOrEqual(2000);
  });

  it("locate-code defers both lanes to the enabled provider", () => {
    // Covers: R18
    const skill = read(coreSkill("locate-code.md"));
    expect(skill).toContain("Both lanes defer");
    expect(skill).toContain("textual lane resolves through tgrep");
    expect(skill).toContain("structural lane through CodeGraph");
    expect(skill).toContain("Both fallbacks apply only when");
    // The old wording treated native search as the default lane ahead of the
    // provider — that's exactly what R18 replaces.
    expect(skill).not.toContain("default lane for a literal");
  });
});
