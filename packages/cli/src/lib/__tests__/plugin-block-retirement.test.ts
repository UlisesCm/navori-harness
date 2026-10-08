import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderClaudeEngine } from "../../engines/claude/index.ts";
import { RETIRED_PLUGIN_BLOCKS } from "../config/plugins.ts";
import { injectManagedSection } from "../render/marker.ts";
import type { NavoriConfig } from "../config/config.ts";

/**
 * #614 — doctrine addressed to one audience leaves the file every agent reads.
 *
 * `jscpd-protocol` and `semgrep-protocol` used to ride in `CLAUDE.md`, which
 * every non-fork subagent receives, to say something only a reviewer acts on.
 * They now inject into the skills that already own those moments — and a skill
 * body is loaded when invoked, not at startup, so the cost moves with the text.
 *
 * The risky half is not the move, it is the MIGRATION: the render strips a
 * plugin's blocks by walking the manifest's current list, so a block dropped
 * from a live plugin is reachable by no branch and would sit in every rendered
 * CLAUDE.md forever. `RETIRED_PLUGIN_BLOCKS` is what closes that, and the second
 * case below is the one that proves it.
 */

const CONFIG = {
  name: "demo",
  engines: ["claude"],
  preset: "custom",
  version: "1.0.0",
  language: "es",
  branchBase: "main",
  commits: "conventional-es",
  plugins: { jscpd: { enabled: true }, semgrep: { enabled: true } },
} as unknown as NavoriConfig;

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-614-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

const read = (rel: string): string => readFileSync(join(cwd, rel), "utf-8");

describe("#614 — the reviewer-only blocks land in the skills, not in CLAUDE.md", () => {
  it("keeps both protocols out of the file every agent receives", () => {
    renderClaudeEngine(cwd, CONFIG);
    const claudeMd = read("CLAUDE.md");
    expect(claudeMd).not.toContain("jscpd-protocol");
    expect(claudeMd).not.toContain("semgrep-protocol");
    // Not just the marker: the prose itself is gone from the startup cost.
    expect(claudeMd).not.toContain("Code duplication (jscpd)");
    expect(claudeMd).not.toContain("Local security gate (semgrep)");
  });

  it("delivers each one to the skill that already owns that moment", () => {
    renderClaudeEngine(cwd, CONFIG);
    const reviewDiff = read(".claude/skills/review-diff/SKILL.md");
    expect(reviewDiff).toContain("Code duplication (jscpd)");
    // The interpolation still happens in the new home — a `$BRANCH_BASE` here
    // would be a silent no-op scan (#273).
    expect(reviewDiff).toContain("git diff --name-only --diff-filter=ACMRT main");

    const security = read(".claude/skills/security-invariants/SKILL.md");
    expect(security).toContain("Local security gate (semgrep)");
    expect(security).toContain("--config=p/default");
  });

  it("preserves the load-bearing invariants both plugins declare", () => {
    renderClaudeEngine(cwd, CONFIG);
    const reviewDiff = read(".claude/skills/review-diff/SKILL.md");
    // `doctor` checks these verbatim against the whole render; moving the text
    // must not be how they disappear.
    expect(reviewDiff).toContain("jscpd");
    expect(reviewDiff).toContain("do not approve");
  });
});

