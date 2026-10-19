import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, loadavg, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withoutRepoGitEnv } from "./git-env.mjs";

/**
 * Spec 0054 R27 / spec 0055 R3 — `bun run bench:hooks`.
 *
 * Measures every hook registered in `.claude/settings.json`, `.codex/config.toml` (Codex has
 * no `hooks.json`; its registrations are `[[hooks.<Event>]]` tables) and the Pi bridge table
 * (`hook-bindings.ts` rows installed under `.pi/navori/hooks/`), per audit scenario:
 *   absent  NAVORI_AUDITS_ROOT does not exist (no audit root at all);
 *   root    the audit root exists but holds no log for the session;
 *   active  the session log exists, with its spool dir (the hook writes one event).
 * Two separate passes, so counting never inflates timing:
 *   time   median of `--runs` (default 3) wall and CPU (bash `time`, whole process tree);
 *   count  one run with shims on PATH (`jq`, `node`, `perl`, `git`, `navori`, `date`, `sed`,
 *          `grep`, `tr`, `head`, `tail`, `basename`) that log every exec: `execs` per program.
 * `navori` on PATH is a symlink to the LOCAL `packages/cli/dist/index.js`, not the global one.
 * Exits 1 when a Bash call WITHOUT an active audit costs more than 300 ms of CPU in either
 * engine, unless `--report-only`.
 *
 * Hermetic: hooks run from a scratch copy of the hook trees in a scratch git repo, with scratch
 * HOME and NAVORI_AUDITS_ROOT. The repo is never written, except `.navori/state/bench/`.
 * A command invoked by absolute path escapes the shim count (D10).
 *
 * Usage: node scripts/js/bench-hooks.mjs [--report-only] [--runs N] [--scenario NAME ...]
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PAYLOADS = join(dirname(fileURLToPath(import.meta.url)), "bench-payloads");
export const BASH_BUDGET_MS = 300;

/** Tool name each scenario uses per engine, and the payload file it sends. */
export const SCENARIOS = {
  Bash: { payload: "bash.json", events: ["PreToolUse", "PostToolUse"], tools: { claude: "Bash", codex: "Bash", pi: "Bash" } },
  Edit: { payload: "edit.json", events: ["PreToolUse", "PostToolUse"], tools: { claude: "Edit", codex: "apply_patch", pi: "Edit" } },
  Agent: { payload: "agent.json", events: ["PreToolUse", "PostToolUse"], tools: { claude: "Agent", codex: "spawn_agent", pi: "Agent" } },
  SessionStart: { payload: "session-start.json", events: ["SessionStart"], source: "startup" },
  UserPromptSubmit: { payload: "user-prompt.json", events: ["UserPromptSubmit"] },
};

/** Additional hook observations; bench-context retains the original SCENARIOS population. */
export const SUPPLEMENTAL_SCENARIOS = {
  BashFailure: {
    events: ["PostToolUseFailure"],
    tools: { claude: "Bash", codex: "Bash", pi: "Bash" },
  },
  SessionEnd: { events: ["SessionEnd"] },
  Memory: {
    events: ["PreToolUse"],
    tools: { codex: "mcp__engram__mem_search" },
  },
};

/**
 * @typedef {"claude" | "codex" | "pi"} Engine
 * @typedef {"absent" | "root" | "active"} AuditScenario
 * @typedef {{ engine: Engine, event: string, matcher: string | null, command: string }} Registration
 * @typedef {Registration & { scenario: string, hook: string, audit: AuditScenario, wallMsMedian: number, cpuMsMedian: number, runsMs: number[], execs: Record<string, number> }} Measurement
 */

/**
 * Hook registrations of a Claude `settings.json` document.
 *
 * @param {{ hooks?: Record<string, Array<{ matcher?: string, hooks?: Array<{ command?: string }> }>> }} settings
 * @returns {Registration[]}
 */
export function parseClaudeRegistrations(settings) {
  /** @type {Registration[]} */
  const out = [];
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    for (const group of groups) {
      for (const hook of group.hooks ?? []) {
        if (typeof hook.command === "string") {
          out.push({ engine: "claude", event, matcher: group.matcher ?? null, command: hook.command });
        }
      }
    }
  }
  return out;
}

