import { describe, it, expect } from "vitest";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isComparable, readSpawnCounts, summarizeReport } from "../../scripts/bench-tests.mjs";
import {
  budgetViolations,
  proposeBudget,
  validateBudget,
} from "../../scripts/check-test-budget.mjs";

/**
 * Spec 0054 M1 — the measurement scripts. Fixed fixtures only: no test here
 * runs the real suite or the real hooks.
 */

const here = dirname(fileURLToPath(import.meta.url));
const BUDGET_SCRIPT = resolve(here, "..", "..", "scripts", "check-test-budget.mjs");
const ROOT = "/repo/packages/cli";

interface BenchObservation {
  generatedAt: string;
  workers: number;
  loadavgBefore: number[];
  comparable: boolean;
  success: boolean;
  vitestExit: number;
  wallMs: number;
  totalFiles: number;
  totalTests: number;
  sumFilesMs: number;
  files: { file: string; ms: number; status: string; tests: number }[];
}

/** Produces independent, complete bench observations without running the real suite. */
function budgetObservations(
  files: string[] = ["src/fast.test.ts", "src/slow.test.ts"],
): BenchObservation[] {
  return [0, 1, 2].map((index) => {
    const rows = files.map((file, fileIndex) => ({
      file,
      ms: fileIndex === 0 ? 16_000 : [20_000, 24_001, 21_000][index]!,
      status: "passed",
      tests: 1,
    }));
    return {
      generatedAt: `2026-10-18T00:00:0${index}.000Z`,
      workers: 4,
      loadavgBefore: [4, 20, 20],
      comparable: true,
      success: true,
      vitestExit: 0,
      wallMs: 100_000,
      totalFiles: rows.length,
      totalTests: rows.length,
      sumFilesMs: rows.reduce((sum, row) => sum + row.ms, 0),
      files: rows,
    };
  });
}

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
  argumentFreeInvocation: (command: string, directory: string, hook: string) => boolean;
  parseBenchArgs: (argv: string[]) => {
    impl: "shell" | "rust";
    runs: number;
    scenarios: string[];
    hooks?: string[];
    reportOnly: boolean;
  };
  filterHooks: (
    registrations: Registration[],
    scenarios: string[],
    hooks: string[] | undefined,
  ) => Registration[];
  p95: (samples: number[]) => number;
  SCENARIOS: Record<string, unknown>;
  SUPPLEMENTAL_SCENARIOS: Record<string, unknown>;
  readRegistrations: (sourceRoot?: string) => Registration[];
  summarizeObservations: (reports: { name: string; report: unknown }[]) => {
    errors: string[];
    groups: { head: string; reports: number; cells: Record<string, unknown>[] }[];
  };
  writePayload: (sandbox: Sandbox, scenario: string, reg: Registration) => string;
  scenarioEnvironment: (
    sandbox: Sandbox,
    scenario: string,
    reg: Registration,
    audit: "absent" | "root" | "active",
    counting?: boolean,
  ) => NodeJS.ProcessEnv;
  countExecs: (log: string) => Record<string, number>;
  createSandbox: (sourceRoot?: string, options?: { requireDist?: boolean }) => Sandbox;
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

