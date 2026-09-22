import { describe, expect, it } from "vitest";
import { simulateContextDelivery, SESSION_CONTEXT_DELIVERY_BUDGET_CHARS } from "../doc-budgets.ts";

/**
 * #919 — `simulateContextDelivery` mirrors `add_bounded`
 * (`session-start-context.sh:403-410`) in TypeScript, so the SessionStart
 * hook's per-session, silent inline/pointer decision can be reported at
 * gate/`doctor` time instead of only inside the ephemeral hook process.
 *
 * These tests fix the CONTRACT the mirror must not drift from: accumulate in
 * delivery order, count the `add ""` separator before the fit check, and
 * degrade the file that overflows — never the ones ahead of it.
 */
describe("simulateContextDelivery (#919)", () => {
  it("delivers everything inline while the accumulated size fits the budget", () => {
    const files = [
      { path: "a.md", chars: 100 },
      { path: "b.md", chars: 100 },
    ];
    const result = simulateContextDelivery(files, 1000);
    expect(result.map((f) => f.delivered)).toEqual(["inline", "inline"]);
  });

  it("degrades exactly the file that pushes the accumulated size past the budget", () => {
    // `add ""` costs 1 char before EVERY file's fit check.
    //   A: ctxCharsBefore = 1; 1 + 100 = 101 <= 105 -> inline
    //   ctx after A = 101 (fit) + 1 (A's own trailing newline) = 102
    //   B: ctxCharsBefore = 102 + 1 (separator) = 103; 103 + 100 = 203 > 105 -> pointer
    const budget = 105;
    const files = [
      { path: "a.md", chars: 100 },
      { path: "b.md", chars: 100 },
    ];
    const result = simulateContextDelivery(files, budget);
    expect(result[0]!.delivered).toBe("inline");
    expect(result[1]!.delivered).toBe("pointer");
    // The number a PR author needs: how much the FILE(S) AHEAD OF the
    // degraded one consumed, not the degraded file's own size.
    expect(result[1]!.ctxCharsBefore).toBe(103);
  });

  it("delivers the file that fits exactly at the boundary as inline, not pointer", () => {
    // ctxCharsBefore for the sole file is 1 (the separator); budget = 1 + chars
    // exactly is the boundary the hook's `-le` (less-or-equal) treats as fitting.
    const files = [{ path: "a.md", chars: 99 }];
    const result = simulateContextDelivery(files, 100);
    expect(result[0]!.delivered).toBe("inline");
  });

  it("degrades the file that overflows the boundary by a single character", () => {
    const files = [{ path: "a.md", chars: 100 }];
    const result = simulateContextDelivery(files, 100);
    expect(result[0]!.delivered).toBe("pointer");
  });

  it("attributes the degradation to files earlier in order, not the degraded file's own growth", () => {
    // Reproduces this repo's live shape (#919 audit): a big first file already
    // consumes most of the budget, so unrelated, unchanged files behind it
    // degrade even though nobody touched them.
    const files = [
      { path: "10-orquestacion.md", chars: 6500 },
      { path: "20-agentes-disponibles.md", chars: 1400 },
      { path: "30-arranque-sesion.md", chars: 1300 },
      { path: "40-cierre-sesion.md", chars: 3300 },
    ];
    const result = simulateContextDelivery(files, SESSION_CONTEXT_DELIVERY_BUDGET_CHARS);
    expect(result[0]!.delivered).toBe("inline");
    expect(result[1]!.delivered).toBe("inline");
    // The third file degrades PURELY because of what came before it — its own
    // 1300 chars never changes across this whole run.
    expect(result[2]!.delivered).toBe("pointer");
    expect(result[2]!.ctxCharsBefore).toBeGreaterThan(SESSION_CONTEXT_DELIVERY_BUDGET_CHARS - 1300);
    expect(result[3]!.delivered).toBe("pointer");
  });

  it("uses the default budget constant when none is passed", () => {
    const files = [{ path: "a.md", chars: SESSION_CONTEXT_DELIVERY_BUDGET_CHARS + 1 }];
    expect(simulateContextDelivery(files)[0]!.delivered).toBe("pointer");
  });
});
