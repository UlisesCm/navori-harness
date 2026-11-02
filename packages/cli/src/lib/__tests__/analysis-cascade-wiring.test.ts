import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * #379 (half B) + #377 — the analysis cascade is a LOOKUP, and its fan-out
 * criterion is objective.
 *
 * Until now, "how much analytical ceremony does this task deserve?" was answered
 * by reconstructing a boundary spread over four blocks of prose. It is now one
 * signal→mechanism table in the always-on orchestration block; the five
 * mechanisms (`resolve-ticket`, `ticket-audit`, `solution-design` + the
 * architectural pass gate, SDD/`spec-bootstrap`, `auditor`) are untouched — only
 * the explanation of WHEN each fires was replaced.
 *
 * Prose that changes address silently stops being read, so this file pins both
 * halves of every move:
 *   - the fact is asserted at its NEW home, and
 *   - a fact deleted from the always-on layer is asserted at the canonical copy
 *     that kept it (leader, implementer, reviewer, the ticket block).
 *
 * The #377 half is the same shape: the criterion for splitting the intake's
 * phase 2 (2+ repos · frontend/backend · independent modules) lives in the table
 * ONCE — the decision to parallelize is taken while reading the task, not after
 * deciding to delegate — and the skill and agent that execute it point at it
 * instead of restating it.
 */

const here = dirname(fileURLToPath(import.meta.url));
const coreAssets = resolve(here, "..", "..", "..", "..", "core", "core-assets");

const read = (rel: string): string => readFileSync(resolve(coreAssets, rel), "utf-8");

/** Body of the signal→mechanism lookup, from its header row to the closing depth line. */
function cascadeSection(): string {
  const block = read("managed/orquestacion.md");
  const start = block.indexOf("| Signal | Mechanism |");
  expect(start, "the orchestration block lost its signal→mechanism lookup").toBeGreaterThan(-1);
  return block.slice(start);
}

/** Data rows of the lookup (header and separator dropped). */
function cascadeRows(): string[] {
  return cascadeSection()
    .split("\n")
    .filter(
      (l) =>
        l.startsWith("|") &&
        !l.startsWith("|---") &&
        !l.includes("| Mechanism |") &&
        !l.includes("| Signal |"),
    );
}

/** The single row that matches `needle`, or a failure naming what was searched. */
function row(needle: string): string {
  const matches = cascadeRows().filter((l) => l.includes(needle));
  expect(matches.length, `expected exactly one lookup row containing "${needle}"`).toBe(1);
  return matches[0]!;
}

describe("analysis cascade — one lookup instead of four blocks (#379 B)", () => {
  it("the routing sentence it replaced survives where the work happens", () => {
    // Deleted from the always-on block: "hand the implementer the path to the
    // audit". Both agents in that handoff still carry it.
    expect(read("agents/orchestrator.md")).toMatch(
      /hand the implementer the path to \*{0,2}`?\.navori\/state\/handoffs\/audit_ticket_<ID>\.md/i,
    );
    expect(read("agents/implementer.md")).toContain("audit_ticket_<ID>.md");
    // Deleted from the intake skill: rules whose canonical owner is another asset.
    expect(read("agents/reviewer.md")).toMatch(/Never skip Pass 1/i);
    const ticketBlock = read("managed/intake-tickets.md");
    expect(ticketBlock).toContain("a suggestion, never the spec");
    expect(ticketBlock).toContain("Size is measured, not assumed");
  });
});

describe("phase-2 fan-out — objective criterion, stated once (#377)", () => {
  const SIGNALS = ["2+ repos", "frontend/backend", "no dependency between them"] as const;

  it("the criterion is in the lookup, where the parallelize decision is taken", () => {
    const fanOut = row("PER AREA");
    for (const signal of SIGNALS) {
      expect(fanOut, `the fan-out row lost the "${signal}" signal`).toContain(signal);
    }
    // Mechanics that make the fan-out actually parallel, and its synthesis owner.
    expect(fanOut).toContain("SAME turn");
    expect(fanOut).toMatch(/you synthesize/i);
  });

  it("the criterion is NOT re-litigated as a judgment call in the executing assets", () => {
    // Three copies of a criterion drift; the skill and the agent point at the row.
    for (const asset of ["skills/resolve-ticket.md", "agents/auditor.md"]) {
      const text = read(asset);
      const restated = SIGNALS.filter((s) => text.includes(s));
      expect(
        restated,
        `${asset} restates the fan-out criterion (${restated.join(", ")}) — point at the orchestration table instead`,
      ).toEqual([]);
      expect(text, `${asset} does not point at the table that owns the criterion`).toMatch(
        /orchestration table/i,
      );
    }
  });

  it("the skill carries the mechanics the table can't: one file per area, one synthesis", () => {
    const skill = read("skills/resolve-ticket.md");
    expect(skill).toContain("## Phase 2 fan-out");
    // Parallel auditors that share one filename overwrite each other.
    expect(skill).toContain("audit_ticket_<ID-area>.md");
    expect(skill).toContain("SAME turn");
    // The synthesis lands in the canonical artifact every later phase reads.
    expect(skill).toMatch(/You synthesize[^|]*audit_ticket_<ID>\.md/);
    expect(skill).toMatch(/never delegated/i);
    // Over-fanning is the opposite failure the decision named explicitly.
    expect(skill).toMatch(/more than the serial run/i);
  });

  it("the audit agent knows its scope is ONE area and that it does not synthesize", () => {
    const agent = read("agents/auditor.md");
    expect(agent).toContain("audit_ticket_<ID-area>.md");
    expect(agent).toMatch(/verdict FOR YOUR AREA/i);
    expect(agent).toMatch(/synthesis is the orchestrator's/i);
  });
});
