import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Single-copy invariants of the protocol prose.
 *
 * A coherence audit plus a measured run on a real ticket found the same fact
 * written in several assets, with the copies drifted: a ticket touching auth
 * fired both "start from a spec" and "R3 is opt-in", the PR pre-flight demanded
 * a clean tree the pilot's own trigger contradicts, and the R1→PR boundary had
 * three wordings. Every drift cost a re-read or a re-decision at runtime.
 *
 * The rule these tests pin: when two documents state the same fact, ONE is
 * canonical and the other points at it. Assertions target the load-bearing
 * tokens and the ABSENCE of the retired wording — rephrasing stays free,
 * re-duplicating does not.
 */
const here = dirname(fileURLToPath(import.meta.url));
const coreAssets = resolve(here, "..", "..", "..", "..", "core", "core-assets");

const read = (rel: string): string => readFileSync(resolve(coreAssets, rel), "utf-8");

/** The line of `file` that contains `needle` (for row/bullet-scoped assertions). */
function lineWith(file: string, needle: string): string {
  const line = read(file)
    .split("\n")
    .find((l) => l.includes(needle));
  expect(line, `no line of ${file} contains "${needle}"`).toBeDefined();
  return line!;
}

/** The body of a `## <heading>` section of `file`, up to the next `##` heading. */
function section(file: string, heading: string): string {
  const body = read(file).split(`\n## ${heading}\n`)[1];
  expect(body, `${file} has no "## ${heading}" section`).toBeDefined();
  return body!.split("\n## ")[0]!;
}

describe("SDD threshold — one formulation, and it's a proposal (F2)", () => {
  it("sdd.md owns the threshold and hands the decision to the user", () => {
    const sdd = read("managed/sdd.md");
    expect(sdd).toMatch(/recommendation you put to the user/i);
    // The gate is R3's opt-in: an agent must not self-assign a spec.
    expect(sdd).toMatch(/opt-in/i);
    expect(sdd).toMatch(/explicit request or accepted proposal/i);
    // The imperative that contradicted R3 must not come back.
    expect(sdd).not.toMatch(/^Start from a spec/im);
  });

  it("the R3 route and spec-bootstrap reference that threshold, never restate it", () => {
    // "> ~2 days" is the fingerprint of the threshold list: exactly one asset.
    const owners = ["managed/sdd.md", "managed/orquestacion.md", "skills/spec-bootstrap.md"].filter(
      (f) => read(f).includes("~2 days"),
    );
    expect(owners).toEqual(["managed/sdd.md"]);

    expect(read("managed/orquestacion.md")).toContain("don't duplicate its criteria");
    expect(read("skills/spec-bootstrap.md")).toMatch(/threshold and its opt-in gate live in ONE/i);
  });
});

