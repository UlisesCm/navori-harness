import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
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

/** Lets only the `full` label start work on a `labeled` event (#1551). */
const LABEL_FILTER = "github.event.action != 'labeled' || github.event.label.name == 'full'";

const stepRuns = (body: string): string[] =>
  [...body.matchAll(/^ {8}run: (.+)$/gm)].map((m) => (m[1] as string).trim());

describe("ci workflow", () => {
  // Covers: R23 R24
  it("writes actual boolean GitHub outputs and rejects malformed plans", () => {
    const script = /node -e '([^']+)'/.exec(job("plan"))?.[1];
    if (script === undefined) throw new Error("Missing plan output command");
    const root = mkdtempSync(join(tmpdir(), "navori-ci-plan-"));
    const input = join(root, "plan.json");
    const output = join(root, "github-output");
    try {
      for (const full of [true, false]) {
        writeFileSync(input, JSON.stringify({ full }));
        expect(
          spawnSync(process.execPath, ["-e", script, input], {
            env: { ...process.env, GITHUB_OUTPUT: output },
          }).status,
        ).toBe(0);
      }
      expect(readFileSync(output, "utf8")).toBe("full=true\nfull=false\n");
      writeFileSync(input, '{"full":"true"}');
      expect(
        spawnSync(process.execPath, ["-e", script, input], {
          env: { ...process.env, GITHUB_OUTPUT: output },
          stdio: "pipe",
        }).status,
      ).toBe(1);
      expect(readFileSync(output, "utf8")).toBe("full=true\nfull=false\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  // Covers: R18 R23
  it("quality corre hacia dev y main y compila una vez", () => {
    const checks = job("checks");
    // No branch filter: the only condition is the label filter (#1551).
    expect([...checks.matchAll(/^ {4}if: (.+)$/gm)].map((m) => m[1])).toEqual([LABEL_FILTER]);
    const runs = stepRuns(checks);
    expect(runs.filter((r) => /ensure-dist|\bbuild\b/.test(r) && !r.includes("website"))).toEqual([
      "bun run ensure-dist",
    ]);
    expect(runs.indexOf("bun run ensure-dist")).toBeLessThan(runs.indexOf("bun run check:render"));
    expect(checks).not.toContain("test:coverage");
    expect(checks).toContain("check:tests-preserved");
    expect(checks).toContain("check:assets:ci");
    expect(checks).toContain("@navori/website build");
    expect(job("semgrep")).toContain("base_ref == 'main'");
  });

  // Covers: R23 R24 R25
  it("push corre shards y merge, PR corre afectados salvo hub o main", () => {
    const tests = job("test");
    expect(tests).toContain("github.event_name == 'push'");
    expect(tests).toContain("github.base_ref == 'main'");
    expect(tests).toContain("needs.plan.outputs.full == 'true'");
    // A `full` label forces the full suite on a PR to dev (#1492).
    expect(tests).toContain("contains(github.event.pull_request.labels.*.name, 'full')");
    expect(tests).toContain("!cancelled()");
    expect(tests).toContain("fail-fast: false");
    expect(tests).toContain("shard: [1, 2, 3, 4]");
    expect(tests).toContain("--shard ${{ matrix.shard }}/4");
    expect(tests).toContain("if-no-files-found: error");
    const merge = job("test-merge");
    expect(merge).toContain("always() && needs.test.result != 'skipped'");
    expect(merge).toContain('test "$SHARD_RESULT" = success');
    expect(merge).toContain("--merge .vitest-reports --shards 4");
    expect(merge).toContain("vitest-merged.json");
    expect(merge).toContain('NAVORI_TEST_BUDGET_FACTOR: "2"');
    const affected = job("affected");
    expect(affected).toContain("base_ref == 'dev'");
    expect(affected).toContain("needs.plan.outputs.full == 'false'");
    expect(affected).toContain("NAVORI_AFFECTED_BASE: origin/${{ github.base_ref }}");
    expect(affected).toContain("check-test-budget.mjs --report");
    expect(job("plan")).toContain("--plan-json");
    expect(job("plan")).toContain("fetch-depth: 0");
  });

  it("a full label added after opening starts the suite and other labels start nothing (#1551)", () => {
    // Listing `types` replaces the defaults, so all three must stay next to `labeled`.
    expect(workflow).toContain("types: [opened, synchronize, reopened, labeled]");
    for (const name of ["checks", "plan", "test", "semgrep"]) {
      expect(job(name)).toContain(LABEL_FILTER);
    }
    // A run for another label skips every job; its own group keeps it from cancelling the real run.
    expect(workflow).toContain(
      "github.event.action == 'labeled' && github.event.label.name != 'full' && format('-{0}', github.run_id)",
    );
    expect(workflow).toContain("cancel-in-progress: true");
  });
});
