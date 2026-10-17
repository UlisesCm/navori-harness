import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isComparable, readSpawnCounts, summarizeReport } from "../../scripts/bench-tests.mjs";
import { budgetViolations, validateBudget } from "../../scripts/check-test-budget.mjs";

/**
 * Spec 0054 M1 — the measurement scripts. Fixed fixtures only: no test here
 * runs the real suite or the real hooks.
 */

const here = dirname(fileURLToPath(import.meta.url));
const BUDGET_SCRIPT = resolve(here, "..", "..", "scripts", "check-test-budget.mjs");
const ROOT = "/repo/packages/cli";

interface Registration {
  engine: "claude" | "codex" | "pi";
  event: string;
  matcher: string | null;
  command: string;
}
type Sums = Record<string, Record<string, { totalMs: number; hooks: number }>>;
interface Sandbox {
  root: string;
  project: string;
  execLog: string;
  env: (audit: "absent" | "root" | "active", counting?: boolean) => NodeJS.ProcessEnv;
  cleanup: () => void;
}
interface BenchHooks {
  countExecs: (log: string) => Record<string, number>;
  createSandbox: () => Sandbox;
  isComparable: (loadavgBefore: number[], cpus: number) => boolean;
  parsePiRegistrations: (source: string, exists?: (script: string) => boolean) => Registration[];
  BASH_BUDGET_MS: number;
  evaluateBudget: (sums: Sums) => { ok: boolean; violations: string[] };
  median: (values: number[]) => number;
  parseClaudeRegistrations: (settings: unknown) => Registration[];
  parseCodexRegistrations: (toml: string) => Registration[];
  selectHooks: (
    regs: Registration[],
    scenario: string,
    engine: "claude" | "codex" | "pi",
  ) => Registration[];
  sumByEvent: (rows: { engine: string; scenario: string; medianMs: number }[]) => Sums;
}
// Loaded by computed URL: a static import would pull the root script under this package's rootDir.
const scriptUrl = (name: string): string =>
  pathToFileURL(resolve(here, "..", "..", "..", "..", "scripts", "js", name)).href;
