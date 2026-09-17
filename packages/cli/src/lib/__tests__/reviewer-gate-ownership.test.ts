import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { reviewerGateLifecycle } from "../audit/signals.ts";
import type { HookEvent } from "../audit/model.ts";
import { agent, session } from "../audit/__tests__/lifecycle-fixtures.ts";

// Covers: R53, R54

/**
 * R53's single-owner / stable-handle contract, read back from the prose that
 * carries it (`reviewer.md`, `implementer.md`), plus the R54 audit detector
 * that reports violations of it — never claiming to have prevented them.
 *
 * #854 (`7da709df`) already shipped the BEHAVIORAL half ("never background
 * it"); this file pins the CONTRACT wording (single owner, stable handle
 * correlated to the diff, no `pgrep`/`ps`, timeout != success, `BLOCKED`
 * fallback) that R53 states explicitly and that a bare "never background it"
 * does not spell out on its own.
 */
const here = dirname(fileURLToPath(import.meta.url));
const coreAssets = resolve(here, "..", "..", "..", "..", "core", "core-assets");
const read = (rel: string): string => readFileSync(resolve(coreAssets, rel), "utf-8");

describe("reviewer.md / implementer.md — single-owner, stable-handle gate contract (R53)", () => {
  for (const file of ["agents/reviewer.md", "agents/implementer.md"]) {
    it(`${file} states single ownership of its gate run`, () => {
      const body = read(file);
      expect(body).toMatch(/single owner of this gate run/);
    });

    it(`${file} forbids pgrep/ps polling for the gate`, () => {
      const body = read(file);
      expect(body).toMatch(/never poll `pgrep`\/`ps`/);
    });

    it(`${file} states a timeout is never success`, () => {
      const body = read(file);
      expect(body).toMatch(/timeout is never a success signal/);
    });

    it(`${file} names the exact stall shapes as forbidden (no shell &, no run_in_background, no Monitor)`, () => {
      const body = read(file);
      expect(body).toMatch(/no shell `&`, no `run_in_background`, no `Monitor`/);
    });

    it(`${file} falls back to BLOCKED when no chained step fits under any foreground timeout`, () => {
      const body = read(file);
      expect(body).toMatch(/report `BLOCKED` instead of improvising a background wait/);
    });
  }

  it("reviewer.md correlates the handle to the diff being reviewed", () => {
    const body = read("agents/reviewer.md");
    expect(body).toMatch(/correlated to the diff you're reviewing this turn/);
  });
});

describe("reviewerGateLifecycle — detects and reports, never claims to prevent (R54)", () => {
  it("flags two overlapping reviewer runs without asserting any tool call was blocked", () => {
    const r1 = agent({ agentId: "r1", overlapsWith: ["r2"] });
    const r2 = agent({ agentId: "r2", overlapsWith: ["r1"] });
    const s = session({ agents: [r1, r2] });
    const signals = reviewerGateLifecycle([s], "en");
    const overlap = signals.find((sig) => sig.kind === "reviewer-gate-overlap");
    expect(overlap).toBeDefined();
    // "possible violation" — an observation, not an enforcement claim.
    expect(overlap?.summary.toLowerCase()).toContain("possible single-owner violation");
    expect(overlap?.summary.toLowerCase()).not.toMatch(/prevented|blocked the/);
  });

  it("reports a duplicate terminal verdict with an explicit non-prevention disclaimer", () => {
    const started: HookEvent = {
      ts: "2026-09-14T10:00:00Z",
      name: "quality-gate-pre-commit",
      phase: "PreToolUse",
      verdict: "gate-started",
      ms: 4,
      source: "core",
      toolUseId: "toolu_1",
    };
    const terminal = (verdict: "allow" | "block"): HookEvent => ({
      ...started,
      ts: "2026-09-14T10:02:00Z",
      verdict,
      ms: 120_000,
    });
    const reviewer = agent({ hookEvents: [started, terminal("allow"), terminal("block")] });
    const s = session({ agents: [reviewer] });
    const dup = reviewerGateLifecycle([s], "en").find(
      (sig) => sig.kind === "reviewer-gate-duplicate",
    );
    expect(dup?.severity).toBe("high");
    expect(dup?.evidence).toMatch(/no detector.*blocks or prevents/i);
  });
});