/**
 * Hook registrations of a Codex `config.toml`. Only the three shapes navori
 * writes are read: `[[hooks.<Event>]]` (+ `matcher = "…"`) and
 * `[[hooks.<Event>.hooks]]` (+ `command = "…"`), all basic strings.
 *
 * @param {string} toml
 * @returns {Registration[]}
 */
export function parseCodexRegistrations(toml) {
  /** @type {Registration[]} */
  const out = [];
  /** @type {{ event: string, matcher: string | null } | null} */
  let group = null;
  let inHook = false;
  const str = (raw) => {
    try {
      return JSON.parse(raw);
    } catch {
      return raw.slice(1, -1);
    }
  };
  for (const line of toml.split("\n")) {
    const table = /^\[\[hooks\.(\w+)(\.hooks)?\]\]\s*$/.exec(line);
    if (table) {
      inHook = table[2] !== undefined;
      if (!inHook) group = { event: table[1], matcher: null };
      continue;
    }
    if (/^\[/.test(line)) {
      group = null;
      inHook = false;
      continue;
    }
    const kv = /^(matcher|command)\s*=\s*("(?:[^"\\]|\\.)*")\s*$/.exec(line);
    if (!kv || !group) continue;
    if (kv[1] === "matcher" && !inHook) group.matcher = str(kv[2]);
    if (kv[1] === "command" && inHook) {
      out.push({ engine: "codex", event: group.event, matcher: group.matcher, command: str(kv[2]) });
    }
  }
  return out;
}

/**
 * Registrations that fire for a scenario in an engine.
 *
 * @param {Registration[]} registrations
 * @param {string} scenario key of {@link SCENARIOS}
 * @param {Engine} engine
 * @returns {Registration[]}
 */