const hooksModule = (await import(scriptUrl("bench-hooks.mjs"))) as BenchHooks;
const {
  BASH_BUDGET_MS,
  countExecs,
  createSandbox,
  evaluateBudget,
  isComparable: hooksComparable,
  median,
  parsePiRegistrations,
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
      spawns: 0,
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

  // Covers: R1
  it("el wrapper cuenta spawns por archivo sin romper promisify", () => {
    const dir = mkdtempSync(join(tmpdir(), "navori-wrapper-"));
    try {
      const procDir = join(dir, "procs");
      const setup = resolve(here, "..", "..", "vitest.setup.ts");
      writeFileSync(
        join(dir, "global.mjs"),
        'import { mkdtempSync } from "node:fs";\nimport { tmpdir } from "node:os";\nimport { join } from "node:path";\n' +
          'export default function setup(project) {\n  project.provide("navoriTempRunRoot", mkdtempSync(join(tmpdir(), "navori-wrapper-run-")));\n}\n',
      );
      writeFileSync(
        join(dir, "vitest.config.mjs"),
        `export default { test: { include: ["*.test.mjs"], globals: true, pool: "forks", globalSetup: [${JSON.stringify(join(dir, "global.mjs"))}], setupFiles: [${JSON.stringify(setup)}] } };\n`,
      );
      writeFileSync(join(dir, "child.mjs"), "process.exit(0);\n");
      writeFileSync(join(dir, "idle.test.mjs"), 'test("idle", () => {});\n');
      writeFileSync(
        join(dir, "busy.test.mjs"),
        [
          'import { exec, execFile, execFileSync, execSync, fork, spawn, spawnSync } from "node:child_process";',
          'import { promisify } from "node:util";',
          `test("eight children, seven APIs", async () => {`,
          '  spawnSync("true");',
          '  execFileSync("true");',
          '  execSync("true");',
          '  await new Promise((done) => spawn("true").on("close", done));',
          '  await new Promise((done) => execFile("true", done));',
          '  await new Promise((done) => fork(new URL("./child.mjs", import.meta.url).pathname).on("exit", done));',
          '  const viaExec = await promisify(exec)("echo hi");',
          '  const viaFile = await promisify(execFile)("echo", ["hi"]);',
          '  expect(viaExec.stdout).toBe("hi\\n");',
          '  expect(viaFile.stdout).toBe("hi\\n");',
          "});",
          "",
        ].join("\n"),
      );
      const env: NodeJS.ProcessEnv = { ...process.env, NAVORI_BENCH_PROC_DIR: procDir };
      for (const key of Object.keys(env)) {
        if (key.startsWith("VITEST") || key === "NAVORI_HOOK_CORPUS") delete env[key];
      }
      const run = spawnSync(
        join(here, "..", "..", "node_modules", ".bin", "vitest"),
        ["run", "--config", join(dir, "vitest.config.mjs"), "--root", dir],
        { cwd: dir, env, encoding: "utf8" },
      );
      expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
      const counts = readSpawnCounts(procDir);
      const byName = Object.fromEntries(
        Object.entries(counts).map(([f, n]) => [f.split("/").pop(), n]),
      );
      expect(Object.keys(byName).sort()).toEqual(["busy.test.mjs", "idle.test.mjs"]);
      // The idle file measures what the setup itself spawns; the busy one adds exactly its eight.
      expect((byName["busy.test.mjs"] as number) - (byName["idle.test.mjs"] as number)).toBe(8);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Covers: R2
  it("bench:tests marca no comparable con carga inicial mayor que los workers", () => {
    expect(isComparable([3.9, 40, 40], 4)).toBe(true);
    expect(isComparable([4, 0, 0], 4)).toBe(true);
    expect(isComparable([4.01, 0, 0], 4)).toBe(false);
    // Only the load at the START counts: a busy 5-minute average does not matter.
    expect(isComparable([1, 90, 90], 4)).toBe(true);
    expect(isComparable([], 4)).toBe(false);

    const dir = mkdtempSync(join(tmpdir(), "navori-spawn-counts-"));
    try {
      writeFileSync(join(dir, "a.json"), JSON.stringify({ file: "src/a.test.ts", spawns: 3 }));
      writeFileSync(join(dir, "b.json"), JSON.stringify({ file: "src/a.test.ts", spawns: 5 }));
      writeFileSync(join(dir, "c.json"), JSON.stringify({ file: "src/c.test.ts", spawns: 2 }));
      writeFileSync(join(dir, "junk.json"), JSON.stringify({ nope: true }));
      expect(readSpawnCounts(dir)).toEqual({ "src/a.test.ts": 5, "src/c.test.ts": 2 });
      expect(readSpawnCounts(join(dir, "missing"))).toEqual({});
      const report = {
        success: true,
        testResults: ["src/a.test.ts", "src/c.test.ts", "src/d.test.ts"].map((name) => ({
          name: `${ROOT}/${name}`,
          startTime: 0,
          endTime: 10,
          status: "passed",
          assertionResults: [],
        })),
      };
      const summary = summarizeReport(report, 100, ROOT, readSpawnCounts(dir));
      expect(summary.files.map((f) => [f.file, f.spawns])).toEqual([
        ["src/a.test.ts", 5],
        ["src/c.test.ts", 2],
        ["src/d.test.ts", 0],
      ]);
      expect(summary.sumSpawns).toBe(7);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Covers: R3
  it("bench:hooks reporta execs por programa y escenario de auditoria", () => {
    const pi = parsePiRegistrations(
      [
        '{ script: "guard-destructive", on: "tool_call", tools: ["bash"], scope: "all" },',
        '{ script: "role-guard", on: "tool_call", scope: "all" },',
        '{ script: "post-watch", on: "tool_result", tools: ["edit", "write"], scope: "all" },',
        '{ script: "stop-hook", on: "agent_before_settle", scope: "all" },',
        '{ script: "gone", on: "tool_call", tools: ["bash"], scope: "all" },',
      ].join("\n"),
      (script) => script !== "gone",
    );
    expect(pi).toEqual([
      {
        engine: "pi",
        event: "PreToolUse",
        matcher: "Bash",
        command: 'bash ".pi/navori/hooks/guard-destructive.sh"',
      },
      {
        engine: "pi",
        event: "PreToolUse",
        matcher: null,
        command: 'bash ".pi/navori/hooks/role-guard.sh"',
      },
      {
        engine: "pi",
        event: "PostToolUse",
        matcher: "Edit|Write",
        command: 'bash ".pi/navori/hooks/post-watch.sh"',
      },
    ]);
    expect(selectHooks(pi, "Bash", "pi").map((r) => r.command)).toEqual([
      'bash ".pi/navori/hooks/guard-destructive.sh"',
      'bash ".pi/navori/hooks/role-guard.sh"',
    ]);

    expect(countExecs("jq\njq\ndate\nnot-a-shim\nperl\n")).toMatchObject({
      jq: 2,
      date: 1,
      perl: 1,
      node: 0,
    });
    expect(hooksComparable([4.9, 0, 0], 10)).toBe(true);
    expect(hooksComparable([5.1, 0, 0], 10)).toBe(false);

    const sandbox = createSandbox();
    try {
      const absent = sandbox.env("absent");
      expect(existsSync(absent.NAVORI_AUDITS_ROOT as string)).toBe(false);
      const root = sandbox.env("root");
      expect(existsSync(root.NAVORI_AUDITS_ROOT as string)).toBe(true);
      expect(readdirSync(root.NAVORI_AUDITS_ROOT as string)).toEqual([]);
      const active = sandbox.env("active", true);
      const repoDir = join(active.NAVORI_AUDITS_ROOT as string, "project");
      expect(readdirSync(repoDir).sort()).toEqual([
        "session-bench-session.log",
        "spool-bench-session",
      ]);
      // The counting PATH puts the exec-logging shims first; the plain one does not.
      expect((active.PATH as string).startsWith(join(sandbox.root, "shims"))).toBe(true);
      expect((absent.PATH as string).includes(join(sandbox.root, "shims"))).toBe(false);

      writeFileSync(sandbox.execLog, "");
      mkdirSync(join(sandbox.project, ".navori"), { recursive: true });
      spawnSync(
        "bash",
        ["-c", "date >/dev/null; basename a/b >/dev/null; basename c/d >/dev/null"],
        {
          cwd: sandbox.project,
          env: active,
        },
      );
      expect(countExecs(readFileSync(sandbox.execLog, "utf8"))).toMatchObject({
        date: 1,
        basename: 2,
        jq: 0,
      });
    } finally {
      sandbox.cleanup();
    }
  });

  // Covers: R4
  it("bench:context mide bytes por fuente", async () => {
    const context = (await import(scriptUrl("bench-context.mjs"))) as {
      bytesOf: (text: string | null | undefined) => number;
      injectsContext: (stdout: string) => boolean;
    };
    expect(context.bytesOf("abc")).toBe(3);
    expect(context.bytesOf("ñ€")).toBe(5);
    expect(context.bytesOf(null)).toBe(0);
    const emitted = (additionalContext: string): string =>
      JSON.stringify({ hookSpecificOutput: { hookEventName: "X", additionalContext } });
    expect(context.injectsContext(emitted("something to say"))).toBe(true);
    expect(context.injectsContext(emitted("   "))).toBe(false);
    expect(context.injectsContext(JSON.stringify({ systemMessage: "heads up" }))).toBe(true);
    expect(
      context.injectsContext(
        JSON.stringify({ hookSpecificOutput: { permissionDecision: "allow" } }),
      ),
    ).toBe(false);
    expect(context.injectsContext("")).toBe(false);
    expect(context.injectsContext("plain text context")).toBe(true);
  });

  // Covers: R14, R24
  it("probe de carga perezosa y grafo de imports sobre fixtures", async () => {
    const probe = (await import(scriptUrl("probe-lazy-load.mjs"))) as {
      belowThreshold: (
        subs: { sub: string; savingMsMedian: number }[],
        thresholdMs?: number,
      ) => string[];
      summarizeSub: (
        sub: string,
        bundleMs: number[],
        isolatedMs: number[],
      ) => { sub: string; savingMsMedian: number };
      THRESHOLD_MS: number;
    };
    const tools = probe.summarizeSub("tools", [120, 100, 110], [80, 70, 75]);
    expect(tools.savingMsMedian).toBe(35);
    const plan = probe.summarizeSub("plan", [100, 100, 100], [90, 85, 95]);
    expect(plan.savingMsMedian).toBe(10);
    expect(probe.THRESHOLD_MS).toBe(20);
    expect(probe.belowThreshold([tools, plan])).toEqual(["plan: 10 ms < 20 ms"]);
    expect(probe.belowThreshold([tools])).toEqual([]);

    const graph = (await import(scriptUrl("test-import-graph.mjs"))) as {
      buildGraph: (sources: Record<string, string>) => Map<string, string[]>;
      fanIn: (
        graph: Map<string, string[]>,
        tests: string[],
      ) => { totalTests: number; modules: { module: string; fanIn: number; pct: number }[] };
      hubs: (result: ReturnType<typeof graph.fanIn>, fraction?: number) => string[];
      parseSpecifiers: (source: string) => string[];
    };
    expect(
      graph.parseSpecifiers(
        'import { a } from "./a.ts";\nexport * from "../b.ts";\nconst c = await import("./c.ts");\nimport "pkg";\nimport x from "node:fs";',
      ),
    ).toEqual(["./a.ts", "../b.ts", "./c.ts"]);
    const sources = {
      "src/lib/config.ts": "",
      "src/lib/leaf.ts": 'import { c } from "./config.ts";',
      "src/lib/alone.ts": "",
      "src/__tests__/one.test.ts": 'import { l } from "../lib/leaf.ts";',
      "src/__tests__/two.test.ts": 'import { c } from "../lib/config.ts";',
      "src/__tests__/three.test.ts":
        'import { l } from "../lib/leaf.ts";\nimport { c } from "../lib/config.js";',
      "src/__tests__/four.test.ts": "",
    };
    const tests = Object.keys(sources).filter((f) => f.endsWith(".test.ts"));
    const result = graph.fanIn(graph.buildGraph(sources), tests);
    expect(result.totalTests).toBe(4);
    expect(result.modules).toEqual([
      { module: "src/lib/config.ts", fanIn: 3, pct: 75 },
      { module: "src/lib/leaf.ts", fanIn: 2, pct: 50 },
    ]);
    expect(graph.hubs(result)).toEqual(["src/lib/config.ts", "src/lib/leaf.ts"]);
    expect(graph.hubs(result, 0.6)).toEqual(["src/lib/config.ts"]);
  });
});
