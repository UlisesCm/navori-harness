import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { NavoriConfigSchema, type NavoriConfig } from "../../../lib/schema.ts";

/**
 * #443 — the class closer: a vocabulary rule that matches nothing is a BUG, not
 * a harmless no-op.
 *
 * Two of the four rules this guards replaced (`"Claude por defecto"`, `"En
 * Claude Code"`) were written against Spanish prose. The core assets went
 * English in #154 and both silently stopped matching anything, while the English
 * sentences they existed to cover shipped to every Codex repo untouched. Nothing
 * failed, because a `replaceAll` that matches nothing is indistinguishable from
 * a correct one — from the OUTPUT side. Checking the output cannot close this:
 * the dead `"Claude por defecto" → "Codex"` rule emits `"Codex"`, a string every
 * render is full of for unrelated reasons, so it looks alive.
 *
 * So this asserts from the INPUT side, on a real render. The adapter is wrapped
 * to record every string it is fed (delegating to the real implementation, so
 * the render output is unchanged) and each rule must match at least one of them.
 * Reading the source assets instead would not do: `agents/leader.md` carries two
 * Claude-specific sentences and is never rendered under Codex (the main thread
 * embodies the leader), so a rule aimed at it would look alive on disk and be
 * dead in every repo.
 */
const fed = vi.hoisted(() => ({ inputs: [] as string[] }));

vi.mock("../compat.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../compat.ts")>();
  return {
    ...actual,
    adaptHarnessTextForCodex: (content: string, config: NavoriConfig): string => {
      fed.inputs.push(content);
      return actual.adaptHarnessTextForCodex(content, config);
    },
  };
});

const { CODEX_VOCABULARY } = await import("../compat.ts");
const { renderCodexEngine } = await import("../index.ts");

function config(language: "es" | "en"): NavoriConfig {
  return NavoriConfigSchema.parse({
    name: "codex-vocab",
    engines: ["codex"],
    preset: "custom",
    language,
    branchBase: "main",
    qualityGate: { fast: "pnpm test", full: "pnpm test" },
    plugins: { engram: { enabled: true } },
  });
}

describe("CODEX_VOCABULARY (#443)", () => {
  it("has no dead rule: every input pattern occurs in prose a real render feeds the adapter", () => {
    // Both languages: a rule may only reach the blocks one of them serves.
    for (const language of ["es", "en"] as const) {
      renderCodexEngine(mkdtempSync(join(tmpdir(), "navori-vocab-")), config(language));
    }
    expect(fed.inputs.length).toBeGreaterThan(20);

    for (const [from] of CODEX_VOCABULARY) {
      expect({ rule: from, matched: fed.inputs.some((text) => text.includes(from)) }).toEqual({
        rule: from,
        matched: true,
      });
    }
  });
});
