import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * #378 — ceremony proportional to risk, with the exemption bound to the DIFF.
 *
 * The closeout and memory protocols are flat-rate: a typo pays the same ritual
 * as a migration. The R1 lean close lane cuts that, but the issue's original
 * condition ("no durable finding") was rejected on purpose — the agent judges
 * that at the very moment of closing, and an agent that exempts itself because
 * "nothing durable came up" is exactly how the context the ceremony exists to
 * keep gets lost. The approved conditions are checkable without judgment: R1
 * route · one user task · a diff outside the critical areas.
 *
 * The lane spans two assets (core closeout + the engram plugin block), so the
 * wiring is what's at risk: the conditions live in ONE place and the memory
 * protocol exempts its own steps under that same name. Naming note: the decision
 * calls it "R1 exprés"; the assets say "lean close" because `core-lean.test.ts`
 * denylists "express" as a stack token inside core. This file also pins what
 * is NEVER exempt — the gate, `mem_save`, and the history entry whenever
 * something was committed — because an exemption that quietly grows is
 * indistinguishable from having no protocol at all.
 */

const here = dirname(fileURLToPath(import.meta.url));
const packages = resolve(here, "..", "..", "..", "..");
const coreAssets = resolve(packages, "core", "core-assets");
const engram = resolve(packages, "plugins", "engram");

const readCore = (rel: string): string => readFileSync(resolve(coreAssets, rel), "utf-8");
const readEngram = (rel: string): string => readFileSync(resolve(engram, rel), "utf-8");

/** The R1 lean close paragraph of the closeout block, which owns the conditions. */
function expressLane(): string {
  const block = readCore("managed/cierre-sesion.md");
  const line = block.split("\n").find((l) => l.includes("**R1 lean close**"));
  expect(line, "the closeout block lost the R1 lean close lane").toBeDefined();
  return line!;
}

describe("R1 lean close — the exemption is bound to the diff (#378)", () => {
  it("the closeout block owns the three checkable conditions", () => {
    const lane = expressLane();
    expect(lane).toMatch(/not a judgment call/i);
    // 1. route, 2. a single user task, 3. a diff outside the critical areas.
    expect(lane).toMatch(/\*\*R1\*\* route/);
    expect(lane).toMatch(/\*\*one\*\* user task/);
    expect(lane).toContain("{{project.criticalAreas}}");
  });

  it("what it exempts is bounded, and the gate is not part of it", () => {
    const lane = expressLane();
    // Step 2 is the history entry — dropped only for a session that shipped nothing.
    expect(lane).toMatch(/skip step 2 when nothing was committed/i);
    expect(lane).toMatch(/never exempts the quality gate/i);
    // A change that shipped leaves a trace, however trivial.
    expect(lane).toMatch(/`history\.md` entry whenever there WAS a commit/);
  });

  it("the rejected self-judged condition is nowhere in the protocol", () => {
    // "no durable finding" is judged by the closing agent — the exact failure
    // mode the decision replaced with checkable conditions.
    for (const [label, text] of [
      ["managed/cierre-sesion.md", readCore("managed/cierre-sesion.md")],
      ["engram/managed/engram-protocol.md", readEngram("managed/engram-protocol.md")],
    ] as const) {
      expect(text, `${label} reintroduced a self-judged exemption`).not.toMatch(
        /durable (finding|hallazgo)/i,
      );
    }
  });

  it("the memory protocol exempts its own steps under the same name, and keeps mem_save", () => {
    const block = readEngram("managed/engram-protocol.md");
    expect(block).toContain("**R1 lean close**");
    // The two steps the decision exempts.
    expect(block).toMatch(/summary and the curation step are exempt/i);
    // The one it does not — plus both doctor invariants of the plugin, which the
    // rendered block must keep carrying.
    expect(block).toMatch(/`mem_save` is not/i);
    const { invariants } = JSON.parse(readEngram("plugin.json")) as { invariants: string[] };
    for (const token of invariants) {
      expect(block, `the engram block lost the doctor invariant ${token}`).toContain(token);
    }
  });

  it("the leader-injected copy of the protocol doesn't contradict the lane", () => {
    // This skill is injected into `.claude/agents/leader.md`: a surviving
    // unconditional "mandatory" there overrides the lane at the moment of closing.
    const skill = readEngram("skills/engram-leader.md");
    expect(skill).toMatch(/mem_session_summary` — exempt only under \*\*R1 lean close\*\*/);
    expect(skill).toMatch(/curation is exempt too; `mem_save` never is/i);
  });
});
