import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHarnessCatalog } from "../harness.ts";

/**
 * `readHarnessCatalog` is the half of `navori audit` no external tool can
 * produce: the transcript records how many tokens an agent's startup context
 * cost, never what was IN it, so attributing that cost to CLAUDE.md sections —
 * or noticing that a section orders a tool the agent cannot reach — means
 * reading the repo's own harness files.
 *
 * It shipped with zero tests (#561) while feeding the report's ONLY `high`
 * signal, `unreachable-instructions`: `sections[].requiresMcp` × `agents[]
 * .hasMcp` is what that number is computed from. A parse that drifts there does
 * not crash — it prints a confident wrong number at the top of the report. The
 * same shape of gap in `ownerOf` (#558) is where 408 of 2537 events landed on
 * the wrong card.
 *
 * Two defects these specs found on arrival, both of them silent:
 *
 *  - a fenced ```` ```markdown ```` block containing `## Something` — ordinary
 *    in a CLAUDE.md that documents a template — was read as a real heading. The
 *    section it interrupted lost every byte after the fence, and the phantom
 *    section carried them instead. Both `requiresMcp` and the token cost of the
 *    `high` signal move with that split.
 *  - `tools:` was matched anywhere in an agent file, frontmatter or not. An
 *    agent whose BODY shows a `tools:` example was read as declaring an
 *    allowlist, and one written as a YAML block list was read as the single
 *    entry `- Read`. In both cases `hasMcp` came back false for an agent that
 *    reaches MCP fine — inventing `high`-severity waste that does not exist.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "navori-harness-cat-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Writes an agent definition under `.claude/agents/<name>.md`. */
function agentFile(name: string, contents: string): void {
  const dir = join(root, ".claude", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), contents, "utf-8");
}

/** Frontmatter + body, the shape every agent definition has on disk. */
function agent(name: string, frontmatter: string[], body = "Body prose."): void {
  agentFile(name, ["---", `name: ${name}`, ...frontmatter, "---", "", body, ""].join("\n"));
}

function claudeMd(...lines: string[]): void {
  writeFileSync(join(root, "CLAUDE.md"), lines.join("\n"), "utf-8");
}

describe("readHarnessCatalog: an absent harness is empty, never a throw", () => {
  it("reports nothing for a repo with no .claude/ and no CLAUDE.md", () => {
    const cat = readHarnessCatalog(root);
    expect(cat.agents).toEqual([]);
    expect(cat.skills).toEqual([]);
    expect(cat.sections).toEqual([]);
    expect(cat.claudeMdTokens).toBe(0);
  });

  it("exposes the MCP families it knows about, so the report never re-lists them", () => {
    // A server named in two places is a server that will be named in only one
    // of them after the next edit — hence a single source, sorted.
    expect(readHarnessCatalog(root).mcpFamilies).toEqual(["codegraph", "engram"]);
  });

  it("survives an unreadable agent file by assuming it reaches everything", () => {
    // A directory named `x.md` inside agents/: readdir lists it, readFile
    // throws EISDIR. The degraded answer must not be `hasMcp: false`, which
    // would fabricate the high-severity signal out of an I/O error.
    mkdirSync(join(root, ".claude", "agents", "broken.md"), { recursive: true });
    expect(readHarnessCatalog(root).agents).toEqual([
      { name: "broken", tools: null, hasMcp: true },
    ]);
  });
});

