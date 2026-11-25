import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  join(import.meta.dirname, "../../../../.github/workflows/ci.yml"),
  "utf8",
);

/** Text of one top-level job: from `  <name>:` to the next two-space key. No YAML dependency exists. */
function job(name: string): string {
  const lines = workflow.split("\n");
  const start = lines.findIndex((l) => l === `  ${name}:`);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^ {2}[\w-]+:/.test(l));
  return rest.slice(0, end === -1 ? undefined : end).join("\n");
}

/** Lets only the `full` label start the tests on a `labeled` event (#1551). */
const LABEL_FILTER = "github.event.action != 'labeled' || github.event.label.name == 'full'";

const stepRuns = (body: string): string[] =>
  [...body.matchAll(/^ {8}run: (.+)$/gm)].map((m) => (m[1] as string).trim());

describe("ci workflow", () => {
  // Covers: R18 R23
  it("quality corre hacia dev y main y compila una vez", () => {
    const checks = job("checks");
    // No branch or label filter: a skipped `checks` would pass a required check (#1562).
    expect(checks).not.toMatch(/^ {4}if:/m);
    const runs = stepRuns(checks);
    expect(runs.filter((r) => /ensure-dist|\bbuild\b/.test(r) && !r.includes("website"))).toEqual([
      "bun run ensure-dist",
    ]);
    expect(runs.indexOf("bun run ensure-dist")).toBeLessThan(runs.indexOf("bun run check:render"));
    expect(checks).not.toContain("test:coverage");
    expect(checks).toContain("check:tests-preserved");
    // A PR to dev compares against the event's base SHA, not the live tip of origin/dev (#1566).
    expect(checks).toContain(
      "PR_BASE_SHA: ${{ github.base_ref == 'dev' && github.event.pull_request.base.sha || '' }}",
    );
    expect(checks).toContain('bun run check:tests-preserved ${PR_BASE_SHA:+--base "$PR_BASE_SHA"}');
    expect(checks).toContain("check:assets:ci");
    expect(checks).toContain("@navori/website build");
    expect(job("semgrep")).toContain("base_ref == 'main'");
  });

  // Covers: R23 R24 R25
  it("checks corre el gate Rust y deja la suite TS a asset-suites (C1, C2, C3)", () => {
    const checks = job("checks");
    const runs = stepRuns(checks);
    expect(checks).toContain("- run: rustup show active-toolchain");
    expect(checks).toContain("hashFiles('rust-toolchain.toml', 'Cargo.lock')");
    expect(runs).toContain("bun run check:post-cutover");
    expect(runs.indexOf("bun run ensure-dist")).toBeLessThan(
      runs.indexOf("bun run check:post-cutover"),
    );
    // C3: neither the TS lint/typecheck nor the bundle size of the frozen TS gate `dev` any more.
    expect(checks).not.toMatch(/\b(?:lint|typecheck|check:size)\b/);
    // C2: the Node floor job stays.
    expect(job("node-floor")).toContain("smoke-node-floor.mjs");
    const assets = job("asset-suites");
    expect(assets).toContain(LABEL_FILTER);
    expect(stepRuns(assets)).toContain("bun run test:assets");
    for (const removed of ["plan", "test", "test-merge", "affected"]) {
      expect(workflow).not.toMatch(new RegExp(`^ {2}${removed}:$`, "m"));
    }
  });

  // Covers: R22
  it("todo PR a main corre check-pin con el historial completo (D53)", () => {
    const pin = job("legacy-pin");
    expect(pin).toContain("github.base_ref == 'main'");
    expect(pin).toContain(LABEL_FILTER);
    expect(pin).toContain("fetch-depth: 0");
    expect(pin).toContain("node scripts/js/dist-assemble.mjs check-pin");
    // ci.yml has no `paths:` filter, so a dev → main PR that touches no release file still runs it.
    expect(workflow).not.toMatch(/^\s+paths:/m);
  });

  it("a full label added after opening starts the suite and other labels only repeat checks (#1551, #1562)", () => {
    // Listing `types` replaces the defaults, so all three must stay next to `labeled`.
    expect(workflow).toContain("types: [opened, synchronize, reopened, labeled]");
    for (const name of ["asset-suites", "semgrep"]) {
      expect(job(name)).toContain(LABEL_FILTER);
    }
    // A run for another label repeats only `checks`; its own group keeps it from cancelling the real run.
    expect(workflow).toContain(
      "github.event.action == 'labeled' && github.event.label.name != 'full' && format('-{0}', github.run_id)",
    );
    expect(workflow).toContain("cancel-in-progress: true");
  });
});
