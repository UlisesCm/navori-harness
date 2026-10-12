import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * #1264 — every `reviewer` / `publisher` dispatch pays the whole rendered
 * prompt before doing any work, so its size is a per-dispatch cost, not just a
 * source-readability one. `maxWords` (agents-assets.test.ts) caps the SOURCE
 * body; nothing measured the RENDERED file, where interpolations
 * (`{{qualityGate.full}}` alone renders ~290 B per copy) and plugin blocks add
 * bytes the word cap cannot see.
 *
 * Deliberately an explicit list of two files, not a discovery over
 * `.claude/agents/`: the other roles are out of scope for #1264, and a walk
 * would turn every new agent into an unbudgeted failure.
 *
 * The rendered mirrors are trustworthy here because `check:render` (part of
 * `qualityGate.full`) fails when they drift from the source. The flip side: the
 * sizes depend on this repo's `navori.config.json` (gate command, enabled
 * plugins). A config change that legitimately grows a prompt raises the
 * ceiling in the same PR — that is the intended trigger, not a flake.
 *
 * Ceilings = measured size after #1264 plus ~5% headroom. Sizes before the
 * change: reviewer 22194 B, publisher 28367 B (both fail the ceilings below).
 */
const HERE = resolve(fileURLToPath(import.meta.url), "..");
// packages/cli/src/lib/__tests__ → repo root is five levels up.
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..", "..");

/** Max rendered bytes per agent, as `.claude/agents/<id>.md`. */
const RENDERED_BYTE_CEILINGS: Readonly<Record<string, number>> = {
  reviewer: 21_100,
  publisher: 25_500,
};

describe("rendered reviewer/publisher prompts stay within their byte ceilings (#1264)", () => {
  it.each(Object.entries(RENDERED_BYTE_CEILINGS))(
    "%s renders within %i bytes",
    (id: string, ceiling: number): void => {
      const path = join(REPO_ROOT, ".claude", "agents", `${id}.md`);
      expect(existsSync(path), `rendered agent missing: ${path}`).toBe(true);
      const bytes = Buffer.byteLength(readFileSync(path, "utf-8"));
      expect(
        bytes,
        `.claude/agents/${id}.md is ${bytes} B, over its ${ceiling} B ceiling. ` +
          "Every dispatch pays these bytes: trim the prose, or raise the ceiling in " +
          "agent-prompt-bytes.test.ts in the same PR and state what the bytes buy.",
      ).toBeLessThanOrEqual(ceiling);
    },
  );

  // Anti-vacuity: a ceiling far above the real size would green forever.
  it.each(Object.entries(RENDERED_BYTE_CEILINGS))(
    "%s ceiling is not so loose that it stops guarding (under 15% headroom)",
    (id: string, ceiling: number): void => {
      const bytes = Buffer.byteLength(
        readFileSync(join(REPO_ROOT, ".claude", "agents", `${id}.md`), "utf-8"),
      );
      expect(ceiling, `${id}: ceiling ${ceiling} B vs rendered ${bytes} B`).toBeLessThan(
        bytes * 1.15,
      );
    },
  );
});
