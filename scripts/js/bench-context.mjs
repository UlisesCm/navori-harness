import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, loadavg } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSandbox, readRegistrations, SCENARIOS, selectHooks, writePayload } from "./bench-hooks.mjs";

/**
 * Spec 0055 R4 — `bun run bench:context`.
 *
 * Measures, in UTF-8 bytes, what an agent reads:
 *   sessionStart  stdout of the SessionStart hooks, per engine (Claude, Codex);
 *   hooks         stdout of every registered hook with the bench payloads (audit absent), plus
 *                 `injectsContext` (R28: the hook emitted `additionalContext` / `systemMessage`
 *                 for a neutral payload) and the list `contextWithoutSignal` of the non
 *                 SessionStart ones that did;
 *   gate          `navori gate fast --force` in green, in a scratch project;
 *   testAffected  `test:affected --files <fixed list>` in green and with a failing fixture
 *                 (`mode: "emulated"` before `test-affected.mjs` supports `--files`: its two
 *                 header lines plus the same `vitest run` it launches).
 * Writes `.navori/state/bench/context-<ts>.json` and `context-latest.json`. Bytes do not depend
 * on machine load, so `comparable` is always true.
 *
 * Usage: node scripts/js/bench-context.mjs
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PACKAGE_ROOT = join(REPO_ROOT, "packages", "cli");
const TEST_AFFECTED = join(PACKAGE_ROOT, "scripts", "test-affected.mjs");
const DIST = join(PACKAGE_ROOT, "dist", "index.js");
/** Fixed, cheap test file the `test:affected` measurements run (package-relative). */
export const AFFECTED_FILES = ["src/__tests__/vitest-workers.test.ts"];
const RED_FIXTURE = "src/__tests__/zz-bench-context-red.test.ts";

/**
 * UTF-8 size of a text.
 *
 * @param {string | null | undefined} text
 * @returns {number}
 */
export function bytesOf(text) {
  return Buffer.byteLength(text ?? "", "utf8");
}

/**
 * Whether a hook's stdout injects context into the conversation: a JSON object with a non-empty
 * `hookSpecificOutput.additionalContext` or `systemMessage`, or plain text (SessionStart style).
 *
 * @param {string} stdout
 * @returns {boolean}
 */
export function injectsContext(stdout) {
  const text = stdout.trim();
  if (text === "") return false;
  try {
    const parsed = JSON.parse(text);
    const context = parsed?.hookSpecificOutput?.additionalContext;
    return (typeof context === "string" && context.trim() !== "") || (typeof parsed?.systemMessage === "string" && parsed.systemMessage.trim() !== "");
  } catch {
    return true;
  }
}

/**
 * @param {string} command
 * @param {string} payloadPath
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
function hookStdout(command, payloadPath, cwd, env) {
  const run = spawnSync("bash", ["-c", 'bash -c "$BENCH_CMD" <"$BENCH_PAYLOAD" 2>/dev/null'], {
    cwd,
    env: { ...env, BENCH_CMD: command, BENCH_PAYLOAD: payloadPath },
    encoding: "utf8",
  });
  return run.stdout ?? "";
}

/**
 * `navori gate fast --force` in green, inside a scratch project whose fast gate prints a little.
 *
 * @param {ReturnType<typeof createSandbox>} sandbox
 * @returns {number}
 */
function gateGreenBytes(sandbox) {
  const configPath = join(sandbox.project, "navori.config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.qualityGate = { fast: "bun run lint && bun run typecheck", full: "bun run lint" };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  writeFileSync(
    join(sandbox.project, "package.json"),
    JSON.stringify({ name: "bench-context", scripts: { lint: "echo lint ok", typecheck: "echo typecheck ok" } }),
  );
  const run = spawnSync("node", [DIST, "gate", "fast", "--force", "--cwd", sandbox.project], {
    cwd: sandbox.project,
    env: sandbox.baseEnv,
    encoding: "utf8",
  });
  if (run.status !== 0) throw new Error(`bench:context: scratch gate was not green (exit ${run.status}): ${run.stdout}${run.stderr}`);
  return bytesOf(run.stdout) + bytesOf(run.stderr);
}

/**
 * Bytes `test:affected` prints for `files`; green when `files` only holds passing tests.
 *
 * @param {string[]} files package-relative test files
 * @returns {{ bytes: number, status: number, mode: "native" | "emulated" }}
 */