describe("#614 — migration: an already rendered repo loses the orphan", () => {
  /** A root doc as an older navori left it: the block present (pristine, older stamp), in place. */
  function seedWithLegacyBlock(): void {
    renderClaudeEngine(cwd, CONFIG);
    const legacy = injectManagedSection(
      read("CLAUDE.md"),
      "jscpd-protocol",
      "## Code duplication (jscpd)\n\nstale body from a previous render\n",
      { version: "0.7.7", source: "@navori/plugin-jscpd" },
    ).output;
    writeFileSync(join(cwd, "CLAUDE.md"), legacy);
  }

  it("strips a block the plugin no longer declares", () => {
    seedWithLegacyBlock();
    expect(read("CLAUDE.md")).toContain("jscpd-protocol");

    renderClaudeEngine(cwd, CONFIG);

    const after = read("CLAUDE.md");
    expect(after).not.toContain("jscpd-protocol");
    expect(after).not.toContain("stale body from a previous render");
  });

  it("registers every retired block against the plugin that declared it", () => {
    // The registry is the only thing standing between a moved block and an
    // orphan nobody can strip, so its entries are pinned rather than assumed.
    expect(RETIRED_PLUGIN_BLOCKS.jscpd?.blockIds).toContain("jscpd-protocol");
    expect(RETIRED_PLUGIN_BLOCKS.semgrep?.blockIds).toContain("semgrep-protocol");
    expect(RETIRED_PLUGIN_BLOCKS.gh?.blockIds).toContain("gh-protocol");
  });
});

/**
 * #1273 — `gh-protocol` (a retired plugin block) and `skills-index` (a computed
 * Claude block) leave the always-on file through GUARDED removal: a pristine
 * copy goes, one the user edited or a newer navori stamped is kept.
 */
describe("#1273 — guarded removal of gh-protocol and skills-index", () => {
  const GH_CONFIG = {
    ...CONFIG,
    plugins: { gh: { enabled: true } },
  } as unknown as NavoriConfig;
  const USER_PROSE = "\n## Mis notas del repo\n\n- Regla propia del usuario.\n";
  const BODY = "## GitHub CLI\n\nstale body from a previous render\n";

  /** Render, then splice `id` in as an older navori left it and append user prose. */
  function seed(id: string, source: string, version: string): void {
    renderClaudeEngine(cwd, GH_CONFIG);
    const withBlock = injectManagedSection(read("CLAUDE.md"), id, BODY, { version, source }).output;
    writeFileSync(join(cwd, "CLAUDE.md"), withBlock + USER_PROSE);
  }

  /** The seeded block with a word of its body changed, hash left stale. */
  function editBody(): void {
    writeFileSync(join(cwd, "CLAUDE.md"), read("CLAUDE.md").replace("stale body", "my own body"));
  }

  const CASES = [
    { id: "gh-protocol", source: "@navori/plugin-gh" },
    { id: "skills-index", source: "@navori/core" },
  ] as const;

  for (const { id, source } of CASES) {
    it(`removes a pristine ${id} and leaves the user's prose intact`, () => {
      seed(id, source, "0.7.7");
      expect(read("CLAUDE.md")).toContain(`id="${id}"`);

      renderClaudeEngine(cwd, GH_CONFIG);

      const after = read("CLAUDE.md");
      expect(after).not.toContain(`id="${id}"`);
      expect(after).not.toContain("stale body from a previous render");
      expect(after).toContain("- Regla propia del usuario.");
    });

    it(`keeps a ${id} the user edited (user-kept), prose intact`, () => {
      seed(id, source, "0.7.7");
      editBody();

      renderClaudeEngine(cwd, GH_CONFIG);

      const after = read("CLAUDE.md");
      expect(after).toContain(`id="${id}"`);
      expect(after).toContain("my own body");
      expect(after).toContain("- Regla propia del usuario.");
    });

    it(`keeps a ${id} stamped by a newer navori (anti-rollback)`, () => {
      seed(id, source, "999.0.0");

      renderClaudeEngine(cwd, GH_CONFIG);

      const after = read("CLAUDE.md");
      expect(after).toContain(`id="${id}"`);
      expect(after).toContain("stale body from a previous render");
    });
  }

  it("a fresh Claude render ships neither block", () => {
    renderClaudeEngine(cwd, GH_CONFIG);
    const claudeMd = read("CLAUDE.md");
    expect(claudeMd).not.toContain('id="gh-protocol"');
    expect(claudeMd).not.toContain('id="skills-index"');
  });
});
