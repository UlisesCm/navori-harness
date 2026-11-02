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
import { readProvenance } from "./bench-provenance.mjs";
import { withoutRepoGitEnv } from "./git-env.mjs";
import { prepareRustReplay, runRustHook } from "./rust-hook-adapter.mjs";

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
 * Rust mode times the binary directly (wall median/p95, never the shell CPU budget).
 * NAVORI_RUST_BIN selects the binary; NAVORI_RUST_HOOKS_DIR supplies renderer-prepared scripts.
 * Without it the binary runs the signed source assets, as the verdict replay does.
 * Shell rows carry `wallMsP95` too, over the same payloads, so both p95 can be compared (R55).
 * Unavailable/deferred native execution always fails, including with --report-only.
 * Rust currently supports only --audit absent (default); root/active require CLI-writer fixtures.
 *
 * Reports carry `provenance` ({@link readProvenance} of the measured checkout: head, dirty, dist and
 * assets hashes) plus `provenance.observer`, the head of the checkout running this script.
 * `--root <checkout>` measures another checkout (e.g. a base worktree): its hook trees,
 * registrations, `navori.config.json` and `packages/cli/dist` are read from there while the
 * scenarios, payloads and output stay with the observer. It fails closed (exit 2) when the
 * target `dist` is missing, because the hooks would otherwise resolve some other `navori`.
 * `--root` is shell-only: the native bench reads `crates/ported.json` from this checkout.
 * `--summarize <report.json ...>` groups comparable, provenance-bearing reports by head and
 * prints per-cell medians; it exits 1 when any report is not admissible.
 *
 * `--hook <id>.sh` (repeatable) keeps only those registrations; a name no selected scenario
 * registers is an error, never an empty pass.
 *
 * Usage: node scripts/js/bench-hooks.mjs [--impl shell|rust] [--report-only] [--runs N]
 *          [--scenario NAME ...] [--hook NAME.sh ...] [--root DIR]
 *        node scripts/js/bench-hooks.mjs --summarize <report.json> ...
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PAYLOADS = join(dirname(fileURLToPath(import.meta.url)), "bench-payloads");
export const BASH_BUDGET_MS = 300;
/** R17 budget for direct native invocation, measured as wall p95 in milliseconds. */
export const RUST_P95_BUDGET_MS = 5;

