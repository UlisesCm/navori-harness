import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CORE_SKILLS, WORKFLOW_SKILLS } from "../../engines/shared/harness-assets.ts";

/**
 * Spec 0012 — the solutioning layer is prose, so what a test CAN protect is its
 * wiring: that the doctrine survives an edit and, above all, that every skill is
 * reachable from some flow.
 *
 * The failure mode this guards against is one this repo already had: a skill
 * that ships, gets indexed, and is never named by any agent, block or flow —
 * three of them (`security-guidance`, `debug-error`, `dominio`) sat with ZERO
 * inbound references until this spec wired them. An unreferenced skill relies
 * purely on the model remembering it exists, which is the weakest activation
 * there is.
 */
const here = dirname(fileURLToPath(import.meta.url));
const coreAssets = resolve(here, "..", "..", "..", "..", "core", "core-assets");

const read = (rel: string): string => readFileSync(resolve(coreAssets, rel), "utf-8");

/** Every core asset that can reference another (agents, skills, managed blocks). */
function allAssetFiles(): string[] {
  const out: string[] = [];
  for (const dir of ["agents", "skills", "managed"]) {
    const abs = resolve(coreAssets, dir);
    if (!existsSync(abs)) continue;
    for (const f of readdirSync(abs)) {
      if (f.endsWith(".md")) out.push(resolve(abs, f));
    }
  }
  return out;
}

describe("solutioning — content invariants (spec 0012)", () => {
  it("solution-design ships and keeps its verdict semantics", () => {
    const skill = read("skills/solution-design.md");
    // The three-verdict vocabulary and the rule that only one of them stops work.
    for (const token of ["READY", "CONCERNS", "BLOCKED"]) {
      expect(skill).toContain(token);
    }
    // CONCERNS never blocks — the BMAD #2079 failure mode (a gate that flags
    // non-blocking findings as blocking and loops forever).
    expect(skill.toLowerCase()).toContain("never blocks");
    // BLOCKED carries the burden of proof, or it degrades to a concern.
    expect(skill.toLowerCase()).toContain("blocking fact");
    expect(skill).toMatch(/CONCERN, not a blocker/i);
  });

  it("solution-design forces the two checks the baseline skipped", () => {
    const skill = read("skills/solution-design.md");
    // RED F1: the agent installed what the ticket named without ever weighing
    // the pattern already in the repo.
    expect(skill).toContain("What already exists");
    expect(skill).toMatch(/existing pattern > small extension > new abstraction/i);
    // RED F3: findings that change what should be built must land in the verdict,
    // not in a footnote.
    expect(skill).toContain("NOT in scope");
  });

  it("the orchestration block routes into the skill and stays within budget", () => {
    const block = read("managed/orquestacion.md");
    expect(block).toContain("R2-architectural");
    expect(block).toContain("solution-design");
    // File count must stay a hint, never the definition of complexity.
    expect(block).toMatch(/File count is a hint, never the definition/i);
    // Always-on text is paid on every session of every repo: keep the routing
    // paragraph lean and let the skill carry the depth (spec 0012 R21).
    const paragraph = block.split("\n").find((l) => l.includes("R2-architectural")) ?? "";
    expect(paragraph.split(/\s+/).length).toBeLessThanOrEqual(150);
  });

  it("the ticket pipeline hands off to the solution phase and back", () => {
    const intake = read("skills/ticket-intake.md");
    expect(intake).toContain("solution-design");
    // The implementer must be pointed at the artifact, or the design is paid for
    // and then dropped on the floor.
    expect(intake).toContain("solution_<scope>.md");
  });

  it("the agents that consume a design know it exists", () => {
    // Implementer: implements the decided approach, doesn't redesign it.
    expect(read("agents/implementer.md")).toContain("solution_<scope>.md");
    // Reviewer: judges the diff against the agreed approach without re-opening
    // the design debate (design review and code review stay separate).
    const reviewer = read("agents/reviewer.md");
    expect(reviewer).toContain("solution_<scope>.md");
    expect(reviewer).toMatch(/do NOT re-open the design/i);
    // Researcher: knows the falsification brief and that the verdict isn't its call.
    const researcher = read("agents/researcher.md");
    expect(researcher).toContain("solution_review_<scope>.md");
    expect(researcher).toMatch(/do not issue a verdict/i);
  });

  it("no core skill is orphaned — every one is named by some flow", () => {
    const corpus = allAssetFiles().map((f) => ({ file: f, text: readFileSync(f, "utf-8") }));
    const orphans: string[] = [];
    for (const id of [...CORE_SKILLS, ...WORKFLOW_SKILLS]) {
      const referencedBy = corpus.filter(
        (c) => !c.file.endsWith(`skills/${id}.md`) && c.text.includes(id),
      );
      if (referencedBy.length === 0) orphans.push(id);
    }
    expect(
      orphans,
      `these skills ship but no agent/skill/managed block ever tells anyone to use them: ${orphans.join(", ")}. ` +
        "Wire each into the flow where it applies (or drop it) — indexing alone is the weakest form of activation.",
    ).toEqual([]);
  });
});
