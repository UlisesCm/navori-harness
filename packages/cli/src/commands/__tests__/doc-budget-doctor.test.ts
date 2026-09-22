import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { NavoriConfigSchema, type NavoriConfig, type NavoriConfigInput } from "../../lib/schema.ts";
import { computeHealthVerdict, scanDocBudget } from "../doctor.ts";
import { readCliVersion } from "../../lib/bundled-assets.ts";
import { SESSION_CONTEXT_DELIVERY_BUDGET_CHARS } from "../../lib/doc-budgets.ts";

/**
 * #917 phase 2 — `doctor` prices what a session of this repo pays before its
 * first prompt, against the ceilings phase 1 gave every managed asset.
 *
 * The properties under test are the ones a regression would cost 30 repos:
 * the report separates navori's prose from the user's, it tells "your file is
 * OLD" apart from "your file is FAT", and it never reaches the health verdict.
 */

const CURRENT = readCliVersion();

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), "navori-doc-budget-"));
}

/** A managed block exactly as `openMarker` writes it. */
function block(id: string, body: string, version = CURRENT): string {
  return [
    `<!-- navori:managed id="${id}" hash="deadbeef" version="${version}" source="@navori/core" -->`,
    body,
    `<!-- /navori:managed id="${id}" -->`,
  ].join("\n");
}

function words(n: number): string {
  return Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
}

function writeClaudeMd(cwd: string, content: string): void {
  writeFileSync(join(cwd, "CLAUDE.md"), `${content}\n`);
}

function writeContext(cwd: string, name: string, content: string): void {
  mkdirSync(join(cwd, ".claude", "context"), { recursive: true });
  writeFileSync(join(cwd, ".claude", "context", name), content);
}

function config(overrides: Partial<NavoriConfigInput> = {}): NavoriConfig {
  return NavoriConfigSchema.parse({
    name: "budget",
    engines: ["claude"],
    preset: "custom",
    branchBase: "main",
    qualityGate: { fast: "bun test", full: "bun test" },
    ...overrides,
  });
}