describe("verifying a subagent's evidence — bounded subset, after the handoff (F3)", () => {
  it("the rule names WHAT to re-check and WHEN", () => {
    const block = read("managed/orquestacion.md");
    // Scope: only the claims the next decision rests on.
    expect(block).toMatch(/load-bearing claims/i);
    // Timing: after the handoff — re-checking in flight is the duplication the
    // platform already forbids, and it serialized a whole run.
    expect(block).toMatch(/after\*{0,2} its `done -> file`/i);
    // And an explicit ceiling, or "verify" reads as "re-run everything".
    expect(block).toMatch(/don't re-run its investigation/i);
    // The unbounded wording is what produced the conflict.
    expect(block).not.toContain("Verify the diff/evidence yourself");
  });
});

describe("PR pre-flight — one list, no clean-tree requirement (A3, M5)", () => {
  const row = (): string => lineWith("skills/verify-before-done.md", "PR creatable");

  it("verify-before-done stops demanding a clean status", () => {
    // The pilot's trigger IS the uncommitted diff: a clean-tree gate would abort
    // the normal case. Guard the whole skill, not just the row.
    expect(read("skills/verify-before-done.md")).not.toMatch(/clean status/i);
    expect(row()).toMatch(/no clean working tree required/i);
  });

  it("verify-before-done's row is the harness's pre-flight, gate evidence included", () => {
    expect(row()).toContain("{{branchBase}}");
    expect(row()).toContain("gh auth status");
    // Fresh evidence over the shipping diff, by route: reviewer's Pass 2 (bound
    // by the receipt) in R2+, your own run in R1.
    expect(row()).toMatch(/receipt/i);
    expect(row()).toMatch(/R1: your own run/i);
  });

  it("the pilot's own trigger list demands no clean tree either", () => {
    // The pilot reads this list FIRST; a surviving clean-tree clause here aborts
    // the normal case (a dirty tree IS the trigger) no matter what the skill says.
    const trigger = section("agents/commit-pr-pilot.md", "When to trigger");
    expect(trigger).not.toMatch(/clean (working tree|status|tree)/i);
    // What replaces it: evidence over the diff that ships, not a git-state check.
    expect(trigger).toMatch(/fresh `\{\{qualityGate\.full\}\}` evidence over the shipping diff/i);
  });

  it("the leader's pre-flight matches orquestacion's and adds no gate re-run", () => {
    const step = lineWith("agents/leader.md", "Pre-flight on you before invoking");
    expect(step).toContain("{{branchBase}}");
    expect(step).toContain("gh auth status");
    // In R2+ the reviewer already ran the gate over these bytes; asking the
    // orchestrator for a fresh `fast` green duplicates it.
    expect(step).not.toContain("{{qualityGate.fast}}");
    expect(step).toMatch(/no gate re-run on you/i);
  });
});

describe("R1 → PR boundary — defined once, by the agent that applies it (M6)", () => {
  it("the pilot marks its R1 exception as the single definition", () => {
    const pilot = read("agents/commit-pr-pilot.md");
    expect(pilot).toMatch(/SINGLE definition of the R1→PR boundary/);
    // The criterion itself stays here — and since #502.3 there is exactly ONE
    // of them (the non-trivial-file count), defined in that same paragraph
    // instead of borrowed. `commit-pr-pilot-contract.test.ts` owns the shape of
    // the definition; what this line pins is that it lives in the pilot.
    expect(pilot).toContain("**non-trivial**");
    expect(pilot).toMatch(/the waiver applies/);
  });

  it("orquestacion points at that exception from both places, with one wording", () => {
    const block = read("managed/orquestacion.md");
    expect(lineWith("managed/orquestacion.md", "**PR rule:**")).toContain("R1 exception");
    expect(lineWith("managed/orquestacion.md", "R1 · Inline")).toContain("R1 exception");
    // "trivial R1" was the third, narrower wording: a genuine-but-not-trivial R1
    // fell in the gap between the two documents.
    expect(block).not.toMatch(/trivial R1/i);
    expect(block).toContain("don't re-decide it here");
  });
});

describe(".claude/progress/ is created, never assumed (F9)", () => {
  it("the receipt recipe creates the directory before redirecting into it", () => {
    const reviewer = read("agents/reviewer.md");
    const mkdirAt = reviewer.indexOf("mkdir -p .claude/progress");
    const redirectAt = reviewer.indexOf("> .claude/progress/receipt.txt");
    expect(mkdirAt, "the receipt recipe lost its mkdir").toBeGreaterThan(-1);
    expect(mkdirAt).toBeLessThan(redirectAt);
  });

  it("the audit pre-flights tolerate an absent directory", () => {
    for (const agent of ["agents/ticket-audit.md", "agents/auditor.md"]) {
      expect(read(agent), `${agent} pre-flight assumes the dir exists`).toContain(
        "mkdir -p .claude/progress",
      );
    }
    expect(read("agents/ticket-audit.md")).toMatch(/never a pre-flight failure/i);
  });

  it("`mkdir -p` is pre-approved — it's a verb of every handoff", () => {
    const settings = JSON.parse(read("settings/settings-base.json")) as {
      permissions: { allow: string[] };
    };
    expect(settings.permissions.allow).toContain("Bash(mkdir -p:*)");
  });
});
