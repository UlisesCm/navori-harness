import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { getCoreRoot } from "../bundled-assets.ts";

/**
 * Content guard (#398): the session-closeout asset must not mandate an
 * unconditional re-run of the full quality gate. The authoritative green run
 * of a cycle is the reviewer's Pass-2 (R2) or the pilot's pre-flight (R1);
 * between the PR and the closeout only `progress/*.md` files change, which no
 * gate step evaluates. Step 1 must offer the evidence-reuse alternative —
 * same criterion the pilot applies ("trust it, don't re-run", #362).
 */

const ASSET_PATH = resolve(getCoreRoot(), "core-assets", "managed", "cierre-sesion.md");

function readCloseoutStep1(): string {
  expect(existsSync(ASSET_PATH), `closeout asset missing: ${ASSET_PATH}`).toBe(true);
  const raw = readFileSync(ASSET_PATH, "utf-8");
  const step1 = raw.split("\n").find((line) => line.startsWith("1. **Quality gate**"));
  expect(step1, "closeout step 1 (**Quality gate**) not found").toBeDefined();
  return step1 as string;
}

describe("cierre-sesion.md — quality-gate step reuses cycle evidence (#398)", () => {
  const step1 = readCloseoutStep1();

  it("interpolates {{qualityGate.full}} in step 1", () => {
    expect(step1).toContain("{{qualityGate.full}}");
  });

  it("offers the evidence-reuse clause in the same step as the gate", () => {
    expect(step1).toMatch(/or cite this cycle's green run/);
    // The clause must name both sources of authoritative evidence.
    expect(step1).toMatch(/Pass-2 in R2/);
    expect(step1).toMatch(/pre-flight in R1/);
  });

  it("does not mandate an unconditional run (old wording)", () => {
    // Pre-#398 wording: "confirm it passes (or document debt ..." — a re-run
    // with no alternative. "confirm it passes" may stay only if the reuse
    // clause follows it.
    expect(step1).not.toMatch(/confirm it passes \(or document debt/);
    if (/confirm it passes/.test(step1)) {
      expect(step1).toMatch(/confirm it passes.*or cite this cycle's green run/);
    }
  });
});
