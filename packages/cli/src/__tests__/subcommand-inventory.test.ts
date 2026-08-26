import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * #507 — `CLAUDE.md` claimed "los 19 subcomandos registrados en index.ts" and
 * listed 19 of the 20, omitting `audit`. The always-on layer, the one every
 * agent reads before anything else, was lying about the product's inventory: an
 * agent asked "does navori have an audit command?" answered no, from the file
 * it is told to trust most.
 *
 * The number was typed, so it decayed the moment a subcommand landed. Deriving
 * it is the fix: `index.ts` is the registry, and the prose has to match it or
 * this fails. Same move as `agents-assets.test.ts` reading the agent roster
 * from the directory instead of a hand-kept list (#417).
 *
 * Parsed rather than imported on purpose — importing `index.ts` calls
 * `runMain`, which would execute the CLI inside the suite. Same reason
 * `scripts/check-asset-commands.mjs` parses the block.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const INDEX_TS = resolve(REPO_ROOT, "packages", "cli", "src", "index.ts");
const CLAUDE_MD = resolve(REPO_ROOT, "CLAUDE.md");

/** The names registered in the CLI's `subCommands: { ... }` block. */
function registeredSubCommands(): string[] {
  const source = readFileSync(INDEX_TS, "utf-8");
  const [, block] = source.match(/subCommands:\s*\{([\s\S]*?)\n\s*\},/) ?? [];
  // A check that cannot run must be loud, never a silent pass.
  if (block === undefined) throw new Error(`could not parse subCommands from ${INDEX_TS}`);
  return [...block.matchAll(/^\s*([a-z][\w-]*)\s*:/gm)].map(([, name]) => name ?? "");
}

/** The inventory sentence in CLAUDE.md: its claimed count and its listed names. */
function claimedInventory(): { count: number; names: string[] } {
  const text = readFileSync(CLAUDE_MD, "utf-8");
  const [, count, list] =
    text.match(/Los (\d+) subcomandos registrados en `packages\/cli\/src\/index\.ts`:([^.]+)\./) ??
    [];
  if (count === undefined || list === undefined) {
    throw new Error(
      "could not find the subcommand inventory sentence in CLAUDE.md " +
        '(anchor: "Los <n> subcomandos registrados en `packages/cli/src/index.ts`: …"). ' +
        "If the wording changed, update this anchor — do not delete the inventory.",
    );
  }
  return {
    count: Number(count),
    names: [...list.matchAll(/`([a-z][\w-]*)`/g)].map(([, name]) => name ?? ""),
  };
}

describe("CLAUDE.md's subcommand inventory is derived from index.ts (#507)", () => {
  const registered = registeredSubCommands();
  const claimed = claimedInventory();

  it("parses a real registry on both sides (anti-false-green)", () => {
    // Either regex going quiet would compare two empty lists and read as green.
    expect(registered).toEqual(expect.arrayContaining(["init", "render", "doctor", "audit"]));
    expect(claimed.names.length).toBeGreaterThan(10);
  });

  it("lists exactly the registered subcommands", () => {
    expect(
      [...claimed.names].sort(),
      "CLAUDE.md's inventory drifted from `subCommands` in index.ts. It is the always-on " +
        "layer: an agent answers questions about the product from it, so a missing entry " +
        "becomes a confident 'navori has no such command'.",
    ).toEqual([...registered].sort());
  });

  it("states the count the list actually has", () => {
    expect(claimed.count, "the sentence's number contradicts its own list").toBe(
      claimed.names.length,
    );
  });
});