describe("scanDocBudget (#917)", () => {
  it("returns null when there is no CLAUDE.md to measure", () => {
    expect(scanDocBudget(tempRepo())).toBeNull();
  });

  // `tipado-fuerte` ships a 50-word source ceiling, +11 for the rendered marker
  // pair (`MARKER_PAIR_WORDS`) = 61.
  it("reports a file inside its budget with no violation", () => {
    const cwd = tempRepo();
    writeClaudeMd(cwd, block("tipado-fuerte", words(20)));
    const report = scanDocBudget(cwd)!;
    expect(report.ceiling).toBe(61);
    expect(report.overBy).toBe(0);
    expect(report.blocks.map((b) => [b.id, b.kind, b.over])).toEqual([
      ["tipado-fuerte", "static", false],
    ]);
  });

  it("reports a file over its budget, naming the block and its lever", () => {
    const cwd = tempRepo();
    writeClaudeMd(cwd, block("tipado-fuerte", words(200)));
    const report = scanDocBudget(cwd)!;
    expect(report.overBy).toBeGreaterThan(0);
    const over = report.blocks.filter((b) => b.over);
    expect(over.map((b) => b.id)).toEqual(["tipado-fuerte"]);
    expect(over[0]!.lever).toBe("core");
  });

  /**
   * The user's own prose is REPORTED and never capped: navori has no standing
   * over the `CLAUDE.md` of another repo. A repo whose prose dwarfs the managed
   * half is this project itself (536 of its 2307 words), and flagging that
   * would make the report worthless in exactly the repo that wrote it.
   */
  it("reports large user prose without ever marking a violation", () => {
    const cwd = tempRepo();
    writeClaudeMd(cwd, `${words(800)}\n\n${block("tipado-fuerte", words(20))}`);
    const report = scanDocBudget(cwd)!;
    expect(report.ownWords).toBe(800);
    expect(report.managedWords).toBeLessThan(report.ceiling);
    expect(report.overBy).toBe(0);
    expect(report.blocks.some((b) => b.over)).toBe(false);
  });

  /**
   * "Old" and "fat" are different defects with different fixes, and today the
   * first explains everything seen in the wild: `bonum-webapp`'s file on disk
   * is 3208 words rendered by 0.8.7, and a re-render with the current build
   * takes it to 2033 (−37%) without its owner deciding anything.
   */
  it("diagnoses a stale file as OLD, counting the blocks an earlier navori wrote", () => {
    const cwd = tempRepo();
    writeClaudeMd(
      cwd,
      [block("tipado-fuerte", words(200), "0.8.7"), block("idioma-rol", words(20), "0.8.7")].join(
        "\n\n",
      ),
    );
    const report = scanDocBudget(cwd)!;
    expect(report.staleBlocks).toBe(2);
    expect(report.cliVersion).toBe(CURRENT);
  });

  it("does not call a current file stale", () => {
    const cwd = tempRepo();
    writeClaudeMd(cwd, block("tipado-fuerte", words(20)));
    expect(scanDocBudget(cwd)!.staleBlocks).toBe(0);
  });

  /**
   * A computed block has no source asset to budget, so its ceiling is
   * `base + k·rows` — calibrated generously on purpose: `bonum-dashboard`
   * renders 9 rows of `contexto-proyecto` for 335 words, which the user ruled
   * LEGITIMATE use of `project.*`. The formula must not flag it.
   */
  it("prices a computed block by its rows and does not punish a config-heavy repo", () => {
    const cwd = tempRepo();
    const rows = Array.from({ length: 9 }, () => `- ${words(30)}`).join("\n");
    writeClaudeMd(cwd, block("contexto-proyecto", rows));
    const report = scanDocBudget(cwd)!;
    const block0 = report.blocks[0]!;
    expect(block0.kind).toBe("computed");
    expect(block0.rows).toBe(9);
    expect(block0.ceiling).toBe(30 + 45 * 9);
    expect(block0.over).toBe(false);
    expect(block0.lever).toBe("project-context");
  });

  it("measures a block navori ships no ceiling for without inventing one", () => {
    const cwd = tempRepo();
    writeClaudeMd(cwd, block("some-retired-block", words(400)));
    const block0 = scanDocBudget(cwd)!.blocks[0]!;
    expect(block0.kind).toBe("unbudgeted");
    expect(block0.ceiling).toBeNull();
    expect(block0.over).toBe(false);
  });

  it("attributes a plugin block to the plugins lever via its marker source", () => {
    const cwd = tempRepo();
    writeClaudeMd(
      cwd,
      [
        `<!-- navori:managed id="gh-protocol" hash="h" version="${CURRENT}" source="@navori/plugin-gh" -->`,
        words(20),
        `<!-- /navori:managed id="gh-protocol" -->`,
      ].join("\n"),
    );
    expect(scanDocBudget(cwd)!.blocks[0]!.lever).toBe("plugins");
  });

  /**
   * The second surface: `.claude/context/` is REPORTED, never capped. Its own
   * ceiling needs a justified number of its own (#919); what exists today is
   * the SessionStart hook's delivery budget, in characters, past which the hook
   * ships a pointer instead of the body.
   */
  it("reports .claude/context/ alongside CLAUDE.md without capping it", () => {
    const cwd = tempRepo();
    writeClaudeMd(cwd, block("tipado-fuerte", words(20)));
    writeContext(cwd, "10-orquestacion.md", words(900));
    writeContext(cwd, "40-cierre-sesion.md", words(400));
    const report = scanDocBudget(cwd)!;
    expect(report.contextFiles.map((f) => f.path)).toEqual([
      ".claude/context/10-orquestacion.md",
      ".claude/context/40-cierre-sesion.md",
    ]);
    expect(report.contextWords).toBe(1300);
    expect(report.contextChars).toBeGreaterThan(0);
    expect(report.contextDeliveryBudget).toBe(SESSION_CONTEXT_DELIVERY_BUDGET_CHARS);
    // Reported, not capped: the context surface never moves the CLAUDE.md verdict.
    expect(report.overBy).toBe(0);
  });

  /**
   * The subagent factor, stated as a unit cost and nothing more. A non-fork
   * subagent starts with a fresh context window carrying "every level of the
   * CLAUDE.md hierarchy the main conversation loads" (Claude Code docs, "What
   * loads at startup") — but NOT the SessionStart hook's output, and no fixed
   * number of agents per ticket exists to multiply by.
   */
  it("prices a subagent reload as the whole CLAUDE.md, context dir excluded", () => {
    const cwd = tempRepo();
    writeClaudeMd(cwd, `${words(100)}\n\n${block("tipado-fuerte", words(20))}`);
    writeContext(cwd, "10-orquestacion.md", words(900));
    const report = scanDocBudget(cwd)!;
    expect(report.perSubagentWords).toBe(report.totalWords);
    expect(report.perSubagentWords).toBeLessThan(report.totalWords + report.contextWords);
  });
});

/**
 * THE regression that would cost 30 repos (#917, `~/.navori/registry.json`).
 *
 * The budget is warning-level by construction: it must never reach
 * `computeHealthVerdict`, which is what `doctor --strict` and `status --json`
 * both read. Wiring a word count in there turns every registered repo red on
 * the day of a version bump, over prose their owners wrote legitimately.
 *
 * Asserted as an INVARIANCE between two repos identical except for the size of
 * `CLAUDE.md`, so the test depends on no baseline verdict of its own.
 */
describe("the doc budget never moves the health verdict (#917)", () => {
  function repoWith(claudeMd: string): NavoriConfig & { cwd: string } {
    const cwd = tempRepo();
    writeFileSync(join(cwd, "navori.config.json"), JSON.stringify({ name: "budget" }));
    writeClaudeMd(cwd, claudeMd);
    return Object.assign(config(), { cwd });
  }

  it("reports the same ok for a file inside and far outside its budget", () => {
    const small = repoWith(block("tipado-fuerte", words(20)));
    const huge = repoWith(block("tipado-fuerte", words(5000)));

    expect(scanDocBudget(small.cwd)!.overBy).toBe(0);
    expect(scanDocBudget(huge.cwd)!.overBy).toBeGreaterThan(4000);

    const smallVerdict = computeHealthVerdict(small.cwd, config());
    const hugeVerdict = computeHealthVerdict(huge.cwd, config());
    expect(hugeVerdict.ok).toBe(smallVerdict.ok);
  });

  it("publishes no budget field on the verdict at all", () => {
    const repo = repoWith(block("tipado-fuerte", words(5000)));
    const verdict = computeHealthVerdict(repo.cwd, config()) as unknown as Record<string, unknown>;
    expect(Object.keys(verdict).some((k) => k.toLowerCase().includes("budget"))).toBe(false);
  });
});
