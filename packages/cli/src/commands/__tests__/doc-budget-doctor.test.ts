import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NavoriConfigSchema, type NavoriConfig, type NavoriConfigInput } from "../../lib/schema.ts";
import { computeHealthVerdict, docBudgetLines, scanDocBudget } from "../doctor.ts";
import { tc } from "../../lib/i18n.ts";
import { readCliVersion } from "../../lib/bundled-assets.ts";
import {
  CODEX_PROJECT_DOC_MAX_BYTES,
  CODEX_PROJECT_DOC_WARN_RATIO,
  MARKER_PAIR_WORDS,
  SESSION_CONTEXT_DELIVERY_BUDGET_CHARS,
} from "../../lib/doc-budgets.ts";

/**
 * #917 phase 2 — `doctor` prices what a session of this repo pays before its
 * first prompt, against the ceilings phase 1 gave every managed asset.
 *
 * The properties under test are the ones a regression would cost 30 repos:
 * the report separates navori's prose from the user's, it tells "your file is
 * OLD" apart from "your file is FAT", and it never reaches the health verdict.
 */

const CURRENT = readCliVersion();
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");

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
  it("returns null only when the repo has NO startup surface at all", () => {
    expect(scanDocBudget(tempRepo(), config())).toBeNull();
  });

  /**
   * A repo on a prose engine has no `CLAUDE.md`, and the budget used to go
   * silent there — a panel titled "what every session pays" reporting nothing
   * about a repo whose whole startup cost is one file. The Claude half comes
   * back null (there is none), the rest is still measured.
   */
  it("still reports when there is no CLAUDE.md but another surface exists", () => {
    const cwd = tempRepo();
    writeContext(cwd, "10-orquestacion.md", words(900));
    const report = scanDocBudget(cwd, config())!;
    expect(report).not.toBeNull();
    expect(report.totalWords).toBeNull();
    expect(report.managedWords).toBeNull();
    expect(report.ceiling).toBeNull();
    expect(report.overBy).toBeNull();
    expect(report.perSubagentWords).toBeNull();
    expect(report.blocks).toEqual([]);
    expect(report.contextWords).toBe(900);
  });

  it("omits the CLAUDE.md lines entirely instead of printing them as zeros", () => {
    const cwd = tempRepo();
    writeContext(cwd, "10-orquestacion.md", words(900));
    const lines = docBudgetLines(scanDocBudget(cwd, config())!, tc("es").doctor);
    expect(lines.some((l) => l.includes("CLAUDE.md"))).toBe(false);
    expect(lines.some((l) => l.includes(".claude/context/"))).toBe(true);
  });

  // `tipado-fuerte` ships a 50-word source ceiling, +11 for the rendered marker
  // pair (`MARKER_PAIR_WORDS`) = 61.
  it("reports a file inside its budget with no violation", () => {
    const cwd = tempRepo();
    writeClaudeMd(cwd, block("tipado-fuerte", words(20)));
    const report = scanDocBudget(cwd, config())!;
    expect(report.ceiling).toBe(61);
    expect(report.overBy).toBe(0);
    expect(report.blocks.map((b) => [b.id, b.kind, b.over])).toEqual([
      ["tipado-fuerte", "static", false],
    ]);
  });

  it("reports a file over its budget, naming the block and its lever", () => {
    const cwd = tempRepo();
    writeClaudeMd(cwd, block("tipado-fuerte", words(200)));
    const report = scanDocBudget(cwd, config())!;
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
    const report = scanDocBudget(cwd, config())!;
    expect(report.ownWords).toBe(800);
    expect(report.managedWords!).toBeLessThan(report.ceiling!);
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
    const report = scanDocBudget(cwd, config())!;
    expect(report.staleBlocks).toBe(2);
    expect(report.cliVersion).toBe(CURRENT);
  });

  it("does not call a current file stale", () => {
    const cwd = tempRepo();
    writeClaudeMd(cwd, block("tipado-fuerte", words(20)));
    expect(scanDocBudget(cwd, config())!.staleBlocks).toBe(0);
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
    const report = scanDocBudget(cwd, config())!;
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
    const block0 = scanDocBudget(cwd, config())!.blocks[0]!;
    expect(block0.kind).toBe("unbudgeted");
    expect(block0.ceiling).toBeNull();
    expect(block0.over).toBe(false);
  });

  /**
   * An unbudgeted block adds to `managedWords` and contributes ZERO to
   * `ceiling`, so counting it in the quotient reports an excess the metric
   * invented. Measured on the real `bonum-webapp` file: `engram-protocol` (497)
   * + `codegraph-protocol` (255) were 752 of a 1207 `overBy` — 62% artifact.
   * They stay visible in `unbudgetedWords`; they just stop being "over budget".
   */
  it("keeps unbudgeted blocks out of overBy while still publishing them", () => {
    const cwd = tempRepo();
    writeClaudeMd(
      cwd,
      [block("tipado-fuerte", words(20)), block("engram-protocol", words(497))].join("\n\n"),
    );
    const report = scanDocBudget(cwd, config())!;
    // Body + the marker pair, which is exactly the constant the ceilings add.
    expect(report.unbudgetedWords).toBe(497 + MARKER_PAIR_WORDS);
    expect(report.managedWords!).toBeGreaterThan(report.ceiling!);
    // …and yet nothing is over budget: the only budgeted block fits.
    expect(report.overBy).toBe(0);
    expect(report.blocks.some((b) => b.over)).toBe(false);
  });

  /**
   * The reload is a CLAUDE fact, not a portable one. A Codex subagent is
   * spawned from a custom agent file whose required fields include its own
   * `developer_instructions`; the doc documents no re-concatenation of
   * `AGENTS.md` per subagent (verified live, 2026-09-22). Printing the Claude
   * number in a Codex-only repo would be inventing a cost.
   */
  it("does not claim the subagent reload on a repo without the claude engine", () => {
    const cwd = tempRepo();
    writeClaudeMd(cwd, block("tipado-fuerte", words(20)));
    const codexOnly = config({ engines: ["codex"] });
    expect(scanDocBudget(cwd, codexOnly)!.perSubagentWords).toBeNull();
    expect(scanDocBudget(cwd, config())!.perSubagentWords).not.toBeNull();

    const lines = docBudgetLines(scanDocBudget(cwd, codexOnly)!, tc("es").doctor);
    expect(lines.some((l) => l.includes("subagente"))).toBe(false);
    // The rest of the Claude surface is still reported: the repo does have a
    // CLAUDE.md, it just isn't Claude that spawns its subagents.
    expect(lines.some((l) => l.includes("CLAUDE.md"))).toBe(true);
  });

  /**
   * Codex's surface. It is REPORTED against the host's byte cap and never
   * capped by navori: the chain also carries the user's `~/.codex/AGENTS.md`
   * and any nested file, so a repo's own share is a LOWER bound.
   */
  it("reports AGENTS.md in bytes against Codex's cap, without capping it", () => {
    const cwd = tempRepo();
    writeFileSync(join(cwd, "AGENTS.md"), `${words(100)}\n`);
    const report = scanDocBudget(cwd, config())!;
    expect(report.agentsMd?.words).toBe(100);
    expect(report.agentsMd?.chars).toBe(Buffer.byteLength(`${words(100)}\n`, "utf-8"));
    expect(report.agentsMdMaxBytes).toBe(CODEX_PROJECT_DOC_MAX_BYTES);
    // No Claude surface here at all, and the report still exists.
    expect(report.totalWords).toBeNull();
    expect(report.overBy).toBeNull();
    // A plain file with no `navori-agents` marker carries no navori block at
    // all, so it prices as zero rather than being "unbudgeted" (there is no
    // block to leave unbudgeted).
    expect(report.agentsMdCeiling).toBe(0);
    expect(report.agentsMdOverBy).toBe(0);
  });

  /**
   * #930 — the defect the issue names literally: before this, measuring
   * `AGENTS.md`'s `navori-agents` block gave `ceiling 0` / `unbudgeted 100%` /
   * `overBy 0` — green by construction, not by being inside a budget.
   * `PROSE_WRAPPER_CEILINGS` (`doc-budgets.ts`) closes that: a real
   * `navori-agents` block now prices against a real, positive ceiling.
   */
  it("gives navori-agents a real ceiling instead of reading 0 by construction", () => {
    const cwd = tempRepo();
    writeFileSync(join(cwd, "AGENTS.md"), `${block("navori-agents", words(100))}\n`);
    const report = scanDocBudget(cwd, config())!;
    expect(report.agentsMdCeiling).toBeGreaterThan(0);
    expect(report.agentsMdOverBy).toBe(0);
    // Never touches the Claude-surface fields — this is a DIFFERENT file.
    expect(report.ceiling).toBeNull();
  });

  it("reports an AGENTS.md over its word ceiling, informatively", () => {
    const cwd = tempRepo();
    writeFileSync(join(cwd, "AGENTS.md"), `${block("navori-agents", words(5000))}\n`);
    const report = scanDocBudget(cwd, config())!;
    expect(report.agentsMdOverBy).toBeGreaterThan(0);
    const lines = docBudgetLines(report, tc("es").doctor);
    expect(lines.some((l) => l.includes("navori-agents"))).toBe(true);
    // Informative only: never reaches the health verdict, same doctrine as
    // every other line on this report (`ownWords`, the byte cap, staleness).
    expect(computeHealthVerdict(cwd, config()).ok).toBe(true);
  });

  it("stays silent about the word ceiling when AGENTS.md is within budget", () => {
    const cwd = tempRepo();
    writeFileSync(join(cwd, "AGENTS.md"), `${block("navori-agents", words(100))}\n`);
    const lines = docBudgetLines(scanDocBudget(cwd, config())!, tc("es").doctor);
    expect(lines.some((l) => l.includes("navori-agents"))).toBe(false);
  });

  /**
   * #930 — the exact defect the issue reports, measured against THIS repo's
   * real, checked-in `AGENTS.md` (not a synthetic fixture): before
   * `PROSE_WRAPPER_CEILINGS`, this read `ceiling: 0` / `unbudgetedWords ===
   * managedWords` (100% unbudgeted) / `overBy: 0` — green by construction.
   */
  it("measures this repo's own AGENTS.md with a real ceiling, not 0 by construction", () => {
    const report = scanDocBudget(REPO_ROOT, config())!;
    expect(report.agentsMd).not.toBeNull();
    expect(report.agentsMdCeiling).toBeGreaterThan(0);
    expect(report.agentsMdOverBy).toBe(0);
  });

  it("turns the AGENTS.md line yellow past the warn ratio, never red", () => {
    const small = tempRepo();
    writeFileSync(join(small, "AGENTS.md"), "a".repeat(1000));
    const under = docBudgetLines(scanDocBudget(small, config())!, tc("es").doctor);
    expect(under.some((l) => l.includes("DEJA DE AGREGAR"))).toBe(false);
    expect(under.some((l) => l.includes("AGENTS.md"))).toBe(true);

    const big = tempRepo();
    const bytes = Math.ceil(CODEX_PROJECT_DOC_MAX_BYTES * CODEX_PROJECT_DOC_WARN_RATIO) + 1;
    writeFileSync(join(big, "AGENTS.md"), "a".repeat(bytes));
    const over = docBudgetLines(scanDocBudget(big, config())!, tc("es").doctor);
    expect(over.some((l) => l.includes("DEJA DE AGREGAR"))).toBe(true);
    // Yellow, never red: the verdict of a repo whose AGENTS.md is past the
    // threshold is identical to one whose file is tiny.
    expect(computeHealthVerdict(big, config()).ok).toBe(computeHealthVerdict(small, config()).ok);
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
    expect(scanDocBudget(cwd, config())!.blocks[0]!.lever).toBe("plugins");
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
    const report = scanDocBudget(cwd, config())!;
    expect(report.contextFiles.map((f) => f.path)).toEqual([
      ".claude/context/10-orquestacion.md",
      ".claude/context/40-cierre-sesion.md",
    ]);
    expect(report.contextWords).toBe(1300);
    expect(report.contextChars).toBeGreaterThan(0);
    expect(report.contextDeliveryBudget).toBe(SESSION_CONTEXT_DELIVERY_BUDGET_CHARS);
    // Both files fit comfortably under the delivery budget here — both inline.
    expect(report.contextFiles.map((f) => f.delivered)).toEqual(["inline", "inline"]);
    // Reported, not capped: the context surface never moves the CLAUDE.md verdict.
    expect(report.overBy).toBe(0);
  });

  /**
   * #919 — the accumulated-delivery decision `add_bounded` makes silently at
   * runtime, reported per file. The second file degrades PURELY because of
   * what the first one already spent, not because of its own size — that
   * attribution is the whole point of `ctxCharsBefore`.
   */
  it("marks a file past the accumulated delivery budget as a pointer, attributed to what came before it", () => {
    const cwd = tempRepo();
    // 1500 words (7889 chars) fits alone; the second file's own 50 words
    // (189 chars) would ALSO fit alone, but not once the first one's 7890
    // running total (body + separator) is already queued ahead of it.
    writeContext(cwd, "10-orquestacion.md", words(1500));
    writeContext(cwd, "40-cierre-sesion.md", words(50));
    const report = scanDocBudget(cwd, config())!;
    const [first, second] = report.contextFiles;
    expect(first!.delivered).toBe("inline");
    expect(second!.delivered).toBe("pointer");
    // The degraded file's OWN body (189 chars) is nowhere near the 8000
    // budget — what pushed it past is entirely what `first` already queued.
    expect(second!.ctxCharsBefore).toBeGreaterThan(
      SESSION_CONTEXT_DELIVERY_BUDGET_CHARS - second!.chars,
    );
    const lines = docBudgetLines(report, tc("es").doctor);
    expect(lines.some((l) => l.includes("40-cierre-sesion.md") && l.includes("PUNTERO"))).toBe(
      true,
    );
    // Advisory only: a repo whose context surface is fully degraded still
    // reports the same health verdict as one whose surface fits.
    expect(computeHealthVerdict(cwd, config()).ok).toBe(true);
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
    const report = scanDocBudget(cwd, config())!;
    expect(report.perSubagentWords).toBe(report.totalWords);
    expect(report.perSubagentWords!).toBeLessThan(report.totalWords! + report.contextWords);
  });

  /**
   * #930 — `cursor` and `copilot` share `renderProseFile` with `codex`/
   * `agents-md` and have the same reporting gap, but neither publishes a
   * `project_doc_max_bytes` equivalent: weight only (words + bytes), no ratio,
   * no ceiling. A repo whose ONLY startup surface is one of these still gets a
   * report, same fix #917 made for an `AGENTS.md`-only repo.
   */
  it("reports .cursor/rules/navori.mdc and .github/copilot-instructions.md by weight, no cap", () => {
    const cwd = tempRepo();
    mkdirSync(join(cwd, ".cursor", "rules"), { recursive: true });
    writeFileSync(join(cwd, ".cursor", "rules", "navori.mdc"), `${words(50)}\n`);
    mkdirSync(join(cwd, ".github"), { recursive: true });
    writeFileSync(join(cwd, ".github", "copilot-instructions.md"), `${words(30)}\n`);

    const report = scanDocBudget(cwd, config())!;
    expect(report).not.toBeNull();
    expect(report.cursorRules?.words).toBe(50);
    expect(report.copilotInstructions?.words).toBe(30);

    const lines = docBudgetLines(report, tc("es").doctor);
    expect(lines.some((l) => l.includes(".cursor/rules/navori.mdc"))).toBe(true);
    expect(lines.some((l) => l.includes(".github/copilot-instructions.md"))).toBe(true);
    // Weight only: no cap/ratio vocabulary leaks into either line.
    expect(lines.some((l) => l.includes("cap de") && l.includes("cursor"))).toBe(false);
  });

  it("returns null for cursor/copilot only when NEITHER surface exists", () => {
    const cwd = tempRepo();
    mkdirSync(join(cwd, ".cursor", "rules"), { recursive: true });
    writeFileSync(join(cwd, ".cursor", "rules", "navori.mdc"), `${words(10)}\n`);
    const report = scanDocBudget(cwd, config());
    expect(report).not.toBeNull();
    expect(report!.cursorRules).not.toBeNull();
    expect(report!.copilotInstructions).toBeNull();
  });

  /**
   * #948 — the report lists which MCP servers this repo wires, but never
   * prices them: their real startup payload can only be read by starting the
   * server, which `doctor` never does (D09/D10). `.mcp.json` is read as-is,
   * so a user-added server (outside any navori plugin) is listed too.
   */
  describe("MCP servers (#948)", () => {
    it("is empty when the repo has no .mcp.json", () => {
      const cwd = tempRepo();
      writeClaudeMd(cwd, block("tipado-fuerte", words(20)));
      expect(scanDocBudget(cwd, config())!.mcpServers).toEqual([]);
    });

    it("lists every server declared in .mcp.json, alwaysLoad included", () => {
      const cwd = tempRepo();
      writeClaudeMd(cwd, block("tipado-fuerte", words(20)));
      writeFileSync(
        join(cwd, ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            codegraph: { command: "codegraph", args: ["serve", "--mcp"], alwaysLoad: true },
            engram: { command: "engram", args: ["mcp"] },
          },
        }),
      );
      const report = scanDocBudget(cwd, config())!;
      expect(report.mcpServers).toEqual([
        { id: "codegraph", alwaysLoad: true },
        { id: "engram", alwaysLoad: false },
      ]);
    });

    it("does not crash on a malformed .mcp.json — reports an empty list instead", () => {
      const cwd = tempRepo();
      writeClaudeMd(cwd, block("tipado-fuerte", words(20)));
      writeFileSync(join(cwd, ".mcp.json"), "{ not json");
      expect(scanDocBudget(cwd, config())!.mcpServers).toEqual([]);
    });

    it("prints the server list without any word/token figure attached", () => {
      const cwd = tempRepo();
      writeClaudeMd(cwd, block("tipado-fuerte", words(20)));
      writeFileSync(
        join(cwd, ".mcp.json"),
        JSON.stringify({ mcpServers: { engram: { command: "engram", args: ["mcp"] } } }),
      );
      const lines = docBudgetLines(scanDocBudget(cwd, config())!, tc("es").doctor);
      const mcpLine = lines.find((l) => l.includes("engram"));
      expect(mcpLine).toBeDefined();
      expect(mcpLine).not.toMatch(/\d+\s*(tokens?|palabras|words)/);
    });

    /**
     * The #948 audit's core finding: `alwaysLoad` is never named as the
     * source of the instructions cost — a server without it (`engram`) is
     * evidence that field does not gate that payload.
     */
    it("names alwaysLoad only for what it does, never as the cost's cause", () => {
      const cwd = tempRepo();
      writeClaudeMd(cwd, block("tipado-fuerte", words(20)));
      writeFileSync(
        join(cwd, ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            codegraph: { command: "codegraph", args: [], alwaysLoad: true },
            engram: { command: "engram", args: [] },
          },
        }),
      );
      const lines = docBudgetLines(scanDocBudget(cwd, config())!, tc("es").doctor);
      const alwaysLoadLine = lines.find((l) => l.includes("alwaysLoad"));
      expect(alwaysLoadLine).toBeDefined();
      expect(alwaysLoadLine).toContain("codegraph");
      expect(alwaysLoadLine).not.toContain("engram");
      // What it says it does: tool schemas, not instructions.
      expect(alwaysLoadLine).toMatch(/esquema/i);
    });

    it("stays silent about alwaysLoad when no server declares it", () => {
      const cwd = tempRepo();
      writeClaudeMd(cwd, block("tipado-fuerte", words(20)));
      writeFileSync(
        join(cwd, ".mcp.json"),
        JSON.stringify({ mcpServers: { engram: { command: "engram", args: [] } } }),
      );
      const lines = docBudgetLines(scanDocBudget(cwd, config())!, tc("es").doctor);
      expect(lines.some((l) => l.includes("alwaysLoad"))).toBe(false);
    });

    it("never flips the health verdict, same doctrine as every other line", () => {
      const cwd = tempRepo();
      writeClaudeMd(cwd, block("tipado-fuerte", words(20)));
      writeFileSync(
        join(cwd, ".mcp.json"),
        JSON.stringify({
          mcpServers: { codegraph: { command: "codegraph", args: [], alwaysLoad: true } },
        }),
      );
      expect(computeHealthVerdict(cwd, config()).ok).toBe(true);
    });
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

    expect(scanDocBudget(small.cwd, config())!.overBy).toBe(0);
    expect(scanDocBudget(huge.cwd, config())!.overBy).toBeGreaterThan(4000);

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
