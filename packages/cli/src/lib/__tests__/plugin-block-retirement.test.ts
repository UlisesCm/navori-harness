import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderClaudeEngine } from "../../engines/claude/index.ts";
import { RETIRED_PLUGIN_BLOCKS } from "../plugins.ts";
import type { NavoriConfig } from "../config.ts";

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
    expect(reviewDiff).toContain("main...HEAD");

    const security = read(".claude/skills/security-guidance/SKILL.md");
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
  /** A CLAUDE.md as an older navori left it: the block present, in place. */
  function seedWithLegacyBlock(): void {
    renderClaudeEngine(cwd, CONFIG);
    const claudeMd = read("CLAUDE.md");
    const legacy =
      `<!-- navori:managed id="jscpd-protocol" hash="deadbeef" version="0.7.7" source="@navori/plugin-jscpd" -->\n` +
      `## Code duplication (jscpd)\n\nstale body from a previous render\n` +
      `<!-- /navori:managed id="jscpd-protocol" -->\n`;
    writeFileSync(join(cwd, "CLAUDE.md"), `${claudeMd}\n${legacy}`);
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
  });
});
