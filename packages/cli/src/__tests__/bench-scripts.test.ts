import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { summarizeReport } from "../../scripts/bench-tests.mjs";
import { budgetViolations, validateBudget } from "../../scripts/check-test-budget.mjs";

/**
 * Spec 0054 M1 — the measurement scripts. Fixed fixtures only: no test here
 * runs the real suite or the real hooks.
 */

const here = dirname(fileURLToPath(import.meta.url));
const BUDGET_SCRIPT = resolve(here, "..", "..", "scripts", "check-test-budget.mjs");
const ROOT = "/repo/packages/cli";

interface Registration {
  engine: "claude" | "codex";
  event: string;
  matcher: string | null;
  command: string;
}
type Sums = Record<string, Record<string, { totalMs: number; hooks: number }>>;
interface BenchHooks {
  BASH_BUDGET_MS: number;
  evaluateBudget: (sums: Sums) => { ok: boolean; violations: string[] };
  median: (values: number[]) => number;
  parseClaudeRegistrations: (settings: unknown) => Registration[];
  parseCodexRegistrations: (toml: string) => Registration[];
  selectHooks: (
    regs: Registration[],
    scenario: string,
    engine: "claude" | "codex",
  ) => Registration[];
  sumByEvent: (rows: { engine: string; scenario: string; medianMs: number }[]) => Sums;
}
// Loaded by computed URL: a static import would pull the root script under this package's rootDir.
const hooksModule = (await import(
  pathToFileURL(resolve(here, "..", "..", "..", "..", "scripts", "js", "bench-hooks.mjs")).href
)) as BenchHooks;
const {
  BASH_BUDGET_MS,
  evaluateBudget,
  median,
  parseClaudeRegistrations,
  parseCodexRegistrations,
  selectHooks,
  sumByEvent,
} = hooksModule;

