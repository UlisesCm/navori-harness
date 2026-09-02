import { describe, it, expect } from "vitest";
import { foreignHarnessLines } from "../doctor.ts";
import { tc } from "../../lib/i18n.ts";
import type { ForeignConflict, ForeignHarnessReport } from "../../lib/foreign-harness.ts";

/**
 * Spec 0014 (#555) — what the reader is actually told.
 *
 * The scan finding a collision is half the job; the other half is the sentence,
 * and it is the half that can be wrong while every other test stays green.
 * Precedence is NOT uniform — for agents the repo wins, for skills the personal
 * copy does — so a row that names the winner by one rule is right half the time
 * and confidently wrong the rest, which is worse than silence: the reader acts
 * on the name.
 */

const td = tc("es").doctor;

function conflict(over: Partial<ForeignConflict> = {}): ForeignConflict {
  return {
    id: "agent:personal:reviewer",
    type: "agent",
    scope: "personal",
    name: "reviewer",
    foreignPath: "/home/tu/.claude/agents/reviewer.md",
    navoriPath: ".claude/agents/reviewer.md",
    winner: "navori",
    adoptable: false,
    ...over,
  };
}

function report(over: Partial<ForeignHarnessReport> = {}): ForeignHarnessReport {
  return { conflicts: [], permissions: [], staleAcknowledged: [], ...over };
}

/** The rows, stripped of colour, as one searchable block. */
function text(input: ForeignHarnessReport): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are the point
  return foreignHarnessLines(input, td)
    .join("\n")
    .replace(/\[[0-9;]*m/g, "");
}

describe("the row names the winner, and precedence is not uniform (R4)", () => {
  it("puts the repo's agent first and the personal one as inert", () => {
    const out = text(report({ conflicts: [conflict()] }));
    expect(out).toContain(".claude/agents/reviewer.md");
    // The order in the sentence IS the claim: winner, then what stays inert.
    expect(out.indexOf(".claude/agents/reviewer.md")).toBeLessThan(
      out.indexOf("/home/tu/.claude/agents/reviewer.md"),
    );
  });

  it("puts the personal skill first — the direction that surprises", () => {
    const out = text(
      report({
        conflicts: [
          conflict({
            id: "skill:personal:verify-before-done",
            type: "skill",
            name: "verify-before-done",
            foreignPath: "/home/tu/.claude/skills/verify-before-done.md",
            navoriPath: ".claude/skills/verify-before-done/SKILL.md",
            winner: "foreign",
          }),
        ],
      }),
    );
    expect(out.indexOf("/home/tu/.claude/skills/verify-before-done.md")).toBeLessThan(
      out.indexOf(".claude/skills/verify-before-done/SKILL.md"),
    );
  });

  it("says 'undecided' out loud instead of naming a winner it cannot know", () => {
    const out = text(
      report({
        conflicts: [
          conflict({
            id: "skill:repo:review-diff",
            type: "skill",
            scope: "repo",
            name: "review-diff",
            foreignPath: ".claude/skills/review-diff.md",
            navoriPath: ".claude/skills/review-diff/SKILL.md",
            winner: "undecided",
            adoptable: true,
          }),
        ],
      }),
    );
    expect(out).toContain("no está documentada");
    expect(out).not.toContain("gana '");
  });
});

describe("every row carries the action that closes it (R7)", () => {
  it("offers to adopt only what lives in the repo", () => {
    const inRepo = text(
      report({
        conflicts: [
          conflict({
            id: "skill:repo:review-diff",
            scope: "repo",
            foreignPath: ".claude/skills/review-diff.md",
            adoptable: true,
          }),
        ],
      }),
    );
    expect(inRepo).toContain("navori adopt .claude/skills/review-diff.md");
  });

  it("offers to acknowledge what navori cannot write to", () => {
    const outside = text(report({ conflicts: [conflict()] }));
    // No adopt path is offered for `~/.claude`: navori only reads out there,
    // and an action that does not exist is worse than no action.
    expect(outside).not.toContain("navori adopt");
    expect(outside).toContain("acknowledged");
    expect(outside).toContain("agent:personal:reviewer");
  });

  it("adds the out-of-version-control note when it applies", () => {
    const out = text(
      report({
        conflicts: [conflict({ scope: "repo", adoptable: true, gitignored: true })],
      }),
    );
    expect(out).toContain("fuera de control de versiones");
  });
});

describe("permissions and stale acknowledgements (R3, R9)", () => {
  it("names the rule and the file that allows it", () => {
    const out = text(
      report({
        permissions: [{ rule: "Bash(rm -rf:*)", path: ".claude/settings.local.json" }],
      }),
    );
    expect(out).toContain("Bash(rm -rf:*)");
    expect(out).toContain(".claude/settings.local.json");
  });

  it("names an acknowledgement that matches nothing any more", () => {
    const out = text(report({ staleAcknowledged: ["skill:personal:gone"] }));
    expect(out).toContain("skill:personal:gone");
  });
});

describe("nothing to say, nothing printed (R16)", () => {
  it("returns no rows for an empty report, so doctor prints no section", () => {
    expect(foreignHarnessLines(report(), td)).toEqual([]);
  });
});

describe("both languages carry the section (R4)", () => {
  it("renders the English row with the same winner order", () => {
    const en = foreignHarnessLines(report({ conflicts: [conflict()] }), tc("en").doctor)
      .join("\n")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are the point
      .replace(/\[[0-9;]*m/g, "");
    expect(en).toContain("stays inert");
    expect(en.indexOf(".claude/agents/reviewer.md")).toBeLessThan(
      en.indexOf("/home/tu/.claude/agents/reviewer.md"),
    );
  });
});