describe("readHarnessCatalog: `tools:` is an allowlist, and it lives in the frontmatter", () => {
  it("reads an inline list and sees the mcp__ entry", () => {
    agent("explorer", ["tools: Read, Glob, Grep, Bash, Write, mcp__codegraph__*"]);
    expect(readHarnessCatalog(root).agents[0]).toEqual({
      name: "explorer",
      tools: ["Read", "Glob", "Grep", "Bash", "Write", "mcp__codegraph__*"],
      hasMcp: true,
    });
  });

  it("an explicit list with no mcp__ entry cannot reach MCP", () => {
    // This is the whole premise of `unreachable-instructions`: the field is an
    // allowlist that covers MCP servers too, so leaving them out denies them.
    agent("implementer", ["tools: Read, Write, Edit, Glob, Grep, Bash"]);
    expect(readHarnessCatalog(root).agents[0]?.hasMcp).toBe(false);
  });

  it("`*` reaches everything", () => {
    agent("claude", ["tools: *"]);
    expect(readHarnessCatalog(root).agents[0]?.hasMcp).toBe(true);
  });

  it("no `tools:` at all inherits everything", () => {
    agent("free", ["description: no tools field"]);
    expect(readHarnessCatalog(root).agents[0]).toEqual({
      name: "free",
      tools: null,
      hasMcp: true,
    });
  });

  it("reads a YAML block list, mcp__ entries included (#561)", () => {
    // `tools:` with the list underneath is valid YAML for the same field. Read
    // as a same-line value it used to yield `["- Read"]` and hasMcp false — an
    // agent that reaches MCP counted as blind, i.e. invented `high` waste.
    agent("blocklist", ["tools:", "  - Read", "  - Bash", "  - mcp__engram__*"]);
    expect(readHarnessCatalog(root).agents[0]).toEqual({
      name: "blocklist",
      tools: ["Read", "Bash", "mcp__engram__*"],
      hasMcp: true,
    });
  });

  it("reads a YAML flow sequence", () => {
    agent("flowseq", ['tools: ["Read", "mcp__codegraph__*"]']);
    expect(readHarnessCatalog(root).agents[0]).toEqual({
      name: "flowseq",
      tools: ["Read", "mcp__codegraph__*"],
      hasMcp: true,
    });
  });

  it("ignores a `tools:` line that is body prose, not a declaration (#561)", () => {
    // An agent file that DOCUMENTS the field — a template, an example, a doc
    // agent — declares nothing. Reading it as a declaration turned an agent
    // with full access into a blind one.
    agent(
      "documenting",
      ["description: explains the frontmatter"],
      ["Declare the allowlist like this:", "", "```yaml", "tools: Read, Bash", "```"].join("\n"),
    );
    expect(readHarnessCatalog(root).agents[0]).toEqual({
      name: "documenting",
      tools: null,
      hasMcp: true,
    });
  });

  it("a file with no frontmatter declares nothing", () => {
    agentFile("bare", "Just prose.\ntools: Read\n");
    expect(readHarnessCatalog(root).agents[0]).toEqual({
      name: "bare",
      tools: null,
      hasMcp: true,
    });
  });

  it("lists agents by name and ignores non-markdown files", () => {
    agent("zeta", ["tools: Read"]);
    agent("alpha", ["tools: Read"]);
    writeFileSync(join(root, ".claude", "agents", "notes.txt"), "tools: Read", "utf-8");
    expect(readHarnessCatalog(root).agents.map((a) => a.name)).toEqual(["alpha", "zeta"]);
  });
});

describe("readHarnessCatalog: skills, in both layouts", () => {
  function skillDir(name: string, withSkillMd: boolean): void {
    const dir = join(root, ".claude", "skills", name);
    mkdirSync(dir, { recursive: true });
    if (withSkillMd) writeFileSync(join(dir, "SKILL.md"), "# skill", "utf-8");
  }

  it("takes a directory only when it carries a SKILL.md", () => {
    skillDir("review-diff", true);
    skillDir("leftovers", false);
    expect(readHarnessCatalog(root).skills).toEqual(["review-diff"]);
  });

  it("takes a flat `<id>.md` as a skill of its own", () => {
    mkdirSync(join(root, ".claude", "skills"), { recursive: true });
    writeFileSync(join(root, ".claude", "skills", "playwright-cli.md"), "# local", "utf-8");
    expect(readHarnessCatalog(root).skills).toEqual(["playwright-cli"]);
  });

  it("sorts them, and never counts a bare SKILL.md at the root as a skill", () => {
    skillDir("zod-validation", true);
    mkdirSync(join(root, ".claude", "skills"), { recursive: true });
    writeFileSync(join(root, ".claude", "skills", "SKILL.md"), "# stray", "utf-8");
    writeFileSync(join(root, ".claude", "skills", "citty.md"), "# lib", "utf-8");
    expect(readHarnessCatalog(root).skills).toEqual(["citty", "zod-validation"]);
  });
});