/** Builds process-only tooling fixtures; the fake binary is never evidence of a ported hook. */
function nativeBenchFixture(event = "SessionStart"): {
  root: string;
  manifest: string;
  binary: string;
  run: (args?: string[], env?: NodeJS.ProcessEnv) => SpawnSyncReturns<string>;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "navori-native-bench-"));
  const scripts = join(root, "scripts/js");
  const hooks = join(root, ".claude/hooks");
  for (const dir of [
    scripts,
    hooks,
    join(root, ".codex"),
    join(root, "crates"),
    join(root, "packages/cli/src/engines/pi"),
    join(root, "packages/cli/dist"),
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  // The shell bench fails closed without a local dist; a stub satisfies that precondition.
  writeFileSync(join(root, "packages/cli/dist/index.js"), "");
  for (const file of [
    "bench-hooks.mjs",
    "bench-provenance.mjs",
    "git-env.mjs",
    "rust-hook-adapter.mjs",
  ]) {
    copyFileSync(fileURLToPath(scriptUrl(file)), join(scripts, file));
  }
  mkdirSync(join(scripts, "bench-payloads"));
  const payload = JSON.parse(
    readFileSync(fileURLToPath(scriptUrl("bench-payloads/session-start.json")), "utf8"),
  ) as Record<string, unknown>;
  payload.hook_event_name = event;
  writeFileSync(join(scripts, "bench-payloads/session-start.json"), JSON.stringify(payload));
  writeFileSync(
    join(root, ".claude/settings.json"),
    JSON.stringify({
      hooks: { [event]: [{ hooks: [{ command: 'bash ".claude/hooks/probe.sh"' }] }] },
    }),
  );
  writeFileSync(join(root, ".codex/config.toml"), "");
  writeFileSync(join(root, "packages/cli/src/engines/pi/hook-bindings.ts"), "");
  writeFileSync(join(hooks, "probe.sh"), "exit 0\n");
  const manifest = join(root, "crates/ported.json");
  writeFileSync(manifest, JSON.stringify({ schema: 2, hooks: { probe: { mode: "active" } } }));
  const binary = join(root, "native fixture");
  writeFileSync(
    binary,
    [
      `#!${process.execPath}`,
      'import { appendFileSync, readFileSync } from "node:fs";',
      "if (process.ppid !== Number(process.env.BENCH_EXPECT_PARENT)) process.exit(99);",
      'appendFileSync(process.env.BENCH_NATIVE_LOG, JSON.stringify({argv:process.argv.slice(2), mode:process.env.NAVORI_HOOK_IMPL, input:readFileSync(0,"utf8"), cwd:process.cwd()})+"\\n");',
      'if (process.env.BENCH_NATIVE_DEFER) process.stderr.write("navori-rust: hook deferred: fixture unavailable\\n");',
      'process.exit(Number(process.env.BENCH_NATIVE_EXIT ?? "1"));',
      "",
    ].join("\n"),
  );
  chmodSync(binary, 0o755);
  const driver = join(root, "driver.mjs");
  writeFileSync(
    driver,
    [
      'import { main, SCENARIOS } from "./scripts/js/bench-hooks.mjs";',
      "SCENARIOS.SessionStart.events = [process.env.BENCH_EVENT];",
      "process.env.BENCH_EXPECT_PARENT = String(process.pid);",
      "process.exitCode = await main(process.argv.slice(2));",
      "",
    ].join("\n"),
  );
  return {
    root,
    manifest,
    binary,
    run(args = ["--impl", "rust"], env = {}) {
      return spawnSync(
        process.execPath,
        [driver, ...args, "--scenario", "SessionStart", "--runs", "2", "--report-only"],
        {
          cwd: root,
          env: {
            ...process.env,
            NAVORI_RUST_BIN: binary,
            NAVORI_RUST_HOOKS_DIR: root,
            BENCH_NATIVE_LOG: join(root, "native.jsonl"),
            BENCH_EVENT: event,
            ...env,
          },
          encoding: "utf8",
        },
      );
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("bench scripts", () => {
  // Covers: R17
  it("bench --impl rust mide el binario sin wrapper", () => {
    const fixture = nativeBenchFixture();
    try {
      const run = fixture.run();
      expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
      expect(run.stdout).toContain("ms wall median /");
      expect(run.stdout).toContain("ms wall p95");
      const calls = readFileSync(join(fixture.root, "native.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as { argv: string[]; mode: string; input: string; cwd: string },
        );
      expect(calls).toHaveLength(2);
      for (const call of calls) {
        expect(call.argv).toEqual([
          "hook",
          "--via-command",
          "SessionStart",
          join(fixture.root, ".claude/hooks/probe.sh"),
        ]);
        expect(call.mode).toBe("rust");
        expect(JSON.parse(call.input)).toMatchObject({
          hook_event_name: "SessionStart",
          session_id: "bench-session",
        });
        expect(call.cwd).not.toBe(fixture.root);
      }
      const report = JSON.parse(
        readFileSync(join(fixture.root, ".navori/state/bench/hooks-rust-latest.json"), "utf8"),
      ) as {
        impl: string;
        metric: string;
        unit: string;
        comparable: boolean;
        budget: { metric: string; limitMs: number };
        measurements: {
          wallMsMedian: number;
          wallMsP95: number;
          runsMs: number[];
          exitCodes: number[];
          cpuMsMedian?: number;
        }[];
      };
      expect(report).toMatchObject({
        impl: "rust",
        metric: "wall",
        unit: "ms",
        audit: "absent",
        budget: { metric: "wallMsP95", limitMs: 5 },
      });
      expect(typeof report.comparable).toBe("boolean");
      expect(report.measurements).toHaveLength(1);
      for (const row of report.measurements) {
        expect(row.wallMsP95).toBe(hooksModule.p95(row.runsMs));
        expect(row.wallMsMedian).toBe(median(row.runsMs));
        expect(row.runsMs.every((sample) => Number.isFinite(sample) && sample > 0)).toBe(true);
        expect(row.exitCodes).toEqual([1, 1]);
        expect(row.cpuMsMedian).toBeUndefined();
      }
      expect(existsSync(join(fixture.root, ".navori/state/bench/hooks-latest.json"))).toBe(false);
      expect(hooksModule.p95(Array.from({ length: 20 }, (_, index) => index + 1))).toBe(19);
    } finally {
      fixture.cleanup();
    }
  });

  // Covers: R17
  it("bench Rust conserva PreToolUse y Stop por timeRustOnce hasta argv nativo", () => {
    for (const event of ["PreToolUse", "Stop"]) {
      const fixture = nativeBenchFixture(event);
      try {
        const run = fixture.run();
        expect(run.status, `${event}: ${run.stdout}\n${run.stderr}`).toBe(0);
        const calls = readFileSync(join(fixture.root, "native.jsonl"), "utf8").trim().split("\n");
        expect(calls).toHaveLength(2);
        for (const line of calls) {
          const call = JSON.parse(line) as { argv: string[]; input: string };
          expect(call.argv).toEqual([
            "hook",
            "--via-command",
            event,
            join(fixture.root, ".claude/hooks/probe.sh"),
          ]);
          expect(JSON.parse(call.input)).toMatchObject({ hook_event_name: event });
        }
      } finally {
        fixture.cleanup();
      }
    }
  });

  // Covers: R17
  it("bench Rust rechaza registrations con argv no acreditado aun con report-only", () => {
    const commands = [
      'bash ".claude/hooks/probe.sh" claude-session-start',
      'bash ".claude/hooks/probe.sh" claude-post-model-switch',
      'bash ".claude/hooks/probe.sh" claude-stop',
      'f="$CLAUDE_PROJECT_DIR/.claude/hooks/probe.sh"; bash -n "$f" 2>/dev/null && exec bash "$f" claude-session-start; exit 1',
    ];
    for (const command of commands) {
      const fixture = nativeBenchFixture();
      try {
        writeFileSync(
          join(fixture.root, ".claude/settings.json"),
          JSON.stringify({
            hooks: { SessionStart: [{ hooks: [{ command }] }] },
          }),
        );
        const run = fixture.run();
        expect(run.status, `${command}: ${run.stdout}\n${run.stderr}`).toBe(1);
        expect(run.stderr).toContain("native registration unsupported");
        expect(existsSync(join(fixture.root, "native.jsonl"))).toBe(false);
        expect(existsSync(join(fixture.root, ".navori/state/bench/hooks-rust-latest.json"))).toBe(
          false,
        );
      } finally {
        fixture.cleanup();
      }
    }
  });

  // Covers: R17
  it("bench Rust rechaza root y active sin fixtures CLI válidas aun con report-only", () => {
    for (const audit of ["root", "active"]) {
      const fixture = nativeBenchFixture();
      try {
        const run = fixture.run(["--impl", "rust", "--audit", audit]);
        expect(run.status, run.stderr).toBe(1);
        expect(run.stderr).toContain(`native audit ${audit} unsupported`);
        expect(run.stderr).toContain("CLI-writer fixtures");
        expect(existsSync(join(fixture.root, "native.jsonl"))).toBe(false);
        expect(existsSync(join(fixture.root, ".navori/state/bench/hooks-rust-latest.json"))).toBe(
          false,
        );
      } finally {
        fixture.cleanup();
      }
    }
  });

  // Covers: R17
  it("bench Rust falla unavailable incluso con report-only y no confunde exit1 legítimo", () => {
    const cases = [
      "missing",
      "empty",
      "unsupported-mode",
      "unregistered",
      "defer",
      "forced-defer",
      "shadow-defer",
      "shadow-forced-defer",
    ] as const;
    for (const mode of cases) {
      const fixture = nativeBenchFixture();
      try {
        const env: NodeJS.ProcessEnv = {};
        if (mode === "missing") env.NAVORI_RUST_BIN = join(fixture.root, "missing");
        if (mode === "empty")
          writeFileSync(fixture.manifest, JSON.stringify({ schema: 2, hooks: {} }));
        if (mode === "unsupported-mode")
          writeFileSync(
            fixture.manifest,
            JSON.stringify({ schema: 2, hooks: { probe: { mode: "unknown" } } }),
          );
        if (mode === "unregistered")
          writeFileSync(
            fixture.manifest,
            JSON.stringify({ schema: 2, hooks: { other: { mode: "active" } } }),
          );
        if (mode === "defer") env.BENCH_NATIVE_EXIT = "3";
        if (mode === "forced-defer") env.BENCH_NATIVE_DEFER = "1";
        if (mode === "shadow-defer" || mode === "shadow-forced-defer") {
          writeFileSync(
            fixture.manifest,
            JSON.stringify({ schema: 2, hooks: { probe: { mode: "shadow" } } }),
          );
          if (mode === "shadow-defer") env.BENCH_NATIVE_EXIT = "3";
          else env.BENCH_NATIVE_DEFER = "1";
        }
        const run = fixture.run(undefined, env);
        expect(run.status, `${mode}: ${run.stdout}\n${run.stderr}`).toBe(1);
        expect(run.stderr).toContain("native unavailable");
        expect(existsSync(join(fixture.root, ".navori/state/bench/hooks-rust-latest.json"))).toBe(
          false,
        );
      } finally {
        fixture.cleanup();
      }
    }
  });

  // Covers: R17
  it("bench permite descriptor shadow sólo con argv de ejecución nativa forzada", () => {
    const fixture = nativeBenchFixture();
    try {
      writeFileSync(
        fixture.manifest,
        JSON.stringify({ schema: 2, hooks: { probe: { mode: "shadow" } } }),
      );
      const run = fixture.run(undefined, { NAVORI_HOOK_IMPL: "shell" });
      expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
      const calls = readFileSync(join(fixture.root, "native.jsonl"), "utf8").trim().split("\n");
      expect(calls).toHaveLength(2);
      for (const line of calls) {
        const call = JSON.parse(line) as { argv: string[]; mode: string };
        expect(call.mode).toBe("rust");
        expect(call.argv).toEqual([
          "hook",
          "--via-command",
          "SessionStart",
          join(fixture.root, ".claude/hooks/probe.sh"),
        ]);
      }
    } finally {
      fixture.cleanup();
    }
  });

  // Covers: R17
  // Covers: R17
  it("bench --impl rust solo acepta las invocaciones sin argumentos que navori renderiza", () => {
    const accept = hooksModule.argumentFreeInvocation;
    const dir = ".claude/hooks";
    const hook = "probe.sh";
    const prefix = `f="$CLAUDE_PROJECT_DIR/${dir}/${hook}"; `;
    const guard = `bash -n "$f" 2>/dev/null && exec bash "$f"; printf ask`;
    const wrapper = `if "$nv_native" hook --via-command 'PreToolUse' "$f" --shadow; then x; fi`;
    expect(accept(`bash "${dir}/${hook}"`, dir, hook)).toBe(true);
    expect(accept(prefix + guard, dir, hook)).toBe(true);
    expect(accept(`${prefix}${wrapper}\n${guard}`, dir, hook)).toBe(true);
    expect(accept(prefix + wrapper.replace(" --shadow", ""), dir, hook)).toBe(true);
    expect(accept(`bash "$(git rev-parse --show-toplevel)/${dir}/${hook}"`, dir, hook)).toBe(true);
    for (const command of [
      `bash "$(git rev-parse --show-toplevel)/${dir}/${hook}" codex`,
      `bash "$(pwd)/${dir}/${hook}"`,
      prefix + guard.replace('exec bash "$f";', 'exec bash "$f" claude-stop;'),
      `${prefix}${wrapper}\n${guard} "$f" extra`,
      `f="$CLAUDE_PROJECT_DIR/${dir}/other.sh"; ${guard}`,
      `bash "${dir}/${hook}" arg`,
    ]) {
      expect(accept(command, dir, hook), command).toBe(false);
    }
  });

  // Covers: R55
  it("quality-gate fuera de commit mide p95 rust y shell con los mismos payloads", () => {
    const fixture = nativeBenchFixture("PreToolUse");
    const hook = "quality-gate-pre-commit.sh";
    try {
      const { root } = fixture;
      copyFileSync(
        fileURLToPath(scriptUrl("bench-payloads/bash.json")),
        join(root, "scripts/js/bench-payloads/bash.json"),
      );
      writeFileSync(
        join(root, ".claude/settings.json"),
        JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                matcher: "Bash",
                hooks: [
                  {
                    command: `f="$CLAUDE_PROJECT_DIR/.claude/hooks/${hook}"; bash -n "$f" 2>/dev/null && exec bash "$f"; printf ask`,
                  },
                ],
              },
            ],
          },
        }),
      );
      writeFileSync(
        join(root, ".codex/config.toml"),
        [
          "[[hooks.PreToolUse]]",
          'matcher = "^Bash$"',
          "[[hooks.PreToolUse.hooks]]",
          `command = "bash \\"$(git rev-parse --show-toplevel)/.codex/hooks/${hook}\\""`,
          "",
        ].join("\n"),
      );
      writeFileSync(
        join(root, "packages/cli/src/engines/pi/hook-bindings.ts"),
        `{ script: "quality-gate-pre-commit", on: "tool_call", tools: ["bash"], scope: "all" },\n`,
      );
      // The shell copy logs the payload it reads; the native fixture logs its own.
      for (const dir of [".claude/hooks", ".codex/hooks", ".pi/navori/hooks"]) {
        mkdirSync(join(root, dir), { recursive: true });
        writeFileSync(
          join(root, dir, hook),
          `printf '%s\\n' "$(cat | tr -d '\\n')" >> "$BENCH_SHELL_LOG"\nexit 0\n`,
        );
      }
      writeFileSync(
        fixture.manifest,
        JSON.stringify({ schema: 1, hooks: { "quality-gate-pre-commit": { mode: "shadow" } } }),
      );
      const run = (impl: "rust" | "shell") =>
        spawnSync(
          process.execPath,
          [
            join(root, "driver.mjs"),
            "--impl",
            impl,
            "--scenario",
            "Bash",
            "--runs",
            "2",
            "--report-only",
          ],
          {
            cwd: root,
            env: {
              ...process.env,
              NAVORI_RUST_BIN: fixture.binary,
              NAVORI_RUST_HOOKS_DIR: root,
              BENCH_NATIVE_LOG: join(root, "native.jsonl"),
              BENCH_NATIVE_EXIT: "0",
              BENCH_SHELL_LOG: join(root, "shell.jsonl"),
              BENCH_EVENT: "SessionStart",
            },
            encoding: "utf8",
          },
        );
      type Row = { engine: string; hook: string; wallMsP95: number; runsMs: number[] };
      const rows = (name: string): Row[] =>
        (
          JSON.parse(readFileSync(join(root, ".navori/state/bench", name), "utf8")) as {
            measurements: Row[];
          }
        ).measurements;
      // Payloads differ only in the sandbox project path, which each run creates afresh.
      const shape = (input: string): unknown => {
        const payload = JSON.parse(input) as Record<string, unknown>;
        return { ...payload, cwd: "<cwd>", transcript_path: "<transcript>" };
      };

      const rust = run("rust");
      expect(rust.status, `${rust.stdout}\n${rust.stderr}`).toBe(0);
      const shell = run("shell");
      expect(shell.status, `${shell.stdout}\n${shell.stderr}`).toBe(0);

      const native = readFileSync(join(root, "native.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { argv: string[]; input: string });
      expect(native).toHaveLength(6);
      const scripts = native.map((call) => call.argv[3]);
      for (const dir of [".claude/hooks", ".codex/hooks", ".pi/navori/hooks"]) {
        expect(scripts.filter((script) => script === join(root, dir, hook))).toHaveLength(2);
      }
      const shellInputs = readFileSync(join(root, "shell.jsonl"), "utf8").trim().split("\n");
      // Three audit scenarios per engine, each timed twice and counted once.
      expect(shellInputs).toHaveLength(27);
      const expected = shape(native[0]!.input);
      expect(expected).toMatchObject({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "git status --short" },
      });
      for (const input of [...native.map((call) => call.input), ...shellInputs]) {
        expect(shape(input)).toEqual(expected);
      }

      const rustRows = rows("hooks-rust-latest.json");
      const shellRows = rows("hooks-latest.json");
      for (const engine of ["claude", "codex", "pi"]) {
        for (const report of [rustRows, shellRows]) {
          const measured = report.filter((row) => row.engine === engine && row.hook === hook);
          expect(measured.length, engine).toBeGreaterThan(0);
          for (const row of measured) expect(row.wallMsP95).toBe(hooksModule.p95(row.runsMs));
        }
      }
    } finally {
      fixture.cleanup();
    }
  });

  // Covers: R55
  it("bench --hook acota las registrations y rechaza un hook que no dispara", () => {
    const reg = (engine: Registration["engine"], hook: string, matcher = "Bash"): Registration => ({
      engine,
      event: "PreToolUse",
      matcher,
      command: `bash ".${engine}/hooks/${hook}"`,
    });
    const all = [
      reg("claude", "guard-destructive.sh"),
      reg("claude", "quality-gate-pre-commit.sh"),
      reg("codex", "quality-gate-pre-commit.sh"),
      reg("claude", "edit-only.sh", "Edit"),
    ];
    expect(
      hooksModule.parseBenchArgs(["--hook", "quality-gate-pre-commit.sh", "--hook", "a.sh"]),
    ).toMatchObject({ hooks: ["quality-gate-pre-commit.sh", "a.sh"] });
    expect(hooksModule.parseBenchArgs([]).hooks).toBeUndefined();
    for (const args of [["--hook"], ["--hook", "../x.sh"], ["--hook", "quality-gate"]]) {
      expect(() => hooksModule.parseBenchArgs(args), args.join(" ")).toThrow(/--hook/);
    }
    expect(hooksModule.filterHooks(all, ["Bash"], undefined)).toBe(all);
    expect(hooksModule.filterHooks(all, ["Bash"], ["quality-gate-pre-commit.sh"])).toEqual([
      all[1],
      all[2],
    ]);
    // Registered, but not for the selected scenario: measuring nothing must not pass.
    expect(() => hooksModule.filterHooks(all, ["Bash"], ["edit-only.sh"])).toThrow(
      /not registered in the selected scenarios: edit-only\.sh/,
    );
    expect(() => hooksModule.filterHooks(all, ["Bash"], ["missing.sh"])).toThrow(/missing\.sh/);
  });

  it("bench valida impl estrictamente y conserva shell por default y su API CPU", () => {
    expect(hooksModule.parseBenchArgs([])).toMatchObject({
      impl: "shell",
      runs: 3,
      reportOnly: false,
    });
    expect(hooksModule.parseBenchArgs(["--impl", "rust"])).toMatchObject({
      impl: "rust",
      runs: 40,
    });
    expect(hooksModule.parseBenchArgs(["--root", "base"])).toMatchObject({
      impl: "shell",
      root: resolve("base"),
    });
    expect(() => hooksModule.parseBenchArgs(["--impl", "rust", "--root", "base"])).toThrow(
      /--root requires --impl shell/,
    );
    const fixture = nativeBenchFixture();
    try {
      for (const args of [
        ["--impl"],
        ["--impl", "typo"],
        ["--impl", "rust", "--impl", "shell"],
        ["--impl=rust"],
      ]) {
        const run = fixture.run(args);
        expect(run.status, run.stderr).toBe(2);
      }
      for (const args of [[], ["--impl", "shell"]]) {
        const run = fixture.run(args);
        expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
        const report = JSON.parse(
          readFileSync(join(fixture.root, ".navori/state/bench/hooks-latest.json"), "utf8"),
        ) as { budgetMs: number; measurements: { cpuMsMedian: number }[] };
        expect(report.budgetMs).toBe(BASH_BUDGET_MS);
        expect(report.measurements).toHaveLength(3);
        expect(report.measurements.every((row) => typeof row.cpuMsMedian === "number")).toBe(true);
      }
      expect(existsSync(join(fixture.root, "native.jsonl"))).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  // Covers: R30
  it("propone solo excepciones sobre el default desde el máximo de tres mediciones en reposo", () => {
    const observations = budgetObservations();
    observations[1]!.files.reverse();
    const proposal = proposeBudget(
      observations,
      {
        defaultMs: 20_000,
        exceptions: [{ file: "src/stale.test.ts", ms: 90_000, reason: "old measurement" }],
      },
      ["src/slow.test.ts", "src/fast.test.ts"],
    );
    expect(proposal.defaultMs).toBe(20_000);
    expect(proposal.exceptions).toEqual([
      {
        file: "src/slow.test.ts",
        ms: 35_000,
        reason: expect.stringContaining("20000, 24001, 21000 ms"),
      },
    ]);
    for (const observation of observations)
      expect(proposal.exceptions[0]!.reason).toContain(observation.generatedAt);
    expect(validateBudget(proposal).ok).toBe(true);
  });

  // Covers: R30
  it.each([
    {
      id: "too few",
      mutate: (rows: BenchObservation[]): void => {
        rows.pop();
      },
    },
    {
      id: "too many",
      mutate: (rows: BenchObservation[]): void => {
        rows.push(rows[0]!);
      },
    },
    {
      id: "duplicate observation",
      mutate: (rows: BenchObservation[]): void => {
        rows[1]!.generatedAt = rows[0]!.generatedAt;
      },
    },
    {
      id: "failed exit",
      mutate: (rows: BenchObservation[]): void => {
        rows[0]!.vitestExit = 1;
      },
    },
    {
      id: "failed run",
      mutate: (rows: BenchObservation[]): void => {
        rows[0]!.success = false;
      },
    },
    {
      id: "noncomparable",
      mutate: (rows: BenchObservation[]): void => {
        rows[0]!.comparable = false;
      },
    },
    {
      id: "false idle claim",
      mutate: (rows: BenchObservation[]): void => {
        rows[0]!.loadavgBefore[0] = 4.01;
      },
    },
    {
      id: "invalid load",
      mutate: (rows: BenchObservation[]): void => {
        rows[0]!.loadavgBefore[0] = Number.NaN;
      },
    },
    {
      id: "zero workers",
      mutate: (rows: BenchObservation[]): void => {
        rows[0]!.workers = 0;
      },
    },
    {
      id: "different workers",
      mutate: (rows: BenchObservation[]): void => {
        rows[0]!.workers = 5;
      },
    },
    {
      id: "negative duration",
      mutate: (rows: BenchObservation[]): void => {
        rows[0]!.files[0]!.ms = -1;
      },
    },
    {
      id: "infinite duration",
      mutate: (rows: BenchObservation[]): void => {
        rows[0]!.files[0]!.ms = Infinity;
      },
    },
    {
      id: "unsafe proposal",
      mutate: (rows: BenchObservation[]): void => {
        rows[0]!.files[0]!.ms = 1e100;
        rows[0]!.sumFilesMs = 1e100;
      },
    },
    {
      id: "failed file",
      mutate: (rows: BenchObservation[]): void => {
        rows[0]!.files[0]!.status = "failed";
      },
    },
    {
      id: "duplicate file",
      mutate: (rows: BenchObservation[]): void => {
        rows[0]!.files[1]!.file = rows[0]!.files[0]!.file;
      },
    },
    {
      id: "different file set",
      mutate: (rows: BenchObservation[]): void => {
        rows[0]!.files[0]!.file = "src/other.test.ts";
      },
    },
    {
      id: "partial report",
      mutate: (rows: BenchObservation[]): void => {
        rows[0]!.files.pop();
      },
    },
    {
      id: "inconsistent total",
      mutate: (rows: BenchObservation[]): void => {
        rows[0]!.sumFilesMs++;
      },
    },
  ])("rechaza evidencia no admisible: $id", ({ mutate }) => {
    const rows = budgetObservations();
    mutate(rows);
    expect(() =>
      proposeBudget(rows, { defaultMs: 20_000, exceptions: [] }, [
        "src/fast.test.ts",
        "src/slow.test.ts",
      ]),
    ).toThrow();
  });

  // Covers: R30
  it("rechaza tres reportes parciales aunque coincidan entre sí", () => {
    const partial = budgetObservations(["src/fast.test.ts"]);
    expect(() =>
      proposeBudget(partial, { defaultMs: 20_000, exceptions: [] }, [
        "src/fast.test.ts",
        "src/slow.test.ts",
      ]),
    ).toThrow(/complete current test file set/);
  });

  // Covers: R30
  it("CLI imprime JSON solamente, conserva el presupuesto y rechaza copias o reportes parciales", () => {
    const dir = mkdtempSync(join(tmpdir(), "navori-budget-propose-"));
    try {
      const root = resolve(here, "..", "..");
      const inventory = globSync("src/**/*.test.ts", { cwd: root });
      const observations = budgetObservations(inventory);
      const paths = observations.map((report, index) => {
        const path = join(dir, `bench-${index}.json`);
        writeFileSync(path, JSON.stringify(report));
        return path;
      });
      const budgetPath = join(dir, "budget.json");
      const original = JSON.stringify({ defaultMs: 20_000, exceptions: [] });
      writeFileSync(budgetPath, original);
      const run = (reports: string[], extra: string[] = []): SpawnSyncReturns<string> =>
        spawnSync(
          "node",
          [BUDGET_SCRIPT, "--budget", budgetPath, "--propose", ...reports, ...extra],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              NAVORI_TEST_BUDGET_FACTOR: "invalid-unused",
            },
          },
        );
      const valid = run(paths);
      expect(valid.status, valid.stderr).toBe(0);
      expect(valid.stderr).toBe("");
      const proposal: unknown = JSON.parse(valid.stdout);
      expect(validateBudget(proposal).ok).toBe(true);
      expect(proposal).toMatchObject({
        defaultMs: 20_000,
        exceptions: expect.any(Array),
      });
      expect(readFileSync(budgetPath, "utf8")).toBe(original);
      const copied = join(dir, "copy.json");
      writeFileSync(copied, readFileSync(paths[0]!));
      expect(run([paths[0]!, paths[1]!, copied]).status).toBe(1);
      writeFileSync(paths[2]!, JSON.stringify(budgetObservations([inventory[0]!])[2]));
      const partial = run(paths);
      expect(partial.status).toBe(1);
      expect(partial.stdout).toBe("");
      expect(partial.stderr).toContain("complete current test file set");
      expect(run(paths.slice(0, 2)).status).toBe(1);
      expect(run(paths, ["--report", paths[0]!]).status).toBe(1);
      expect(readFileSync(budgetPath, "utf8")).toBe(original);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Covers: R1, R29
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
            {
              name: join(root, "src/over.test.ts"),
              startTime: 0,
              endTime: 1500,
              status: "passed",
            },
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
      validateBudget({
        defaultMs: 5000,
        exceptions: [ok.exceptions[0], ok.exceptions[0]],
      }).ok,
    ).toBe(false);

    const dir = mkdtempSync(join(tmpdir(), "navori-budget-"));
    try {
      const bad = join(dir, "bad.json");
      writeFileSync(
        bad,
        JSON.stringify({
          defaultMs: 5000,
          exceptions: [{ file: "a", ms: 1, reason: "" }],
        }),
      );
      const run = spawnSync("node", [BUDGET_SCRIPT, "--budget", bad], {
        encoding: "utf8",
      });
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
          {
            matcher: "Bash",
            hooks: [{ command: "bash a.sh" }, { command: "bash b.sh" }],
          },
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
      {
        engine: "codex",
        event: "PreToolUse",
        matcher: "spawn_agent$",
        command: "bash h.sh",
      },
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
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        NAVORI_BENCH_PROC_DIR: procDir,
      };
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

  // Covers: R2, R29
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
      expect(readSpawnCounts(dir)).toEqual({
        "src/a.test.ts": 5,
        "src/c.test.ts": 2,
      });
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

  // Covers: R3, R29
  it("bench:hooks limita la carga inicial a cuatro incluso con más CPUs", () => {
    expect(hooksComparable([4, 90, 90], 10)).toBe(true);
    expect(hooksComparable([4.01, 0, 0], 10)).toBe(false);
    expect(hooksComparable([4.9, 0, 0], 10)).toBe(false);
    expect(hooksComparable([4.01, 0, 0], 64)).toBe(false);
    expect(hooksComparable([1, 0, 0], 2)).toBe(true);
    expect(hooksComparable([1.01, 0, 0], 2)).toBe(false);
    expect(hooksComparable([], 10)).toBe(false);
    expect(hooksComparable([-1, 0, 0], 10)).toBe(false);
    expect(hooksComparable([Number.NaN, 0, 0], 10)).toBe(false);
    expect(hooksComparable([Number.POSITIVE_INFINITY, 0, 0], 10)).toBe(false);
    expect(hooksComparable([1, 0, 0], Number.POSITIVE_INFINITY)).toBe(false);
    expect(hooksComparable([0, 0, 0], 0)).toBe(false);
  });

  // Covers: R3
  it("bench:hooks mide todos los nombres de hooks registrados en el checkout", () => {
    const registrations = hooksModule.readRegistrations();
    expect(Object.keys(hooksModule.SCENARIOS)).toEqual([
      "Bash",
      "Edit",
      "Agent",
      "SessionStart",
      "UserPromptSubmit",
    ]);
    const original = Object.keys(hooksModule.SCENARIOS).flatMap((scenario) =>
      (["claude", "codex", "pi"] as const).flatMap((engine) =>
        selectHooks(registrations, scenario, engine),
      ),
    );
    // The context consumer iterates only SCENARIOS: its 49 groups stay separate from supplements.
    expect(original).toHaveLength(49);
    const scenarios = [
      ...Object.keys(hooksModule.SCENARIOS),
      ...Object.keys(hooksModule.SUPPLEMENTAL_SCENARIOS ?? {}),
    ];
    const selected = scenarios.flatMap((scenario) =>
      (["claude", "codex", "pi"] as const).flatMap((engine) =>
        selectHooks(registrations, scenario, engine),
      ),
    );
    const name = (reg: Registration): string =>
      /([\w-]+\.sh)/.exec(reg.command)?.[1] ?? reg.command;
    const measured = new Set(selected.map(name));
    expect(registrations.length).toBeGreaterThan(0);
    expect([...new Set(registrations.map(name))].filter((hook) => !measured.has(hook))).toEqual([]);
  });

  // Covers: R3
  it("bench:hooks restaura estado suplementario por invocación sin cambiar escenarios previos", () => {
    const sandbox = createSandbox();
    const registrations = hooksModule.readRegistrations();
    const failure = selectHooks(registrations, "BashFailure", "claude")[0]!;
    try {
      for (const audit of ["absent", "root", "active"] as const) {
        expect(hooksModule.scenarioEnvironment(sandbox, "Bash", failure, audit)).toEqual(
          sandbox.env(audit),
        );
      }
      const failurePayload = JSON.parse(
        readFileSync(hooksModule.writePayload(sandbox, "BashFailure", failure), "utf8"),
      ) as Record<string, unknown>;
      expect(failurePayload).toMatchObject({
        hook_event_name: "PostToolUseFailure",
        tool_name: "Bash",
        session_id: "bench-session",
        is_interrupt: false,
        error: "Exit code 1\nbenchmark command failed",
      });
      const state = join(sandbox.project, ".navori/state/hooks/bash-outcome-watch");
      mkdirSync(state, { recursive: true });
      writeFileSync(join(state, "other-session"), "preserved");
      for (let invocation = 0; invocation < 2; invocation += 1) {
        writeFileSync(join(state, "bench-session"), "previous failure");
        const env = hooksModule.scenarioEnvironment(sandbox, "BashFailure", failure, "active");
        expect(env.CLAUDE_CODE_SESSION_ID).toBe("bench-session");
        expect(existsSync(join(state, "bench-session"))).toBe(false);
        expect(readFileSync(join(state, "other-session"), "utf8")).toBe("preserved");
      }
      for (const engine of ["claude", "codex", "pi"] as const) {
        const close = selectHooks(registrations, "SessionEnd", engine).find((reg) =>
          reg.command.includes("audit-mode-close.sh"),
        )!;
        expect(close).toBeDefined();
        const payload = JSON.parse(
          readFileSync(hooksModule.writePayload(sandbox, "SessionEnd", close), "utf8"),
        ) as Record<string, unknown>;
        expect(payload).toEqual({
          session_id: "bench-session",
          cwd: sandbox.project,
          hook_event_name: "SessionEnd",
          reason: "prompt_input_exit",
          permission_mode: "dontAsk",
        });
        for (let invocation = 0; invocation < 2; invocation += 1) {
          const env = hooksModule.scenarioEnvironment(sandbox, "SessionEnd", close, "active");
          const repo = join(env.NAVORI_AUDITS_ROOT as string, "project");
          const log = join(repo, "session-bench-session.log");
          expect(JSON.parse(readFileSync(log, "utf8"))).toEqual({
            event: "start",
            sessionId: "bench-session",
            host: engine,
            repo: "project",
            cwd: sandbox.project,
          });
          expect(readdirSync(join(repo, "spool-bench-session"))).toEqual([]);
          // Simulate the consumer sealing/removing state; the next invocation must recreate it.
          rmSync(log);
          writeFileSync(join(repo, "spool-bench-session", "consumed.json"), "{}");
        }
      }
      const memory = selectHooks(registrations, "Memory", "codex");
      expect(memory.some((reg) => reg.command.includes("engram-write-guard.sh"))).toBe(true);
      const payload = JSON.parse(
        readFileSync(hooksModule.writePayload(sandbox, "Memory", memory[0]!), "utf8"),
      ) as { tool_name: string };
      expect(new RegExp(memory[0]!.matcher!).test(payload.tool_name)).toBe(true);
      for (const args of [["--scenario"], ["--scenario", "unknown"]]) {
        const run = spawnSync(
          process.execPath,
          [fileURLToPath(scriptUrl("bench-hooks.mjs")), ...args],
          { encoding: "utf8" },
        );
        expect(run.status).toBe(2);
        expect(run.stderr).toContain("--scenario needs a known scenario name");
      }
    } finally {
      sandbox.cleanup();
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
        '{ script: "audit-mode-close", on: "session_shutdown", scope: "parent" },',
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
      {
        engine: "pi",
        event: "SessionEnd",
        matcher: null,
        command: 'bash ".pi/navori/hooks/audit-mode-close.sh"',
      },
    ]);
    expect(selectHooks(pi, "Bash", "pi").map((r) => r.command)).toEqual([
      'bash ".pi/navori/hooks/guard-destructive.sh"',
      'bash ".pi/navori/hooks/role-guard.sh"',
    ]);
    expect(selectHooks(pi, "SessionEnd", "pi").map((reg) => reg.command)).toEqual([
      'bash ".pi/navori/hooks/audit-mode-close.sh"',
    ]);

    expect(countExecs("jq\njq\ndate\nnot-a-shim\nperl\n")).toMatchObject({
      jq: 2,
      date: 1,
      perl: 1,
      node: 0,
    });
    expect(hooksComparable([4, 0, 0], 10)).toBe(true);
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

  // Covers: R4, R29
  it("bench:context mide bytes por fuente", async () => {
    const context = (await import(scriptUrl("bench-context.mjs"))) as {
      bytesOf: (text: string | null | undefined) => number;
      injectsContext: (stdout: string) => boolean;
    };
    expect(context.bytesOf("abc")).toBe(3);
    expect(context.bytesOf("ñ€")).toBe(5);
    expect(context.bytesOf(null)).toBe(0);
    const emitted = (additionalContext: string): string =>
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "X", additionalContext },
      });
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
      ) => {
        totalTests: number;
        modules: { module: string; fanIn: number; pct: number }[];
      };
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

  describe("provenance (#1354)", async () => {
    interface Provenance {
      head: string | null;
      dirty: boolean;
      distSha256: string | null;
      assetsSha256: string | null;
    }
    const provenanceModule = (await import(scriptUrl("bench-provenance.mjs"))) as {
      readProvenance: (root: string) => Provenance;
    };
    const { withoutRepoGitEnv } = (await import(scriptUrl("git-env.mjs"))) as {
      withoutRepoGitEnv: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
    };
    const git = (cwd: string, ...args: string[]): string => {
      const run = spawnSync("git", args, {
        cwd,
        env: withoutRepoGitEnv(process.env),
        encoding: "utf8",
      });
      expect(run.status, run.stderr).toBe(0);
      return run.stdout.trim();
    };
    const realHead = git(here, "rev-parse", "HEAD");
    const OTHER_HEAD = "0".repeat(40);

    /** Temp git repo with a built-looking `packages/cli/dist` (gitignored, like the real one). */
    function fixtureCheckout(): string {
      const root = mkdtempSync(join(tmpdir(), "navori-provenance-"));
      git(root, "init", "-q");
      mkdirSync(join(root, "packages", "cli", "dist", "assets", "core"), { recursive: true });
      writeFileSync(join(root, ".gitignore"), "dist/\n");
      writeFileSync(join(root, "tracked.txt"), "one\n");
      writeFileSync(join(root, "packages", "cli", "dist", "index.js"), "// bundle\n");
      writeFileSync(
        join(root, "packages", "cli", "dist", "assets", "core", "asset.txt"),
        "asset\n",
      );
      git(root, "add", "-A");
      git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
      return root;
    }

    // Covers: R3, R29
    it("readProvenance: limpio, sucio y sin git", () => {
      const root = fixtureCheckout();
      const plain = mkdtempSync(join(tmpdir(), "navori-provenance-nogit-"));
      try {
        const clean = provenanceModule.readProvenance(root);
        expect(clean.head).toBe(git(root, "rev-parse", "HEAD"));
        expect(clean.dirty).toBe(false);
        expect(clean.distSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(clean.assetsSha256).toMatch(/^[0-9a-f]{64}$/);

        writeFileSync(
          join(root, "packages", "cli", "dist", "assets", "core", "asset.txt"),
          "changed\n",
        );
        const assetsChanged = provenanceModule.readProvenance(root);
        expect(assetsChanged.dirty).toBe(false); // dist is gitignored: only the hash sees it
        expect(assetsChanged.assetsSha256).not.toBe(clean.assetsSha256);
        expect(assetsChanged.distSha256).toBe(clean.distSha256);
        writeFileSync(join(root, "packages", "cli", "dist", "index.js"), "// other bundle\n");
        expect(provenanceModule.readProvenance(root).distSha256).not.toBe(clean.distSha256);

        writeFileSync(join(root, "tracked.txt"), "two\n");
        expect(provenanceModule.readProvenance(root).dirty).toBe(true);
        git(root, "checkout", "--", "tracked.txt");
        writeFileSync(join(root, "untracked.txt"), "x\n");
        expect(provenanceModule.readProvenance(root).dirty).toBe(true);

        expect(provenanceModule.readProvenance(plain)).toEqual({
          head: null,
          dirty: true,
          distSha256: null,
          assetsSha256: null,
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(plain, { recursive: true, force: true });
      }
    });

    // Covers: R3
    it("bench:hooks --root lee registros, arboles y dist del otro checkout y falla cerrado sin dist", () => {
      const root = fixtureCheckout();
      try {
        mkdirSync(join(root, ".claude", "hooks"), { recursive: true });
        mkdirSync(join(root, ".codex"), { recursive: true });
        mkdirSync(join(root, "packages", "cli", "src", "engines", "pi"), { recursive: true });
        writeFileSync(join(root, ".claude", "hooks", "only-here.sh"), "#!/bin/sh\n");
        writeFileSync(
          join(root, ".claude", "settings.json"),
          JSON.stringify({
            hooks: {
              SessionStart: [{ hooks: [{ command: 'bash ".claude/hooks/only-here.sh"' }] }],
            },
          }),
        );
        writeFileSync(join(root, ".codex", "config.toml"), "");
        writeFileSync(
          join(root, "packages", "cli", "src", "engines", "pi", "hook-bindings.ts"),
          "",
        );

        expect(hooksModule.readRegistrations(root)).toEqual([
          {
            engine: "claude",
            event: "SessionStart",
            matcher: null,
            command: 'bash ".claude/hooks/only-here.sh"',
          },
        ]);
        expect(hooksModule.readRegistrations().length).toBeGreaterThan(1);

        const sandbox = hooksModule.createSandbox(root, { requireDist: true });
        try {
          expect(existsSync(join(sandbox.project, ".claude", "hooks", "only-here.sh"))).toBe(true);
          expect(readlinkSync(join(sandbox.root, "bin", "navori"))).toBe(
            join(root, "packages", "cli", "dist", "index.js"),
          );
        } finally {
          sandbox.cleanup();
        }

        rmSync(join(root, "packages", "cli", "dist"), { recursive: true, force: true });
        expect(() => hooksModule.createSandbox(root, { requireDist: true })).toThrow(
          /dist\/index\.js is missing/,
        );
        const run = spawnSync(
          process.execPath,
          [
            fileURLToPath(scriptUrl("bench-hooks.mjs")),
            "--root",
            root,
            "--scenario",
            "SessionStart",
            "--runs",
            "1",
          ],
          { encoding: "utf8" },
        );
        expect(run.status).toBe(2);
        expect(run.stderr).toContain("dist/index.js is missing");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    interface HooksReport {
      generatedAt: string;
      comparable: boolean;
      provenance?: Record<string, unknown>;
      measurements: Record<string, unknown>[];
    }
    const hooksReport = (
      head: string,
      cpu: number,
      patch: Partial<HooksReport> = {},
    ): HooksReport => ({
      generatedAt: "2026-10-26T00:00:00.000Z",
      comparable: true,
      provenance: {
        head,
        dirty: false,
        distSha256: "a".repeat(64),
        assetsSha256: "b".repeat(64),
        observer: realHead,
      },
      measurements: [
        {
          engine: "claude",
          scenario: "BashFailure",
          hook: "bash-outcome-watch.sh",
          audit: "root",
          wallMsMedian: cpu * 2,
          cpuMsMedian: cpu,
        },
      ],
      ...patch,
    });
    const summarize = hooksModule.summarizeObservations;

    // Covers: R3
    it("bench:hooks --summarize agrupa por head y calcula medianas por celda", () => {
      const result = summarize([
        ...[10, 30, 20].map((cpu, i) => ({
          name: `base-${i}`,
          report: hooksReport("a".repeat(40), cpu),
        })),
        ...[5, 7, 6].map((cpu, i) => ({
          name: `final-${i}`,
          report: hooksReport("b".repeat(40), cpu),
        })),
      ]);
      expect(result.errors).toEqual([]);
      expect(result.groups.map(({ head, reports }) => [head, reports])).toEqual([
        ["a".repeat(40), 3],
        ["b".repeat(40), 3],
      ]);
      expect(result.groups[0]!.cells).toEqual([
        {
          engine: "claude",
          scenario: "BashFailure",
          hook: "bash-outcome-watch.sh",
          audit: "root",
          samples: 3,
          wallMsMedian: 40,
          cpuMsMedian: 20,
        },
      ]);
      expect(result.groups[1]!.cells[0]).toMatchObject({ cpuMsMedian: 6 });
    });

    // Covers: R3
    it.each([
      ["non-comparable", hooksReport("a".repeat(40), 1, { comparable: false }), /not comparable/],
      [
        "missing provenance",
        hooksReport("a".repeat(40), 1, { provenance: undefined }),
        /no provenance/,
      ],
      [
        "dirty",
        hooksReport("a".repeat(40), 1, {
          provenance: {
            head: "a".repeat(40),
            dirty: true,
            distSha256: "a",
            assetsSha256: "b",
            observer: realHead,
          },
        }),
        /dirty/,
      ],
      [
        "without dist hash",
        hooksReport("a".repeat(40), 1, {
          provenance: {
            head: "a".repeat(40),
            dirty: false,
            distSha256: null,
            assetsSha256: "b",
            observer: realHead,
          },
        }),
        /dist\/assets hash/,
      ],
    ])("bench:hooks --summarize rechaza un reporte %s", (_id, report, message) => {
      const result = summarize([{ name: "bad.json", report }]);
      expect(result.errors.join("\n")).toMatch(message);
      expect(result.errors[0]).toContain("bad.json");
    });

    // Covers: R3
    it("bench:hooks --summarize rechaza observadores distintos y sale distinto de cero por CLI", () => {
      const mixed = summarize([
        { name: "one", report: hooksReport("a".repeat(40), 1) },
        {
          name: "two",
          report: hooksReport("a".repeat(40), 1, {
            provenance: {
              head: "a".repeat(40),
              dirty: false,
              distSha256: "a",
              assetsSha256: "b",
              observer: OTHER_HEAD,
            },
          }),
        },
      ]);
      expect(mixed.errors.join("\n")).toMatch(/different observers/);

      const dir = mkdtempSync(join(tmpdir(), "navori-summarize-"));
      try {
        const good = join(dir, "good.json");
        const bad = join(dir, "bad.json");
        writeFileSync(good, JSON.stringify(hooksReport("a".repeat(40), 1)));
        writeFileSync(bad, JSON.stringify(hooksReport("a".repeat(40), 1, { comparable: false })));
        const script = fileURLToPath(scriptUrl("bench-hooks.mjs"));
        const ok = spawnSync(process.execPath, [script, "--summarize", good], { encoding: "utf8" });
        expect(ok.status, ok.stderr).toBe(0);
        expect(ok.stdout).toContain("bash-outcome-watch.sh");
        const rejected = spawnSync(process.execPath, [script, "--summarize", good, bad], {
          encoding: "utf8",
        });
        expect(rejected.status).toBe(1);
        expect(rejected.stderr).toContain("bad.json: not comparable");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    describe("check-test-budget con evidencia", () => {
      const budget = JSON.stringify({ defaultMs: 20_000, exceptions: [] });
      const clean = (head: string): Provenance => ({
        head,
        dirty: false,
        distSha256: "a".repeat(64),
        assetsSha256: "b".repeat(64),
      });
      const run = (dir: string, args: string[]): SpawnSyncReturns<string> =>
        spawnSync("node", [BUDGET_SCRIPT, "--budget", join(dir, "budget.json"), ...args], {
          encoding: "utf8",
          env: { ...process.env, NAVORI_TEST_BUDGET_FACTOR: "" },
        });
      const withDir = (body: (dir: string) => void): void => {
        const dir = mkdtempSync(join(tmpdir(), "navori-budget-evidence-"));
        try {
          writeFileSync(join(dir, "budget.json"), budget);
          body(dir);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      };
      const write = (dir: string, name: string, report: object): string => {
        const path = join(dir, name);
        writeFileSync(path, JSON.stringify(report));
        return path;
      };

      // Covers: R3, R30
      it("--report rechaza corridas fallidas, sucias o de otro head y acepta la limpia del head actual", () => {
        withDir((dir) => {
          const [base] = budgetObservations(["src/a.test.ts"]);
          const ok = write(dir, "ok.json", { ...base, provenance: clean(realHead) });
          const accepted = run(dir, ["--report", ok]);
          expect(accepted.status, accepted.stderr).toBe(0);
          for (const [id, report, message] of [
            ["success-false", { ...base, success: false }, /success is not true/],
            ["vitest-exit", { ...base, vitestExit: 1 }, /vitestExit is 1/],
            ["dirty", { ...base, provenance: { ...clean(realHead), dirty: true } }, /dirty/],
            ["head", { ...base, provenance: clean(OTHER_HEAD) }, /not the current HEAD/],
          ] as const) {
            const rejected = run(dir, ["--report", write(dir, `${id}.json`, report)]);
            expect(rejected.status, id).toBe(1);
            expect(rejected.stderr, id).toMatch(message);
          }
        });
      });

      // Covers: R30
      it("--propose rechaza mezcla con/sin provenance, heads distintos y sucios; acepta tres limpias", () => {
        withDir((dir) => {
          const root = resolve(here, "..", "..");
          const inventory = globSync("src/**/*.test.ts", { cwd: root });
          const rows = budgetObservations(inventory);
          const paths = (provenance: (Provenance | undefined)[]): string[] =>
            rows.map((row, i) => write(dir, `p${i}.json`, { ...row, provenance: provenance[i] }));
          const good = clean(realHead);
          const accepted = run(dir, ["--propose", ...paths([good, good, good])]);
          expect(accepted.status, accepted.stderr).toBe(0);
          expect(run(dir, ["--propose", ...paths([undefined, undefined, undefined])]).status).toBe(
            0,
          );
          const mixed = run(dir, ["--propose", ...paths([good, good, undefined])]);
          expect(mixed.status).toBe(1);
          expect(mixed.stderr).toContain("mix with and without provenance");
          const heads = run(dir, ["--propose", ...paths([good, good, clean(OTHER_HEAD)])]);
          expect(heads.status).toBe(1);
          expect(heads.stderr).toContain("different heads");
          const dirty = run(dir, ["--propose", ...paths([good, good, { ...good, dirty: true }])]);
          expect(dirty.status).toBe(1);
          expect(dirty.stderr).toContain("dirty");
          const stale = run(dir, [
            "--propose",
            ...paths([clean(OTHER_HEAD), clean(OTHER_HEAD), clean(OTHER_HEAD)]),
          ]);
          expect(stale.status).toBe(1);
          expect(stale.stderr).toContain("not the current HEAD");
        });
      });
    });
  });
});
