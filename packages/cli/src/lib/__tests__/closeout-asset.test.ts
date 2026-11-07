import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { getCoreRoot } from "../render/bundled-assets.ts";
import { conditioned } from "./helpers/conditioned-asset.ts";

/**
 * Content guard (#398, #601, #1455): the session close lives in
 * `verify-before-done` (§ Session close), no longer in a SessionStart block.
 * It must not mandate an unconditional re-run of the full quality gate — the
 * authoritative green run of a cycle is the reviewer's Pass-2 or the pilot's
 * pre-flight, and between the PR and the close only `progress/*.md` change —
 * and it must park the repo on the base branch, SAFELY.
 */

const core = resolve(getCoreRoot(), "core-assets");
const SKILL_PATH = resolve(core, "skills", "verify-before-done.md");

describe("the closeout block left the SessionStart channel (#1455)", () => {
  it("no managed cierre-sesion asset ships", () => {
    expect(existsSync(resolve(core, "managed", "cierre-sesion.md"))).toBe(false);
  });

  it("the skill is the session owner's, not a subagent's", () => {
    const raw = readFileSync(SKILL_PATH, "utf-8");
    expect(raw).toMatch(/## Session close \(session owner only\)/);
    expect(raw).toMatch(/A subagent's `done -> <file>` closes no session/);
  });

  it("an always-on block points at it", () => {
    const orquestacion = readFileSync(resolve(core, "managed", "orquestacion.md"), "utf-8");
    expect(orquestacion).toContain("verify-before-done");
    expect(orquestacion).toContain("Session close");
  });
});

describe("Session close — quality-gate step reuses cycle evidence (#398)", () => {
  const raw = readFileSync(SKILL_PATH, "utf-8");
  const step1 = raw.split("\n").find((line) => line.startsWith("1. **Gate**"));
  const row = raw.split("\n").find((line) => line.includes("--include-consumed"));

  // Covers: R6, R8
  it("gates evidence reuse on a fresh receipt check, else reruns the gate", () => {
    expect(step1, "Session close step 1 (**Gate**) not found").toBeDefined();
    expect(step1).toMatch(/cite a fresh receipt, else rerun the full gate/);
    expect(row, "the receipt-check row is missing").toBeDefined();
    expect(row).toContain("navori receipt check");
    expect(row).toContain('"fresh":true');
  });

  it("does not mandate an unconditional run (old wording)", () => {
    expect(step1).not.toMatch(/confirm it passes \(or document debt/);
  });
});

/**
 * Content guard (#601): park on the base branch, synced — and SAFELY. Both
 * halves are load-bearing, so both are pinned.
 */
describe("Session close — park on base (#601)", () => {
  const raw = conditioned(readFileSync(SKILL_PATH, "utf-8"));
  const block = raw.split("\n").find((line) => line.startsWith("5. **Park on base**")) ?? "";

  it("has the parking step, interpolating the config's base branch", () => {
    expect(block, "Session close step 5 (**Park on base**) not found").not.toBe("");
    expect(block).toContain("{{branchBase}}");
  });

  it("pulls fast-forward only — the base never receives a surprise merge", () => {
    expect(block).toContain("--ff-only");
  });

  it("never deletes the feature branch, and says so explicitly", () => {
    expect(block).toMatch(/Never delete the feature branch/);
  });

  it("refuses to switch on a dirty tree or over a possibly-live parallel session", () => {
    expect(block).toMatch(/clean working tree/);
    expect(block).toMatch(/another session that may be alive/);
  });

  it("keeps the timing rule and its no-PR exception that the orchestrator relies on", () => {
    expect(raw).toMatch(/inside the work PR before it opens, never a `progress\/`-only PR/);
    expect(raw).toMatch(/no work PR → `progress\/` alone/);
  });
});
