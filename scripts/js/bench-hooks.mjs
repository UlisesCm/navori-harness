import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, loadavg, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withoutRepoGitEnv } from "./git-env.mjs";

/**
 * Spec 0054 R27 — `bun run bench:hooks`.
 *
 * Measures the process cost (user + sys CPU, via bash's `time`) of every hook
 * registered in `.claude/settings.json` and `.codex/config.toml` (Codex has no
 * `hooks.json`; its registrations are `[[hooks.<Event>]]` tables), median of
 * `--runs` (default 3) per hook, and sums the medians per scenario:
 *   Bash (PreToolUse + PostToolUse), Edit, Agent, SessionStart, UserPromptSubmit.
 * Exits 1 when a Bash call WITHOUT audit costs more than 300 ms in either engine,
 * unless `--report-only`.
 *
 * Hermetic: hooks run from a scratch copy of the hook trees in a scratch git repo,
 * with scratch HOME and NAVORI_AUDITS_ROOT (empty: no audit armed). The repo is
 * never written, except `.navori/state/bench/` for the report.
 *
 * Usage: node scripts/js/bench-hooks.mjs [--report-only] [--runs N]
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PAYLOADS = join(dirname(fileURLToPath(import.meta.url)), "bench-payloads");
export const BASH_BUDGET_MS = 300;

/** Tool name each scenario uses per engine, and the payload file it sends. */
export const SCENARIOS = {
  Bash: { payload: "bash.json", events: ["PreToolUse", "PostToolUse"], tools: { claude: "Bash", codex: "Bash" } },
  Edit: { payload: "edit.json", events: ["PreToolUse", "PostToolUse"], tools: { claude: "Edit", codex: "apply_patch" } },
  Agent: { payload: "agent.json", events: ["PreToolUse", "PostToolUse"], tools: { claude: "Agent", codex: "spawn_agent" } },
  SessionStart: { payload: "session-start.json", events: ["SessionStart"], source: "startup" },
  UserPromptSubmit: { payload: "user-prompt.json", events: ["UserPromptSubmit"] },
};

/**
 * @typedef {"claude" | "codex"} Engine
 * @typedef {{ engine: Engine, event: string, matcher: string | null, command: string }} Registration
 * @typedef {Registration & { scenario: string, hook: string, runsMs: number[], medianMs: number }} Measurement
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
  const spec = SCENARIOS[scenario];
  const subject = spec.tools ? spec.tools[engine] : (spec.source ?? "");
  return registrations.filter((reg) => {
    if (reg.engine !== engine || !spec.events.includes(reg.event)) return false;
    if (reg.matcher === null || reg.matcher === "") return true;
    // Claude matchers are exact-name alternations; Codex ones are real regexes.
    const pattern = engine === "claude" ? `^(?:${reg.matcher})$` : reg.matcher;
    return new RegExp(pattern).test(subject);
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

/**
 * CPU time (user + sys, ms) of one hook run, read from bash's `time` keyword.
 * The hook runs in a child bash so its whole process tree is accounted for.
 *
 * @param {string} command registered hook command
 * @param {string} payloadPath
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} env
 * @returns {number}
 */
function timeOnce(command, payloadPath, cwd, env) {
  const run = spawnSync(
    "bash",
    ["-c", 'TIMEFORMAT="%3U %3S"; time bash -c "$BENCH_CMD" <"$BENCH_PAYLOAD" >/dev/null 2>/dev/null'],
    { cwd, env: { ...env, BENCH_CMD: command, BENCH_PAYLOAD: payloadPath }, encoding: "utf8" },
  );
  const match = /(\d+\.\d+) (\d+\.\d+)\s*$/.exec(run.stderr ?? "");
  if (!match) throw new Error(`cannot read time output for: ${command}\n${run.stderr}`);
  return Math.round((Number(match[1]) + Number(match[2])) * 1000);
}

/** Builds the scratch repo the hooks run in. */
function makeSandbox() {
  const root = mkdtempSync(join(tmpdir(), "navori-bench-hooks-"));
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  for (const tree of [".claude/hooks", ".codex/hooks"]) {
    if (existsSync(join(REPO_ROOT, tree))) cpSync(join(REPO_ROOT, tree), join(project, tree), { recursive: true });
  }
  if (existsSync(join(REPO_ROOT, "navori.config.json"))) {
    copyFileSync(join(REPO_ROOT, "navori.config.json"), join(project, "navori.config.json"));
  }
  const env = {
    ...withoutRepoGitEnv(process.env),
    HOME: join(root, "home"),
    NAVORI_AUDITS_ROOT: join(root, "audits"),
    CLAUDE_PROJECT_DIR: project,
  };
  mkdirSync(env.HOME, { recursive: true });
  mkdirSync(env.NAVORI_AUDITS_ROOT, { recursive: true });
  const init = spawnSync("git", ["init", "-q"], { cwd: project, env });
  if (init.status !== 0) throw new Error("git init failed in the sandbox");
  return { root, project, env };
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
  const registrations = [
    ...parseClaudeRegistrations(JSON.parse(readFileSync(join(REPO_ROOT, ".claude", "settings.json"), "utf8"))),
    ...parseCodexRegistrations(readFileSync(join(REPO_ROOT, ".codex", "config.toml"), "utf8")),
  ];
  const sandbox = makeSandbox();
  const loadBefore = loadavg();
  /** @type {Measurement[]} */
  const measurements = [];
  try {
    for (const [scenario, spec] of Object.entries(SCENARIOS)) {
      for (const engine of /** @type {Engine[]} */ (["claude", "codex"])) {
        for (const reg of selectHooks(registrations, scenario, engine)) {
          const template = readFileSync(join(PAYLOADS, spec.payload), "utf8");
          const payloadPath = join(sandbox.root, `${engine}-${scenario}-${reg.event}.json`);
          writeFileSync(
            payloadPath,
            template
              .replaceAll("__CWD__", sandbox.project)
              .replaceAll("__EVENT__", reg.event)
              .replaceAll("__TOOL__", spec.tools?.[engine] ?? ""),
          );
          const runsMs = Array.from({ length: runs }, () => timeOnce(reg.command, payloadPath, sandbox.project, sandbox.env));
          const hook = /([\w-]+\.sh)/.exec(reg.command)?.[1] ?? reg.command;
          measurements.push({ ...reg, scenario, hook, runsMs, medianMs: median(runsMs) });
        }
      }
    }
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
  const sums = sumByEvent(measurements);
  const verdict = evaluateBudget(sums);
  const result = {
    generatedAt: new Date().toISOString(),
    cpus: availableParallelism(),
    loadavgBefore: loadBefore,
    loadavgAfter: loadavg(),
    runs,
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
      process.stdout.write(`bench:hooks ${engine} ${scenario}: ${s.totalMs.toFixed(0)} ms (${s.hooks} hooks)\n`);
    }
  }
  process.stdout.write(`bench:hooks load=${loadBefore.map((n) => n.toFixed(2)).join("/")} cpus=${result.cpus}\n`);
  if (!verdict.ok) {
    process.stderr.write(`bench:hooks over budget:\n${verdict.violations.map((v) => `  - ${v}`).join("\n")}\n`);
    return reportOnly ? 0 : 1;
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