export function selectHooks(registrations, scenario, engine) {
  const spec = SCENARIOS[scenario] ?? SUPPLEMENTAL_SCENARIOS[scenario];
  const subject = spec.tools ? spec.tools[engine] : (spec.source ?? "");
  return registrations.filter((reg) => {
    if (reg.engine !== engine || !spec.events.includes(reg.event)) return false;
    if (reg.matcher === null || reg.matcher === "") return true;
    // Claude matchers are exact-name alternations; Codex ones are real regexes.
    const pattern = engine === "claude" ? `^(?:${reg.matcher})$` : reg.matcher;
    // Matchers are regexes by contract, read from the repo's own hook registrations (trusted, not user input).
    return new RegExp(pattern).test(subject); // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  });
}

/**
 * @param {number[]} values
 * @returns {number}
 */
export function median(values) {
  if (values.length === 0) throw new Error("median of an empty list");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Sums hook medians per engine and scenario.
 *
 * @param {Array<Pick<Measurement, "engine" | "scenario" | "medianMs">>} measurements
 * @returns {Record<string, Record<string, { totalMs: number, hooks: number }>>}
 */
export function sumByEvent(measurements) {
  /** @type {Record<string, Record<string, { totalMs: number, hooks: number }>>} */
  const sums = {};
  for (const m of measurements) {
    const slot = ((sums[m.engine] ??= {})[m.scenario] ??= { totalMs: 0, hooks: 0 });
    slot.totalMs = Math.round((slot.totalMs + m.medianMs) * 1000) / 1000;
    slot.hooks += 1;
  }
  return sums;
}

/**
 * R27 budget: a Bash call without audit must stay at or under {@link BASH_BUDGET_MS}.
 *
 * @param {ReturnType<typeof sumByEvent>} sums
 * @param {number} [budgetMs]
 * @returns {{ ok: boolean, violations: string[] }}
 */
export function evaluateBudget(sums, budgetMs = BASH_BUDGET_MS) {
  const violations = [];
  for (const [engine, scenarios] of Object.entries(sums)) {
    const bash = scenarios.Bash;
    if (bash && bash.totalMs > budgetMs) {
      violations.push(`${engine} Bash: ${bash.totalMs.toFixed(0)} ms > ${budgetMs} ms (${bash.hooks} hooks)`);
    }
  }
  return { ok: violations.length === 0, violations };
}

const PI_EVENTS = {
  tool_call: "PreToolUse",
  tool_result: "PostToolUse",
  session_shutdown: "SessionEnd",
};
const PI_TOOL_NAMES = { bash: "Bash", edit: "Edit", write: "Write" };

/**
 * Pi registrations from the text of `hook-bindings.ts` (`script`, `on`, optional `tools` per
 * row). Pi has no settings file: the bridge table is its registration. Session shutdown uses
 * the bridge's SessionEnd payload; agent_before_settle has no installed script in this checkout.
 * Read as text because the module pulls the whole config graph.
 *
 * @param {string} source
 * @param {(script: string) => boolean} [exists] keeps rows whose installed script exists
 * @returns {Registration[]}
 */
export function parsePiRegistrations(source, exists = () => true) {
  /** @type {Registration[]} */
  const out = [];
  const row =
    /script:\s*"([\w-]+)",\s*on:\s*"(\w+)",\s*(?:tools:\s*\[([^\]]*)\],)?/g;
  for (const [, script, on, tools] of source.matchAll(row)) {
    const event = PI_EVENTS[on];
    if (event === undefined || !exists(script)) continue;
    const names = [...(tools ?? "").matchAll(/"(\w+)"/g)].map(
      (m) => PI_TOOL_NAMES[m[1]] ?? m[1],
    );
    out.push({
      engine: "pi",
      event,
      matcher: names.length > 0 ? names.join("|") : null,
      command: `bash ".pi/navori/hooks/${script}.sh"`,
    });
  }
  return out;
}

/** Programs whose execs are counted (spec 0055 D10). */
export const SHIMMED_PROGRAMS = ["jq", "node", "perl", "git", "navori", "date", "sed", "grep", "tr", "head", "tail", "basename"];

/**
 * Counts the lines of an exec log per program.
 *
 * @param {string} log one program name per line
 * @returns {Record<string, number>}
 */
export function countExecs(log) {
  /** @type {Record<string, number>} */
  const counts = Object.fromEntries(SHIMMED_PROGRAMS.map((name) => [name, 0]));
  for (const name of log.split("\n")) if (name in counts) counts[name] += 1;
  return counts;
}

/** `command -v` through the original PATH; `null` when the program does not exist. */
function resolveProgram(name, path) {
  const run = spawnSync("sh", ["-c", `command -v ${name}`], { env: { PATH: path }, encoding: "utf8" });
  const found = (run.stdout ?? "").trim();
  return run.status === 0 && found.startsWith("/") ? found : null;
}

/**
 * Scratch repo the hooks run in, with the shims and the local `navori` on a PATH of its own.
 * Reused by `bench-context.mjs`.
 *
 * @returns {{ root: string, project: string, binDir: string, shimDir: string, execLog: string,
 *   baseEnv: NodeJS.ProcessEnv, env: (audit: AuditScenario, counting?: boolean) => NodeJS.ProcessEnv,
 *   cleanup: () => void }}
 */
export function createSandbox() {
  // realpath: macOS tmpdir sits behind the /var symlink, which `navori gate --cwd` refuses.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "navori-bench-hooks-")));
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  for (const tree of [".claude/hooks", ".codex/hooks", ".pi/navori"]) {
    if (existsSync(join(REPO_ROOT, tree))) cpSync(join(REPO_ROOT, tree), join(project, tree), { recursive: true });
  }
  if (existsSync(join(REPO_ROOT, "navori.config.json"))) {
    copyFileSync(join(REPO_ROOT, "navori.config.json"), join(project, "navori.config.json"));
  }
  const originalPath = process.env.PATH ?? "";
  const binDir = join(root, "bin");
  mkdirSync(binDir);
  const localDist = join(REPO_ROOT, "packages", "cli", "dist", "index.js");
  if (existsSync(localDist)) symlinkSync(localDist, join(binDir, "navori"));
  const shimDir = join(root, "shims");
  mkdirSync(shimDir);
  const execLog = join(root, "exec.log");
  for (const name of SHIMMED_PROGRAMS) {
    const real = name === "navori" ? join(binDir, "navori") : resolveProgram(name, originalPath);
    if (real === null || (name === "navori" && !existsSync(real))) continue;
    const shim = join(shimDir, name);
    writeFileSync(shim, `#!/bin/sh\necho ${name} >> "$BENCH_EXEC_LOG"\nexec "${real}" "$@"\n`);
    chmodSync(shim, 0o755);
  }
  const baseEnv = {
    ...withoutRepoGitEnv(process.env),
    HOME: join(root, "home"),
    CLAUDE_PROJECT_DIR: project,
    BENCH_EXEC_LOG: execLog,
  };
  mkdirSync(baseEnv.HOME, { recursive: true });
  const init = spawnSync("git", ["init", "-q"], { cwd: project, env: baseEnv });
  if (init.status !== 0) throw new Error("git init failed in the sandbox");
  const auditsRoot = join(root, "audits");
  return {
    root,
    project,
    binDir,
    shimDir,
    execLog,
    baseEnv,
    /**
     * Environment for one audit scenario; creates the audit state it needs.
     *
     * @param {AuditScenario} audit
     * @param {boolean} [counting] put the exec-logging shims first on PATH
     */
    env(audit, counting = false) {
      rmSync(auditsRoot, { recursive: true, force: true });
      if (audit !== "absent") mkdirSync(auditsRoot, { recursive: true });
      if (audit === "active") {
        // `bench-session` is the session_id of every payload; the repo is the project dir name.
        mkdirSync(join(auditsRoot, "project", "spool-bench-session"), { recursive: true, mode: 0o700 });
        writeFileSync(join(auditsRoot, "project", "session-bench-session.log"), "");
      }
      const path = [counting ? shimDir : null, binDir, originalPath].filter(Boolean).join(":");
      return { ...baseEnv, NAVORI_AUDITS_ROOT: auditsRoot, PATH: path };
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * Wall and CPU time (ms) of one hook run, read from bash's `time` keyword (`%R %U %S`).
 * The hook runs in a child bash so its whole process tree is accounted for.
 *
 * @param {string} command registered hook command
 * @param {string} payloadPath
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ wallMs: number, cpuMs: number, exitCode: number | null }}
 */
function timeOnce(command, payloadPath, cwd, env) {
  const run = spawnSync(
    "bash",
    [
      "-c",
      'TIMEFORMAT="%3R %3U %3S"; time bash -c "$BENCH_CMD" <"$BENCH_PAYLOAD" >/dev/null 2>/dev/null',
    ],
    {
      cwd,
      env: { ...env, BENCH_CMD: command, BENCH_PAYLOAD: payloadPath },
      encoding: "utf8",
    },
  );
  const match = /(\d+\.\d+) (\d+\.\d+) (\d+\.\d+)\s*$/.exec(run.stderr ?? "");
  if (!match)
    throw new Error(`cannot read time output for: ${command}\n${run.stderr}`);
  return {
    wallMs: Math.round(Number(match[1]) * 1000),
    cpuMs: Math.round((Number(match[2]) + Number(match[3])) * 1000),
    exitCode: run.status,
  };
}

/**
 * One run with the exec-logging shims; returns the program counts.
 *
 * @param {string} command
 * @param {string} payloadPath
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} env env of `sandbox.env(audit, true)`
 * @param {boolean} [capture] retain supplemental output and exit status without changing timing
 * @returns {{ execs: Record<string, number>, exitCode: number | null, stdout: string, stderr: string }}
 */
function countOnce(command, payloadPath, cwd, env, capture = false) {
  const log = env.BENCH_EXEC_LOG;
  writeFileSync(log, "");
  const run = spawnSync(
    "bash",
    [
      "-c",
      'bash -c "$BENCH_CMD" <"$BENCH_PAYLOAD"' +
        (capture ? "" : " >/dev/null 2>/dev/null"),
    ],
    {
      cwd,
      env: { ...env, BENCH_CMD: command, BENCH_PAYLOAD: payloadPath },
      encoding: "utf8",
    },
  );
  return {
    execs: countExecs(readFileSync(log, "utf8")),
    exitCode: run.status,
    stdout: run.stdout,
    stderr: run.stderr,
  };
}

/**
 * Restore only supplemental state before each timed/count invocation, outside the timer.
 * Fixture session headers describe private benchmark logs, never native producer identities.
 *
 * @param {ReturnType<typeof createSandbox>} sandbox
 * @param {string} scenario
 * @param {Registration} reg
 * @param {AuditScenario} audit
 * @param {boolean} [counting]
 * @returns {NodeJS.ProcessEnv}
 */
export function scenarioEnvironment(
  sandbox,
  scenario,
  reg,
  audit,
  counting = false,
) {
  const env = sandbox.env(audit, counting);
  if (scenario === "BashFailure") {
    env.CLAUDE_CODE_SESSION_ID = "bench-session";
    rmSync(
      join(
        sandbox.project,
        ".navori/state/hooks/bash-outcome-watch/bench-session",
      ),
      { force: true },
    );
  }
  if (scenario === "SessionEnd" && audit === "active") {
    const repo = join(env.NAVORI_AUDITS_ROOT, "project");
    chmodSync(env.NAVORI_AUDITS_ROOT, 0o700);
    chmodSync(repo, 0o700);
    const log = join(repo, "session-bench-session.log");
    writeFileSync(
      log,
      JSON.stringify({
        event: "start",
        sessionId: "bench-session",
        host: reg.engine,
        repo: "project",
        cwd: sandbox.project,
      }) + "\n",
    );
    chmodSync(log, 0o600);
  }
  return env;
}

/**
 * Comparability of a hook bench: the machine must have been mostly idle at the start. The
 * hook bench is single-process, so the bar is half the CPUs instead of a worker count.
 *
 * @param {number[]} loadavgBefore
 * @param {number} cpus
 * @returns {boolean}
 */
export function isComparable(loadavgBefore, cpus) {
  return (loadavgBefore[0] ?? Number.POSITIVE_INFINITY) <= cpus / 2;
}

/** Registrations of the three engines, read from the checkout. */
export function readRegistrations() {
  const piBindings = join(REPO_ROOT, "packages", "cli", "src", "engines", "pi", "hook-bindings.ts");
  return [
    ...parseClaudeRegistrations(JSON.parse(readFileSync(join(REPO_ROOT, ".claude", "settings.json"), "utf8"))),
    ...parseCodexRegistrations(readFileSync(join(REPO_ROOT, ".codex", "config.toml"), "utf8")),
    ...parsePiRegistrations(readFileSync(piBindings, "utf8"), (script) =>
      existsSync(join(REPO_ROOT, ".pi", "navori", "hooks", `${script}.sh`)),
    ),
  ];
}

/**
 * Writes the payload a registration receives in a scenario and returns its path.
 *
 * @param {{ root: string, project: string }} sandbox
 * @param {string} scenario
 * @param {Registration} reg
 * @returns {string}
 */
export function writePayload(sandbox, scenario, reg) {
  const spec = SCENARIOS[scenario];
  const payloadPath = join(
    sandbox.root,
    `${reg.engine}-${scenario}-${reg.event}.json`,
  );
  const supplemental = {
    BashFailure: {
      session_id: "bench-session",
      cwd: sandbox.project,
      hook_event_name: reg.event,
      tool_name: "Bash",
      tool_input: { command: "false" },
      tool_use_id: "toolu_bench_failure",
      error: "Exit code 1\nbenchmark command failed",
      is_interrupt: false,
    },
    SessionEnd: {
      session_id: "bench-session",
      cwd: sandbox.project,
      hook_event_name: reg.event,
      reason: "prompt_input_exit",
      permission_mode: "dontAsk",
    },
    Memory: {
      session_id: "bench-session",
      cwd: sandbox.project,
      hook_event_name: reg.event,
      tool_name: "mcp__engram__mem_search",
      tool_input: { query: "benchmark fixture", response_format: "compact" },
    },
  }[scenario];
  if (supplemental) {
    writeFileSync(payloadPath, JSON.stringify(supplemental) + "\n");
    return payloadPath;
  }
  writeFileSync(
    payloadPath,
    readFileSync(join(PAYLOADS, spec.payload), "utf8")
      .replaceAll("__CWD__", sandbox.project)
      .replaceAll("__EVENT__", reg.event)
      .replaceAll("__TOOL__", spec.tools?.[reg.engine] ?? ""),
  );
  return payloadPath;
}

/**
 * @param {string[]} argv
 * @returns {number}
 */
function main(argv) {
  const reportOnly = argv.includes("--report-only");
  const runsAt = argv.indexOf("--runs");
  const runs = runsAt === -1 ? 3 : Number(argv[runsAt + 1]);
  if (!Number.isInteger(runs) || runs < 1) {
    process.stderr.write("bench:hooks: --runs needs a positive integer\n");
    return 2;
  }
  const allScenarios = { ...SCENARIOS, ...SUPPLEMENTAL_SCENARIOS };
  const requested = argv.flatMap((arg, index) =>
    arg === "--scenario" ? [argv[index + 1]] : [],
  );
  if (requested.some((scenario) => !Object.hasOwn(allScenarios, scenario))) {
    process.stderr.write(
      "bench:hooks: --scenario needs a known scenario name\n",
    );
    return 2;
  }
  const scenarios =
    requested.length > 0 ? [...new Set(requested)] : Object.keys(allScenarios);
  const registrations = readRegistrations();
  const sandbox = createSandbox();
  const loadBefore = loadavg();
  /** @type {Measurement[]} */
  const measurements = [];
  try {
    for (const scenario of scenarios) {
      for (const engine of /** @type {Engine[]} */ ([
        "claude",
        "codex",
        "pi",
      ])) {
        for (const reg of selectHooks(registrations, scenario, engine)) {
          const payloadPath = writePayload(sandbox, scenario, reg);
          const hook = /([\w-]+\.sh)/.exec(reg.command)?.[1] ?? reg.command;
          for (const audit of /** @type {AuditScenario[]} */ ([
            "absent",
            "root",
            "active",
          ])) {
            const timed = Array.from({ length: runs }, () =>
              timeOnce(
                reg.command,
                payloadPath,
                sandbox.project,
                scenarioEnvironment(sandbox, scenario, reg, audit),
              ),
            );
            const supplemental = Object.hasOwn(
              SUPPLEMENTAL_SCENARIOS,
              scenario,
            );
            const counted = countOnce(
              reg.command,
              payloadPath,
              sandbox.project,
              scenarioEnvironment(sandbox, scenario, reg, audit, true),
              supplemental,
            );
            measurements.push({
              ...reg,
              scenario,
              hook,
              audit,
              wallMsMedian: median(timed.map((t) => t.wallMs)),
              cpuMsMedian: median(timed.map((t) => t.cpuMs)),
              runsMs: timed.map((t) => t.wallMs),
              execs: counted.execs,
              ...(supplemental
                ? {
                    outcome: {
                      exitCodes: timed.map((time) => time.exitCode),
                      countedExitCode: counted.exitCode,
                      stdout: counted.stdout,
                      stderr: counted.stderr,
                    },
                  }
                : {}),
            });
          }
        }
      }
    }
  } finally {
    sandbox.cleanup();
  }
  // The R27 budget keeps its meaning: a Bash call with the audit root present but no active log.
  const sums = sumByEvent(
    measurements
      .filter((m) => m.audit === "root")
      .map((m) => ({
        engine: m.engine,
        scenario: m.scenario,
        medianMs: m.cpuMsMedian,
      })),
  );
  const verdict = evaluateBudget(sums);
  const cpus = availableParallelism();
  const result = {
    generatedAt: new Date().toISOString(),
    cpus,
    loadavgBefore: loadBefore,
    loadavgAfter: loadavg(),
    workers: 1,
    comparable: isComparable(loadBefore, cpus),
    runs,
    scenarios,
    budgetMs: BASH_BUDGET_MS,
    sums,
    measurements,
  };
  const dir = join(REPO_ROOT, ".navori", "state", "bench");
  mkdirSync(dir, { recursive: true });
  const stamped = join(
    dir,
    `hooks-${result.generatedAt.replace(/[:.]/g, "-")}.json`,
  );
  writeFileSync(stamped, `${JSON.stringify(result, null, 2)}\n`);
  copyFileSync(stamped, join(dir, "hooks-latest.json"));
  for (const [engine, scenarios] of Object.entries(sums)) {
    for (const [scenario, s] of Object.entries(scenarios)) {
      process.stdout.write(
        `bench:hooks ${engine} ${scenario}: ${s.totalMs.toFixed(0)} ms cpu (${s.hooks} hooks)\n`,
      );
    }
  }
  process.stdout.write(
    `bench:hooks measurements=${measurements.length} comparable=${result.comparable} ` +
      `load=${loadBefore.map((n) => n.toFixed(2)).join("/")} cpus=${cpus}\n`,
  );
  if (!result.comparable)
    process.stderr.write(
      "bench:hooks NOT comparable: the machine was not idle at the start\n",
    );
  if (!verdict.ok) {
    process.stderr.write(
      `bench:hooks over budget:\n${verdict.violations.map((v) => `  - ${v}`).join("\n")}\n`,
    );
    return reportOnly ? 0 : 1;
  }
  return 0;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exit(main(process.argv.slice(2)));
}