describe("readHarnessCatalog: CLAUDE.md sections carry the cost of the high signal", () => {
  it("sizes each section and estimates its tokens at chars/4", () => {
    const body = "# Repo\n\n## Engram\nCall mem_search before code.\n\n## Plain\nNo tools here.";
    writeFileSync(join(root, "CLAUDE.md"), body, "utf-8");
    // A section runs from its heading to the next one: the newline that
    // separates them belongs to the section above it.
    const engram = body.slice(body.indexOf("## Engram"), body.indexOf("## Plain"));
    const section = readHarnessCatalog(root).sections.find((s) => s.title === "Engram");
    expect(section?.chars).toBe(engram.length);
    expect(section?.tokens).toBe(Math.round(engram.length / 4));
    expect(readHarnessCatalog(root).claudeMdTokens).toBe(Math.round(body.length / 4));
  });

  it("flags the MCP servers a section instructs the reader to use", () => {
    claudeMd(
      "## Engram",
      "Run mem_save after a decision.",
      "",
      "## CodeGraph",
      "Call codegraph_explore before a grep crawl.",
      "",
      "## Commits",
      "Conventional, atomic.",
    );
    const byTitle = Object.fromEntries(
      readHarnessCatalog(root).sections.map((s) => [s.title, s.requiresMcp]),
    );
    expect(byTitle.Engram).toEqual(["engram"]);
    expect(byTitle.CodeGraph).toEqual(["codegraph"]);
    expect(byTitle.Commits).toEqual([]);
  });

  it("keeps the preamble before the first `## ` as a section of its own", () => {
    claudeMd("# CLAUDE.md — repo", "", "Intro prose.", "", "## First", "x");
    expect(readHarnessCatalog(root).sections.map((s) => s.title)).toEqual([
      "CLAUDE.md — repo",
      "First",
    ]);
  });

  it("does not split on a `## ` inside a fenced block (#561)", () => {
    // A CLAUDE.md that documents a PR template has `## Summary` inside a fence.
    // Read as a heading it invents a section AND truncates the real one — the
    // `mem_search` line below the fence stopped counting as Engram's, so the
    // section's MCP flag and its token cost both moved to a phantom.
    claudeMd(
      "## Engram",
      "The body template looks like this:",
      "",
      "```markdown",
      "## Summary",
      "- one bullet",
      "```",
      "",
      "Call mem_search before you touch code.",
      "",
      "## Real",
      "Another section.",
    );
    const cat = readHarnessCatalog(root);
    expect(cat.sections.map((s) => s.title)).toEqual(["Engram", "Real"]);
    expect(cat.sections.find((s) => s.title === "Engram")?.requiresMcp).toEqual(["engram"]);
  });

  it("counts every byte of CLAUDE.md, fenced or not", () => {
    const body = ["## One", "```", "## Fenced", "```", "", "## Two", "end"].join("\n");
    writeFileSync(join(root, "CLAUDE.md"), body, "utf-8");
    const cat = readHarnessCatalog(root);
    expect(cat.claudeMdTokens).toBe(Math.round(body.length / 4));
    // No byte is lost or double-counted when the sections are put back together.
    expect(cat.sections.reduce((sum, s) => sum + s.chars, 0)).toBe(body.length);
  });

  it("degrades to no sections when CLAUDE.md is missing", () => {
    agent("solo", ["tools: Read"]);
    const cat = readHarnessCatalog(root);
    expect(cat.sections).toEqual([]);
    expect(cat.claudeMdTokens).toBe(0);
    expect(cat.agents).toHaveLength(1);
  });
});