/** Tool name each scenario uses per engine, and the payload file it sends. */
export const SCENARIOS = {
  Bash: {
    payload: "bash.json",
    events: ["PreToolUse", "PostToolUse"],
    tools: { claude: "Bash", codex: "Bash", pi: "Bash" },
  },
  Edit: {
    payload: "edit.json",
    events: ["PreToolUse", "PostToolUse"],
    tools: { claude: "Edit", codex: "apply_patch", pi: "Edit" },
  },
  Agent: {
    payload: "agent.json",
    events: ["PreToolUse", "PostToolUse"],
    tools: { claude: "Agent", codex: "spawn_agent", pi: "Agent" },
  },
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
          out.push({
            engine: "claude",
            event,
            matcher: group.matcher ?? null,
            command: hook.command,
          });
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
      out.push({
        engine: "codex",
        event: group.event,
        matcher: group.matcher,
        command: str(kv[2]),
      });
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
 * Registrations narrowed to the `--hook` names. Each requested name must fire in at least one
 * selected scenario and engine, so a typo or an unregistered hook fails instead of measuring nothing.
 *
 * @param {Registration[]} registrations
 * @param {string[]} scenarios
 * @param {string[] | undefined} hooks `<id>.sh` names; undefined keeps every registration
 * @returns {Registration[]}
 */
export function filterHooks(registrations, scenarios, hooks) {
  if (hooks === undefined) return registrations;
  const kept = registrations.filter((reg) => hooks.includes(hookName(reg)));
  const fired = new Set(
    scenarios.flatMap((scenario) =>
      /** @type {Engine[]} */ (["claude", "codex", "pi"]).flatMap((engine) =>
        selectHooks(kept, scenario, engine).map(hookName),
      ),
    ),
  );
  const missing = hooks.filter((hook) => !fired.has(hook));
  if (missing.length > 0) {
    throw new Error(`--hook not registered in the selected scenarios: ${missing.join(", ")}`);
  }
  return kept;
}

/** The `<id>.sh` a registered command runs.
 * @param {Registration} reg
 * @returns {string}
 */
function hookName(reg) {
  return /([\w-]+\.sh)/.exec(reg.command)?.[1] ?? reg.command;
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
      violations.push(
        `${engine} Bash: ${bash.totalMs.toFixed(0)} ms > ${budgetMs} ms (${bash.hooks} hooks)`,
      );
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
  const row = /script:\s*"([\w-]+)",\s*on:\s*"(\w+)",\s*(?:tools:\s*\[([^\]]*)\],)?/g;
  for (const [, script, on, tools] of source.matchAll(row)) {
    const event = PI_EVENTS[on];
    if (event === undefined || !exists(script)) continue;
    const names = [...(tools ?? "").matchAll(/"(\w+)"/g)].map((m) => PI_TOOL_NAMES[m[1]] ?? m[1]);
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
export const SHIMMED_PROGRAMS = [
  "jq",
  "node",
  "perl",
  "git",
  "navori",
  "date",
  "sed",
  "grep",
  "tr",
  "head",
  "tail",
  "basename",
];

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
  const run = spawnSync("sh", ["-c", `command -v ${name}`], {
    env: { PATH: path },
    encoding: "utf8",
  });
  const found = (run.stdout ?? "").trim();
  return run.status === 0 && found.startsWith("/") ? found : null;
}

/**
 * Scratch repo the hooks run in, with the shims and the local `navori` on a PATH of its own.
 * Reused by `bench-context.mjs`.
 *
 * @param {string} [sourceRoot] checkout whose hook trees, config and `dist` are copied/linked
 * @param {{ requireDist?: boolean }} [options] throw when `sourceRoot` has no built `navori`
 * @returns {{ root: string, project: string, binDir: string, shimDir: string, execLog: string,
 *   baseEnv: NodeJS.ProcessEnv, env: (audit: AuditScenario, counting?: boolean) => NodeJS.ProcessEnv,
 *   cleanup: () => void }}
 */
export function createSandbox(sourceRoot = REPO_ROOT, { requireDist = false } = {}) {
  const localDist = join(sourceRoot, "packages", "cli", "dist", "index.js");
  if (requireDist && !existsSync(localDist)) {
    throw new Error(`${localDist} is missing: build it first (hooks would resolve another navori)`);
  }
  // realpath: macOS tmpdir sits behind the /var symlink, which `navori gate --cwd` refuses.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "navori-bench-hooks-")));
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  for (const tree of [".claude/hooks", ".codex/hooks", ".pi/navori"]) {
    if (existsSync(join(sourceRoot, tree)))
      cpSync(join(sourceRoot, tree), join(project, tree), { recursive: true });
  }
  if (existsSync(join(sourceRoot, "navori.config.json"))) {
    copyFileSync(join(sourceRoot, "navori.config.json"), join(project, "navori.config.json"));
  }
  const originalPath = process.env.PATH ?? "";
  const binDir = join(root, "bin");
  mkdirSync(binDir);
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
        mkdirSync(join(auditsRoot, "project", "spool-bench-session"), {
          recursive: true,
          mode: 0o700,
        });
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
  if (!match) throw new Error(`cannot read time output for: ${command}\n${run.stderr}`);
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
    ["-c", 'bash -c "$BENCH_CMD" <"$BENCH_PAYLOAD"' + (capture ? "" : " >/dev/null 2>/dev/null")],
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
export function scenarioEnvironment(sandbox, scenario, reg, audit, counting = false) {
  const env = sandbox.env(audit, counting);
  if (scenario === "BashFailure") {
    env.CLAUDE_CODE_SESSION_ID = "bench-session";
    rmSync(join(sandbox.project, ".navori/state/hooks/bash-outcome-watch/bench-session"), {
      force: true,
    });
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
 * Comparability of a hook bench: cap initial load at four (spec 0055 / #1354),
 * retaining the stricter half-CPU limit on smaller machines. Invalid metadata fails closed.
 *
 * @param {number[]} loadavgBefore
 * @param {number} cpus
 * @returns {boolean}
 */
export function isComparable(loadavgBefore, cpus) {
  const initialLoad = loadavgBefore[0];
  return (
    Number.isFinite(initialLoad) &&
    initialLoad >= 0 &&
    Number.isFinite(cpus) &&
    cpus > 0 &&
    initialLoad <= Math.min(4, cpus / 2)
  );
}

/**
 * Registrations of the three engines, read from a checkout.
 *
 * @param {string} [sourceRoot] checkout to read; defaults to this one
 * @returns {Registration[]}
 */
export function readRegistrations(sourceRoot = REPO_ROOT) {
  const piBindings = join(sourceRoot, "packages", "cli", "src", "engines", "pi", "hook-bindings.ts");
  return [
    ...parseClaudeRegistrations(
      JSON.parse(readFileSync(join(sourceRoot, ".claude", "settings.json"), "utf8")),
    ),
    ...parseCodexRegistrations(readFileSync(join(sourceRoot, ".codex", "config.toml"), "utf8")),
    ...parsePiRegistrations(readFileSync(piBindings, "utf8"), (script) =>
      existsSync(join(sourceRoot, ".pi", "navori", "hooks", `${script}.sh`)),
    ),
  ];
}

/**
 * Admissibility and per-cell medians of a set of hook reports. A report is admissible when it
 * is `comparable`, carries `provenance` of a clean checkout (head, dist and assets hashes) and
 * an `observer`; all reports must share one observer. Cells are grouped by the measured head.
 *
 * @param {Array<{ name: string, report: unknown }>} reports parsed reports with a label for messages
 * @returns {{ errors: string[], groups: Array<{ head: string, reports: number, cells: Array<{ engine: string, scenario: string, hook: string, audit: string, samples: number, wallMsMedian: number, cpuMsMedian: number }> }> }}
 */
export function summarizeObservations(reports) {
  /** @type {string[]} */
  const errors = [];
  /** @type {Map<string, Map<string, { engine: string, scenario: string, hook: string, audit: string, wall: number[], cpu: number[] }>>} */
  const byHead = new Map();
  /** @type {Map<string, number>} */
  const counts = new Map();
  const observers = new Set();
  for (const { name, report } of reports) {
    const p = report?.provenance;
    const problems = [];
    if (report?.comparable !== true) problems.push("not comparable");
    if (!Array.isArray(report?.measurements) || report.measurements.length === 0) problems.push("no measurements");
    if (typeof p !== "object" || p === null) problems.push("no provenance");
    else {
      if (typeof p.head !== "string") problems.push("provenance without head");
      if (p.dirty !== false) problems.push("provenance dirty or unknown");
      if (typeof p.distSha256 !== "string" || typeof p.assetsSha256 !== "string")
        problems.push("provenance without dist/assets hash");
      if (typeof p.observer !== "string") problems.push("provenance without observer");
    }
    if (problems.length > 0) {
      errors.push(`${name}: ${problems.join(", ")}`);
      continue;
    }
    observers.add(p.observer);
    counts.set(p.head, (counts.get(p.head) ?? 0) + 1);
    const cells = byHead.get(p.head) ?? new Map();
    byHead.set(p.head, cells);
    for (const m of report.measurements) {
      const key = [m.engine, m.scenario, m.hook, m.audit].join("\0");
      const cell = cells.get(key) ?? { engine: m.engine, scenario: m.scenario, hook: m.hook, audit: m.audit, wall: [], cpu: [] };
      cell.wall.push(m.wallMsMedian);
      cell.cpu.push(m.cpuMsMedian);
      cells.set(key, cell);
    }
  }
  if (observers.size > 1) errors.push(`reports come from different observers: ${[...observers].join(", ")}`);
  const groups = [...byHead].map(([head, cells]) => ({
    head,
    reports: counts.get(head) ?? 0,
    cells: [...cells.values()]
      .sort((a, b) => `${a.scenario}${a.hook}${a.engine}${a.audit}`.localeCompare(`${b.scenario}${b.hook}${b.engine}${b.audit}`))
      .map(({ wall, cpu, ...rest }) => ({ ...rest, samples: wall.length, wallMsMedian: median(wall), cpuMsMedian: median(cpu) })),
  }));
  return { errors, groups };
}

/**
 * `--summarize`: prints medians per head/hook/engine/scenario/audit.
 *
 * @param {string[]} paths
 * @returns {number} exit code
 */
function summarize(paths) {
  if (paths.length === 0) {
    process.stderr.write("bench:hooks: --summarize needs report paths\n");
    return 2;
  }
  const reports = [];
  const errors = [];
  for (const path of paths) {
    try {
      reports.push({ name: path, report: JSON.parse(readFileSync(resolve(path), "utf8")) });
    } catch (error) {
      errors.push(`${path}: cannot read (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  const summary = summarizeObservations(reports);
  for (const group of summary.groups) {
    process.stdout.write(`head ${group.head} (${group.reports} reports)\n`);
    for (const c of group.cells) {
      process.stdout.write(
        `  ${c.scenario} ${c.engine} ${c.hook} ${c.audit}: wall=${c.wallMsMedian} ms cpu=${c.cpuMsMedian} ms n=${c.samples}\n`,
      );
    }
  }
  const all = [...errors, ...summary.errors];
  if (all.length > 0) {
    process.stderr.write(`bench:hooks --summarize rejected:\n${all.map((e) => `  - ${e}`).join("\n")}\n`);
    return 1;
  }
  return 0;
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
  const payloadPath = join(sandbox.root, `${reg.engine}-${scenario}-${reg.event}.json`);
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

/** Parse the implementation selector without silently falling back to shell.
 * @param {string[]} argv
 * @returns {{ impl: "shell" | "rust", reportOnly: boolean, runs: number, scenarios: string[], hooks?: string[], audit?: AuditScenario, root?: string }}
 */
export function parseBenchArgs(argv) {
  /** @type {"shell" | "rust"} */
  let impl = "shell";
  let selectedImpl = false;
  let reportOnly = false;
  let audit;
  let runs;
  let root;
  const requested = [];
  const hooks = [];
  const allScenarios = { ...SCENARIOS, ...SUPPLEMENTAL_SCENARIOS };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--impl") {
      const value = argv[++index];
      if (selectedImpl || (value !== "shell" && value !== "rust")) {
        throw new Error("--impl needs shell or rust exactly once");
      }
      impl = value;
      selectedImpl = true;
    } else if (arg === "--report-only") {
      reportOnly = true;
    } else if (arg === "--audit") {
      const value = argv[++index];
      if (audit !== undefined || !["absent", "root", "active"].includes(value)) {
        throw new Error("--audit needs absent, root or active exactly once");
      }
      audit = value;
    } else if (arg === "--runs") {
      const value = argv[++index];
      if (!/^[1-9]\d*$/.test(value ?? "") || !Number.isSafeInteger(Number(value))) {
        throw new Error("--runs needs a positive integer");
      }
      runs = Number(value);
    } else if (arg === "--scenario") {
      const value = argv[++index];
      if (!Object.hasOwn(allScenarios, value ?? "")) {
        throw new Error("--scenario needs a known scenario name");
      }
      requested.push(value);
    } else if (arg === "--hook") {
      const value = argv[++index];
      if (!/^[\w-]+\.sh$/.test(value ?? "")) throw new Error("--hook needs a hook file name");
      hooks.push(value);
    } else if (arg === "--root") {
      const value = argv[++index];
      if (root !== undefined || value === undefined || value === "" || value.startsWith("--")) {
        throw new Error("--root needs a checkout path exactly once");
      }
      root = resolve(value);
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  if (audit !== undefined && impl !== "rust") throw new Error("--audit requires --impl rust");
  if (root !== undefined && impl === "rust") throw new Error("--root requires --impl shell");
  return {
    impl,
    reportOnly,
    audit,
    root,
    runs: runs ?? (impl === "rust" ? 40 : 3),
    scenarios: requested.length > 0 ? [...new Set(requested)] : Object.keys(allScenarios),
    ...(hooks.length > 0 ? { hooks: [...new Set(hooks)] } : {}),
  };
}

/**
 * Whether a registered command runs `<directory>/<hook>` with no hook-specific arguments, in one
 * of the shapes navori renders: the plain `bash "<dir>/<hook>"`, Claude's parse guard
 * (`exec bash "$f";`) or Claude's native wrapper (`hook --via-command '<Event>' "$f" [--shadow];`).
 * Anything else could carry argv the native timing would not reproduce, so it is rejected.
 *
 * @param {string} command
 * @param {string} directory
 * @param {string} hook
 * @returns {boolean}
 */
export function argumentFreeInvocation(command, directory, hook) {
  if (command === `bash "${directory}/${hook}"`) return true;
  // Codex resolves the hook from the repo top level.
  if (command === `bash "$(git rev-parse --show-toplevel)/${directory}/${hook}"`) return true;
  const prefix = `f="$CLAUDE_PROJECT_DIR/${directory}/${hook}"; `;
  if (!command.startsWith(prefix)) return false;
  const uses = command.split('"$f"').length - 1;
  const guard = /bash -n "\$f" 2>\/dev\/null && exec bash "\$f"; /.test(command);
  const wrapper = /hook --via-command '[A-Za-z]+' "\$f"(?: --shadow)?; then /.test(command);
  // Every use of "$f" must be one of the argument-free forms above, never `"$f" <args>`.
  return (guard && uses === 2) || (wrapper && uses === (guard ? 3 : 1));
}

/** Nearest-rank p95 in the same units as the samples.
 * @param {number[]} values
 * @returns {number}
 */
export function p95(values) {
  if (values.length === 0) throw new Error("p95 of an empty list");
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
}

/** Time native process startup and verdict directly, without a Bash wrapper or CPU estimate.
 * @param {{ binary: string, script: string, input: string, event?: string, cwd?: string, env?: NodeJS.ProcessEnv }} options
 * @returns {{ wallMs: number, exitCode: number }}
 */
export function timeRustOnce(options) {
  const start = process.hrtime.bigint();
  const result = runRustHook(options);
  const wallMs = Number(process.hrtime.bigint() - start) / 1_000_000;
  if (!result.available) throw new Error(`native unavailable: ${result.reason}`);
  return { wallMs, exitCode: result.status };
}

/** Scratch directory with the signed source assets the verdict replay runs (spec 0057 T28).
 * Loaded lazily: the signer imports the renderer's TypeScript, which the shell bench never needs.
 * @returns {Promise<string>}
 */
async function signedAssets() {
  const { writeSignedAssets } = await import("./rust-replay-assets.mjs");
  const dir = mkdtempSync(join(tmpdir(), "navori-bench-assets-"));
  try {
    return writeSignedAssets(dir);
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/** Native reporting deliberately keeps R17 wall p95 separate from the shell CPU budget.
 * Prepared scripts and the executable are pinned before entering the scratch cwd.
 * @param {ReturnType<typeof parseBenchArgs>} options
 * @returns {Promise<number>}
 */
async function benchRust({ scenarios, hooks, runs, reportOnly, audit = "absent" }) {
  if (audit !== "absent") {
    throw new Error(
      `native audit ${audit} unsupported: CLI-writer fixtures and log validation are pending`,
    );
  }
  const signed = process.env.NAVORI_RUST_HOOKS_DIR === undefined ? await signedAssets() : undefined;
  let native;
  try {
    native = prepareRustReplay({
      manifestPath: join(REPO_ROOT, "crates", "ported.json"),
      binary: process.env.NAVORI_RUST_BIN ?? "navori-rust",
      scriptsRoot: process.env.NAVORI_RUST_HOOKS_DIR ?? signed,
    });
  } catch (error) {
    if (signed !== undefined) rmSync(signed, { recursive: true, force: true });
    throw error;
  }
  const registrations = filterHooks(readRegistrations(), scenarios, hooks);
  const sandbox = createSandbox();
  const loadBefore = loadavg();
  const measurements = [];
  try {
    for (const scenario of scenarios) {
      for (const engine of /** @type {Engine[]} */ (["claude", "codex", "pi"])) {
        for (const reg of selectHooks(registrations, scenario, engine)) {
          const hook = hookName(reg);
          // Only ported hooks have a native implementation to time; the rest stay shell-only.
          if (!native.registered(hook)) continue;
          const directory = {
            claude: ".claude/hooks",
            codex: ".codex/hooks",
            pi: ".pi/navori/hooks",
          }[engine];
          if (!argumentFreeInvocation(reg.command, directory, hook)) {
            throw new Error(
              `native registration unsupported: ${engine}/${hook} has no verified argument-free invocation`,
            );
          }
          const script = native.resolveHook(hook, engine);
          const input = readFileSync(writePayload(sandbox, scenario, reg), "utf8");
          const timed = Array.from({ length: runs }, () =>
            timeRustOnce({
              binary: native.binary,
              script,
              input,
              event: reg.event,
              cwd: sandbox.project,
              env: scenarioEnvironment(sandbox, scenario, reg, audit),
            }),
          );
          const runsMs = timed.map((time) => time.wallMs);
          measurements.push({
            ...reg,
            scenario,
            hook,
            audit,
            wallMsMedian: median(runsMs),
            wallMsP95: p95(runsMs),
            runsMs,
            exitCodes: timed.map((time) => time.exitCode),
          });
        }
      }
    }
  } finally {
    sandbox.cleanup();
    if (signed !== undefined) rmSync(signed, { recursive: true, force: true });
  }
  if (measurements.length === 0)
    throw new Error("native unavailable: no registered hooks selected");
  const cpus = availableParallelism();
  const result = {
    generatedAt: new Date().toISOString(),
    impl: "rust",
    metric: "wall",
    unit: "ms",
    audit,
    cpus,
    loadavgBefore: loadBefore,
    loadavgAfter: loadavg(),
    workers: 1,
    comparable: isComparable(loadBefore, cpus),
    runs,
    scenarios,
    ...(hooks ? { hooks } : {}),
    budget: { metric: "wallMsP95", limitMs: RUST_P95_BUDGET_MS },
    measurements,
  };
  const dir = join(REPO_ROOT, ".navori", "state", "bench");
  mkdirSync(dir, { recursive: true });
  const stamped = join(dir, `hooks-rust-${result.generatedAt.replace(/[:.]/g, "-")}.json`);
  writeFileSync(stamped, `${JSON.stringify(result, null, 2)}\n`);
  copyFileSync(stamped, join(dir, "hooks-rust-latest.json"));
  for (const row of measurements) {
    process.stdout.write(
      `bench:hooks rust ${row.engine} ${row.scenario} ${row.hook} audit=${row.audit}: ` +
        `${row.wallMsMedian.toFixed(3)} ms wall median / ${row.wallMsP95.toFixed(3)} ms wall p95\n`,
    );
  }
  process.stdout.write(
    `bench:hooks impl=rust measurements=${measurements.length} comparable=${result.comparable}\n`,
  );
  if (!result.comparable)
    process.stderr.write("bench:hooks NOT comparable: the machine was not idle at the start\n");
  const over = measurements.filter((row) => row.wallMsP95 > RUST_P95_BUDGET_MS);
  if (over.length > 0)
    process.stderr.write(
      `bench:hooks rust over wall p95 budget (${RUST_P95_BUDGET_MS} ms): ${over.length} measurements\n`,
    );
  return over.length > 0 && !reportOnly ? 1 : 0;
}

/** Run one benchmark implementation; native unavailability is never report-only success.
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function main(argv) {
  const summarizeAt = argv.indexOf("--summarize");
  if (summarizeAt !== -1) return summarize(argv.slice(summarizeAt + 1));
  let options;
  try {
    options = parseBenchArgs(argv);
  } catch (error) {
    process.stderr.write(
      `bench:hooks: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }
  const { reportOnly, runs, scenarios } = options;
  if (options.impl === "rust") {
    try {
      return await benchRust(options);
    } catch (error) {
      process.stderr.write(
        `bench:hooks: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 1;
    }
  }
  const sourceRoot = options.root ?? REPO_ROOT;
  if (!existsSync(join(sourceRoot, "packages", "cli", "dist", "index.js"))) {
    process.stderr.write(
      `bench:hooks: ${sourceRoot}/packages/cli/dist/index.js is missing; build it first\n`,
    );
    return 2;
  }
  let registrations;
  try {
    registrations = filterHooks(readRegistrations(sourceRoot), scenarios, options.hooks);
  } catch (error) {
    process.stderr.write(`bench:hooks: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const sandbox = createSandbox(sourceRoot, { requireDist: true });
  const provenance = { ...readProvenance(sourceRoot), observer: readProvenance(REPO_ROOT).head };
  const loadBefore = loadavg();
  /** @type {Measurement[]} */
  const measurements = [];
  try {
    for (const scenario of scenarios) {
      for (const engine of /** @type {Engine[]} */ (["claude", "codex", "pi"])) {
        for (const reg of selectHooks(registrations, scenario, engine)) {
          const payloadPath = writePayload(sandbox, scenario, reg);
          const hook = hookName(reg);
          for (const audit of /** @type {AuditScenario[]} */ (["absent", "root", "active"])) {
            const timed = Array.from({ length: runs }, () =>
              timeOnce(
                reg.command,
                payloadPath,
                sandbox.project,
                scenarioEnvironment(sandbox, scenario, reg, audit),
              ),
            );
            const supplemental = Object.hasOwn(SUPPLEMENTAL_SCENARIOS, scenario);
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
              wallMsP95: p95(timed.map((t) => t.wallMs)),
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
    provenance,
    runs,
    scenarios,
    ...(options.hooks ? { hooks: options.hooks } : {}),
    budgetMs: BASH_BUDGET_MS,
    sums,
    measurements,
  };
  const dir = join(REPO_ROOT, ".navori", "state", "bench");
  mkdirSync(dir, { recursive: true });
  const stamped = join(dir, `hooks-${result.generatedAt.replace(/[:.]/g, "-")}.json`);
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
    process.stderr.write("bench:hooks NOT comparable: the machine was not idle at the start\n");
  if (!verdict.ok) {
    process.stderr.write(
      `bench:hooks over budget:\n${verdict.violations.map((v) => `  - ${v}`).join("\n")}\n`,
    );
    return reportOnly ? 0 : 1;
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