function testAffectedBytes(files) {
  const native = readFileSync(TEST_AFFECTED, "utf8").includes('"--files"');
  const env = { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" };
  delete env.NAVORI_BENCH_PROC_DIR;
  const run = native
    ? spawnSync("node", [TEST_AFFECTED, "--files", ...files.map((f) => `packages/cli/${f}`)], { cwd: REPO_ROOT, env, encoding: "utf8" })
    : spawnSync("bun", ["x", "vitest", "run", ...files], { cwd: PACKAGE_ROOT, env, encoding: "utf8" });
  const header = native ? "" : `test:affected: affected subset, not a gate\ntest:affected: ${files.length} selected test file(s)\n`;
  return {
    bytes: bytesOf(header) + bytesOf(run.stdout) + bytesOf(run.stderr),
    status: run.status ?? 1,
    mode: native ? "native" : "emulated",
  };
}

/** Measures `test:affected` green and with a failing fixture (removed afterwards). */
function measureTestAffected() {
  const green = testAffectedBytes(AFFECTED_FILES);
  if (green.status !== 0) throw new Error("bench:context: the fixed test:affected files are not green");
  const redPath = join(PACKAGE_ROOT, RED_FIXTURE);
  writeFileSync(
    redPath,
    'import { expect, it } from "vitest";\nit("bench-context red fixture", () => {\n  expect({ a: 1, b: [1, 2, 3] }).toEqual({ a: 2, b: [1, 2, 4] });\n});\n',
  );
  try {
    const red = testAffectedBytes([...AFFECTED_FILES, RED_FIXTURE]);
    if (red.status === 0) throw new Error("bench:context: the red fixture did not fail");
    return { green: green.bytes, red: red.bytes, mode: green.mode };
  } finally {
    rmSync(redPath, { force: true });
  }
}

/**
 * Materialize the neutral population from its actual policy; copying `always` hooks
 * would measure a legitimate audit-activation notice as unsolicited context.
 *
 * @param {ReturnType<typeof createSandbox>} sandbox
 */
export function renderNeutralHooks(sandbox) {
  const path = join(sandbox.project, "navori.config.json");
  const config = JSON.parse(readFileSync(path, "utf8"));
  config.audit = { ...config.audit, mode: "opt-in" };
  writeFileSync(path, JSON.stringify(config, null, 2));
  const run = spawnSync("node", [DIST, "render", "--apply", "--cwd", sandbox.project], {
    cwd: sandbox.project,
    env: sandbox.baseEnv,
    encoding: "utf8",
  });
  if (run.status !== 0) throw new Error(`bench:context: neutral render failed: ${run.stdout}${run.stderr}`);
}

function main() {
  const registrations = readRegistrations();
  const sandbox = createSandbox();
  const loadBefore = loadavg();
  const hooks = [];
  const sessionStart = { claude: 0, codex: 0 };
  let gate;
  try {
    renderNeutralHooks(sandbox);
    const env = sandbox.env("absent");
    for (const scenario of Object.keys(SCENARIOS)) {
      for (const engine of ["claude", "codex", "pi"]) {
        for (const reg of selectHooks(registrations, scenario, engine)) {
          const payloadPath = writePayload(sandbox, scenario, reg);
          const stdout = hookStdout(reg.command, payloadPath, sandbox.project, env);
          const hook = /([\w-]+\.sh)/.exec(reg.command)?.[1] ?? reg.command;
          if (scenario === "SessionStart" && engine in sessionStart) sessionStart[engine] += bytesOf(stdout);
          hooks.push({ engine, hook, scenario, event: reg.event, bytes: bytesOf(stdout), injectsContext: injectsContext(stdout) });
        }
      }
    }
    gate = { green: gateGreenBytes(sandbox) };
  } finally {
    sandbox.cleanup();
  }
  const testAffected = measureTestAffected();
  const result = {
    generatedAt: new Date().toISOString(),
    cpus: availableParallelism(),
    loadavgBefore: loadBefore,
    loadavgAfter: loadavg(),
    workers: 1,
    comparable: true,
    sessionStart,
    hooks,
    contextWithoutSignal: hooks
      .filter((h) => h.scenario !== "SessionStart" && h.injectsContext)
      .map(({ engine, hook, scenario, bytes }) => ({ engine, hook, scenario, bytes })),
    gate,
    testAffected: { green: testAffected.green, red: testAffected.red, mode: testAffected.mode },
  };
  const dir = join(REPO_ROOT, ".navori", "state", "bench");
  mkdirSync(dir, { recursive: true });
  const stamped = join(dir, `context-${result.generatedAt.replace(/[:.]/g, "-")}.json`);
  writeFileSync(stamped, `${JSON.stringify(result, null, 2)}\n`);
  copyFileSync(stamped, join(dir, "context-latest.json"));
  process.stdout.write(
    `bench:context sessionStart claude=${sessionStart.claude}B codex=${sessionStart.codex}B gate.green=${gate.green}B ` +
      `test:affected green=${testAffected.green}B red=${testAffected.red}B (${testAffected.mode})\n`,
  );
  process.stdout.write(`bench:context hooks=${hooks.length} contextWithoutSignal=${result.contextWithoutSignal.length}\n`);
  for (const h of result.contextWithoutSignal) {
    process.stdout.write(`  ${h.engine} ${h.scenario} ${h.hook} ${h.bytes}B\n`);
  }
  return existsSync(stamped) ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
