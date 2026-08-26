import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * #370 — the intake's phase-2 gate could not tell "I stop because the ticket is
 * blocked" from "I stop because nobody answered".
 *
 * The pipeline ended at *"Gate: the user approves the VERDICT"*, so a ticket
 * that produced NO work still waited for a human to approve doing nothing: on a
 * real run the right outcome arrived by lucky accident, not by design. The
 * decision splits the two: a verdict that opens no work closes the cycle
 * unattended, and the human gate is kept INTACT for `proceed` and
 * `proceed-differently` — the two that open the chequebook, and the checkpoint
 * that sits right before code gets written.
 *
 * What this file pins is the pair, not just the new half: the async close AND
 * the surviving gate. An asset that exempts `proceed` too would pass a test
 * that only looked for "closes without waiting".
 */

const here = dirname(fileURLToPath(import.meta.url));
const coreAssets = resolve(here, "..", "..", "..", "..", "core", "core-assets");

const read = (rel: string): string => readFileSync(resolve(coreAssets, rel), "utf-8");

/** The phase-2 row of the intake pipeline table. */
function phase2Row(): string {
  const line = read("skills/ticket-intake.md")
    .split("\n")
    .find((l) => l.startsWith("| 2 · AUDIT"));
  expect(line, "the intake pipeline lost its phase-2 row").toBeDefined();
  return line!;
}

describe("closing verdicts don't wait for approval (#370)", () => {
  it("the always-on ticket block says a non-proceed verdict closes the cycle", () => {
    const block = read("managed/intake-tickets.md");
    // The enumeration of non-proceed outcomes already lived here; what's new is
    // that none of them stalls waiting for a human.
    expect(block).toMatch(/none of them opens work, so none of them waits for approval/i);
    // …and the gate that survives, named explicitly so it can't be read as "no
    // ticket ever waits".
    expect(block).toContain("`proceed` and `proceed-differently`");
  });

  it("the intake's phase-2 gate is scoped to the two verdicts that open work", () => {
    const row = phase2Row();
    expect(row).toMatch(/only `proceed` and `proceed-differently` wait for the user/i);
    expect(row).toMatch(/opens no work/i);
    // The unconditional wording is exactly what produced the un-completable
    // pipeline; it must not come back.
    expect(read("skills/ticket-intake.md")).not.toMatch(/Gate: the user approves the VERDICT/i);
  });

  it("closing the cycle is defined as an ACTION, not just an absence of waiting", () => {
    const skill = read("skills/ticket-intake.md");
    // Report the verdict + evidence, park the session state, stop.
    // Repo-relative path, not the bare filename: #507 found the skill's phase-0
    // `cat current.md` failing from the repo root, where the file is
    // `progress/current.md`. The anchor moves with the fix so it stays honest.
    expect(skill).toMatch(/doesn't wait for approval:.*`progress\/current\.md` at `idle`/s);
    // Both legitimate ends of the pipeline are declared, so "no PR" isn't read
    // as an unfinished run.
    expect(skill).toMatch(/closed at phase 2 ends with its verdict \+ evidence and no PR/i);
  });

  it("the audit agent still produces the verdicts the rule dispatches on", () => {
    const agent = read("agents/ticket-audit.md");
    // Vocabulary: the rule is inert if the audit stops emitting these.
    for (const verdict of ["proceed", "proceed-differently", "split", "doesn't apply", "blocked"]) {
      expect(agent, `the audit's verdict vocabulary lost "${verdict}"`).toContain(verdict);
    }
    // And the doctrine that makes an unattended close a success, not a failure.
    expect(agent).toMatch(/Every verdict is legitimate/i);
  });
});
