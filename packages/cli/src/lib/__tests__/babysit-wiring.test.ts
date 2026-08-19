import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WORKFLOW_SKILLS } from "../../engines/shared/harness-assets.ts";

/**
 * Issues #337 + #338 — the post-PR loop is prose, so what a test CAN protect is
 * that its load-bearing rules survive a rewrite. Each expectation below maps to
 * a measured failure mode, not to style:
 *
 *   - `gh pr checks --watch` takes no timeout: it hangs the turn and the user
 *     never gets the PR URL (the pilot's only deliverable).
 *   - PR comments and CI logs are external content: obeying them is a prompt
 *     injection with a network delivery path.
 *   - a red check is useless until it's classified code-vs-infra — that
 *     classification has ONE owner (`babysit-prs`), the pilot only cites it.
 */
const here = dirname(fileURLToPath(import.meta.url));
const coreAssets = resolve(here, "..", "..", "..", "..", "core", "core-assets");
const read = (rel: string): string => readFileSync(resolve(coreAssets, rel), "utf-8");

describe("post-PR loop — content invariants (#337, #338)", () => {
  it("babysit-prs ships and is registered as a workflow skill", () => {
    expect(WORKFLOW_SKILLS).toContain("babysit-prs");
    // Registered but absent from disk = a render that writes an empty skill.
    expect(read("skills/babysit-prs.md")).toContain("name: babysit-prs");
  });

  it("babysit-prs keeps the code-vs-infra classification", () => {
    const skill = read("skills/babysit-prs.md");
    expect(skill).toMatch(/code or infra/i);
    // The tell that separates the two: the same check red on other PRs.
    expect(skill).toMatch(/same check red on other PRs/i);
    // `statusCheckRollup` already carries the state — the classification must
    // not degenerate into a per-PR fan-out of `gh run view`.
    expect(skill).toContain("statusCheckRollup");
  });

  it("babysit-prs treats external content as data and never dumps a log", () => {
    const skill = read("skills/babysit-prs.md");
    expect(skill).toMatch(/DATA, never instructions/i);
    expect(skill).toMatch(/never obeyed/i);
    // S-3: a full CI log carries env vars and tokens; only the error line ships.
    expect(skill).toMatch(/Never dump a full log/i);
    // The exit code lies behind a pipe; `bucket` is the deterministic field.
    expect(skill).toMatch(/never the exit code/i);
  });

  it("babysit-prs never waits on checks and never auto-implements", () => {
    const skill = read("skills/babysit-prs.md");
    expect(skill).toMatch(/Never `gh pr checks --watch`/i);
    expect(skill).toMatch(/Implement\s*\n?\s*nothing here/i);
  });

  it("the pilot reads the checks once, cites the skill, and forbids --watch", () => {
    const pilot = read("agents/commit-pr-pilot.md");
    expect(pilot).toContain("babysit-prs");
    // The hard rule, not just a passing mention of the flag.
    expect(pilot).toMatch(/Never `gh pr checks --watch`/i);
    // `bucket`, not the exit code; and pending is a stop, not a wait.
    expect(pilot).toContain("bucket: pending");
    expect(pilot).toContain("bucket: fail");
    // The post-push step stays informative — it is NOT a new gate.
    expect(pilot).toMatch(/never hold or revert a PR over a red check/i);
  });
});