describe("bench scripts", () => {
  // Covers: R1
  it("bench:tests resume pared, por archivo y top 25 desde un reporte fijo", () => {
    // Shape pinned against vitest 5.0.1 `--reporter=json`: no total duration, per-file startTime/endTime.
    const report = {
      numTotalTests: 3,
      startTime: 1000,
      success: true,
      testResults: Array.from({ length: 30 }, (_, i) => ({
        name: `${ROOT}/src/__tests__/f${i}.test.ts`,
        startTime: 1000,
        endTime: 1000 + (i + 1) * 10.4,
        status: "passed",
        message: "",
        assertionResults: [{ fullName: "a", status: "passed", duration: 1 }],
      })),
    };
    const summary = summarizeReport(report, 12_345.6, ROOT);
    expect(summary.wallMs).toBe(12_346);
    expect(summary.totalFiles).toBe(30);
    expect(summary.totalTests).toBe(30);
    expect(summary.top).toHaveLength(25);
    expect(summary.top[0]).toEqual({
      file: "src/__tests__/f29.test.ts",
      ms: 312,
      status: "passed",
      tests: 1,
    });
    expect(summary.files.at(-1)?.file).toBe("src/__tests__/f0.test.ts");
    expect(summary.sumFilesMs).toBe(summary.files.reduce((sum, f) => sum + f.ms, 0));
    expect(() => summarizeReport({ nope: true }, 1, ROOT)).toThrow(/testResults/);
  });

  // Covers: R3
  it("check-test-budget falla sobre el presupuesto por el factor y respeta excepciones", () => {
    const budget = {
      defaultMs: 1000,
      exceptions: [{ file: "src/slow.test.ts", ms: 5000, reason: "spawns the CLI" }],
    };
    const files = [
      { file: "src/fast.test.ts", ms: 900 },
      { file: "src/over.test.ts", ms: 1500 },
      { file: "src/slow.test.ts", ms: 4000 },
      { file: "src/slow-over.test.ts", ms: 6000 },
    ];
    const at1 = budgetViolations(budget, files, 1);
    expect(at1).toHaveLength(2);
    expect(at1[0]).toContain("src/over.test.ts: 1500 ms exceeds its budget of 1000 ms");
    expect(at1.join("\n")).not.toContain("src/slow.test.ts");
    expect(budgetViolations(budget, files, 2)).toEqual([
      "src/slow-over.test.ts: 6000 ms exceeds its budget of 2000 ms",
    ]);

    const dir = mkdtempSync(join(tmpdir(), "navori-budget-"));
    try {
      const budgetPath = join(dir, "budget.json");
      writeFileSync(budgetPath, JSON.stringify(budget));
      const root = resolve(here, "..", "..");
      const reportPath = join(dir, "vitest.json");
      writeFileSync(
        reportPath,
        JSON.stringify({
          testResults: [
            { name: join(root, "src/over.test.ts"), startTime: 0, endTime: 1500, status: "passed" },
          ],
        }),
      );
      const run = (factor?: string) =>
        spawnSync("node", [BUDGET_SCRIPT, "--budget", budgetPath, "--report", reportPath], {
          encoding: "utf8",
          env: { ...process.env, NAVORI_TEST_BUDGET_FACTOR: factor ?? "" },
        });
      const failed = run();
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain("src/over.test.ts: 1500 ms exceeds its budget of 1000 ms");
      expect(run("2").status).toBe(0);
      expect(run("0").status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Covers: R2
  it("test-budget rechaza excepción sin razón o ms no entero", () => {
    const ok = {
      defaultMs: 5000,
      exceptions: [{ file: "src/a.test.ts", ms: 9000, reason: "spawns the CLI" }],
    };
    expect(validateBudget(ok).ok).toBe(true);
    expect(validateBudget({ defaultMs: 5000, exceptions: [] }).ok).toBe(true);
    const noReason = validateBudget({
      defaultMs: 5000,
      exceptions: [{ file: "a", ms: 1, reason: "  " }],
    });
    expect(noReason.ok).toBe(false);
    const fractional = validateBudget({
      defaultMs: 5000,
      exceptions: [{ file: "a", ms: 1.5, reason: "x" }],
    });
    expect(fractional.ok).toBe(false);
    expect(validateBudget({ defaultMs: 0, exceptions: [] }).ok).toBe(false);
    expect(
      validateBudget({ defaultMs: 5000, exceptions: [ok.exceptions[0], ok.exceptions[0]] }).ok,
    ).toBe(false);

    const dir = mkdtempSync(join(tmpdir(), "navori-budget-"));
    try {
      const bad = join(dir, "bad.json");
      writeFileSync(
        bad,
        JSON.stringify({ defaultMs: 5000, exceptions: [{ file: "a", ms: 1, reason: "" }] }),
      );
      const run = spawnSync("node", [BUDGET_SCRIPT, "--budget", bad], { encoding: "utf8" });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("reason");
      const good = join(dir, "good.json");
      writeFileSync(good, JSON.stringify({ defaultMs: 5000, exceptions: [] }));
      const report = join(dir, "latest.json");
      writeFileSync(report, JSON.stringify({ files: [] }));
      expect(spawnSync("node", [BUDGET_SCRIPT, "--budget", good, "--report", report]).status).toBe(
        0,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Covers: R27
  it("bench:hooks suma por evento y falla sobre el presupuesto", () => {
    const claude = parseClaudeRegistrations({
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ command: "bash a.sh" }, { command: "bash b.sh" }] },
          { matcher: "Bash|Edit|Write", hooks: [{ command: "bash c.sh" }] },
          { matcher: "Agent", hooks: [{ command: "bash d.sh" }] },
        ],
        PostToolUse: [{ matcher: "Bash", hooks: [{ command: "bash e.sh" }] }],
        UserPromptSubmit: [{ hooks: [{ command: "bash f.sh" }] }],
      },
    });
    const codex = parseCodexRegistrations(
      [
        "[features]",
        "hooks = true",
        "[[hooks.PreToolUse]]",
        'matcher = "^Bash$"',
        "[[hooks.PreToolUse.hooks]]",
        'type = "command"',
        'command = "bash \\"$(git rev-parse --show-toplevel)/.codex/hooks/g.sh\\""',
        "[[hooks.PreToolUse]]",
        'matcher = "spawn_agent$"',
        "[[hooks.PreToolUse.hooks]]",
        'command = "bash h.sh"',
      ].join("\n"),
    );
    expect(codex).toEqual([
      {
        engine: "codex",
        event: "PreToolUse",
        matcher: "^Bash$",
        command: 'bash "$(git rev-parse --show-toplevel)/.codex/hooks/g.sh"',
      },
      { engine: "codex", event: "PreToolUse", matcher: "spawn_agent$", command: "bash h.sh" },
    ]);
    const all = [...claude, ...codex];
    expect(selectHooks(all, "Bash", "claude").map((r) => r.command)).toEqual([
      "bash a.sh",
      "bash b.sh",
      "bash c.sh",
      "bash e.sh",
    ]);
    expect(selectHooks(all, "Edit", "claude")).toHaveLength(1);
    expect(selectHooks(all, "Agent", "codex")).toHaveLength(1);
    expect(selectHooks(all, "UserPromptSubmit", "claude")).toHaveLength(1);

    expect(median([300, 100, 200])).toBe(200);
    expect(median([10, 20])).toBe(15);

    const sums = sumByEvent([
      { engine: "claude", scenario: "Bash", medianMs: 100 },
      { engine: "claude", scenario: "Bash", medianMs: 150 },
      { engine: "claude", scenario: "Edit", medianMs: 40 },
      { engine: "codex", scenario: "Bash", medianMs: 120 },
    ]);
    expect(sums.claude!.Bash).toEqual({ totalMs: 250, hooks: 2 });
    expect(sums.claude!.Edit).toEqual({ totalMs: 40, hooks: 1 });
    expect(evaluateBudget(sums)).toEqual({ ok: true, violations: [] });

    sums.codex!.Bash!.totalMs = BASH_BUDGET_MS + 1;
    const over = evaluateBudget(sums);
    expect(over.ok).toBe(false);
    expect(over.violations).toEqual([expect.stringContaining("codex Bash")]);
  });
});
