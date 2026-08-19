import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Content invariants of the content-receipt subsystem (#341, #342).
 *
 * The receipt is a protocol split across four assets — the `reviewer` writes it,
 * the `commit-pr-pilot` and the pre-commit hook verify it, and `orquestacion.md`
 * tells the orchestrator what it may do while one is armed. Only the hook is
 * executable and testable end to end; the other three are prose, so what a test
 * can protect is that the load-bearing tokens survive a rewrite:
 *
 * - the signature stores the blob (`-w`), or a drift can be detected but never
 *   inspected — and the delta re-sign has no diff to measure (#342);
 * - the pilot hands over the command that shows the drift instead of a bare
 *   filename, or the blob is written and nobody ever uses it (#342);
 * - the delta re-sign exists as a named mode with an anti-rubber-stamp limit,
 *   and the orchestration rule points at it instead of promising a saved round
 *   that the byte-gate makes impossible (#341).
 *
 * Assertions target tokens, not whole sentences: rewording is free, removing a
 * piece of the protocol is not.
 */
const here = dirname(fileURLToPath(import.meta.url));
const coreAssets = resolve(here, "..", "..", "..", "..", "core", "core-assets");

const read = (rel: string): string => readFileSync(resolve(coreAssets, rel), "utf-8");

describe("content receipt — inspectable, not just detectable (#342)", () => {
  it("the reviewer signs with `git hash-object -w` so the blob is recoverable", () => {
    const reviewer = read("agents/reviewer.md");
    expect(reviewer).toContain('git hash-object -w "$f"');
    // And says WHY, or the flag reads as noise and the next rewrite drops it.
    expect(reviewer).toMatch(/object store/i);
  });

  it("the pilot reports a drift with the command that shows it", () => {
    const pilot = read("agents/commit-pr-pilot.md");
    expect(pilot).toContain("git diff <blob-sha> <file>");
    expect(pilot).toContain("git cat-file -p <blob-sha>");
  });

  it("`git hash-object` is pre-approved — it's a verb of the receipt cycle", () => {
    const settings = JSON.parse(read("settings/settings-base.json")) as {
      permissions: { allow: string[] };
    };
    expect(settings.permissions.allow).toContain("Bash(git hash-object:*)");
  });
});

describe("delta re-sign — the only path that keeps the byte-gate intact (#341)", () => {
  it("the reviewer defines the mode and bounds it against rubber-stamping", () => {
    const reviewer = read("agents/reviewer.md");
    expect(reviewer).toContain("Delta re-sign (post-APPROVED)");
    // The mode is worthless if it doesn't re-sign: the pilot would stay blocked
    // on the same drift.
    expect(reviewer).toMatch(/rewrite the receipt/i);
    // The limit is what separates a bounded re-review from a rubber stamp.
    expect(reviewer).toMatch(/anti-rubber-stamp/i);
    expect(reviewer).toContain("{{project.criticalAreas}}");
  });

  it("the pilot routes a drift to the delta re-sign, not to a blanket re-review", () => {
    const pilot = read("agents/commit-pr-pilot.md");
    expect(pilot).toContain("delta re-sign");
    // Both branches, or the bifurcation collapses back into one message.
    expect(pilot).toMatch(/full re-review/i);
  });

  it("the orchestration rule stops promising a round the byte-gate can't skip", () => {
    const block = read("managed/orquestacion.md");
    const bullet = block.split("\n").find((l) => l.includes("One-pass review")) ?? "";
    expect(bullet, "the One-pass review bullet disappeared").not.toBe("");
    // It must name the mechanism that binds it (the receipt) and the way out.
    expect(bullet).toContain("receipt.txt");
    expect(bullet).toContain("delta re-sign");
    // Always-on text is paid on every turn of every session of every repo: the
    // rule has to stay a bullet, not become a paragraph.
    expect(bullet.split(/\s+/).length).toBeLessThanOrEqual(75);
  });
});
