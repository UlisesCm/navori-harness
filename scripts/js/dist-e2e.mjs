#!/usr/bin/env node
/**
 * End-to-end check of the real npm package before publishing (release blocker, decision of
 * Ulises, 20 Nov 16:45): in a clean container without Rust, install the assembled tarballs the
 * way users will and use navori in a fabricated project.
 *
 * Host mode (this checkout, docker on PATH):
 *
 *   node scripts/js/dist-e2e.mjs --binary <static linux-x64 navori-rust>
 *        --legacy-tarball <tgz> --legacy-pin <json> [--managers npm,pnpm,npm-ignore-scripts]
 *        [--alias] [--keep] [--json <file>]
 *
 * It assembles and packs `navori` and its linux-x64 platform package (dist-assemble; the checkout's
 * `crates/ported.json` must be the binary's), builds a `node:<.nvmrc>` image with git and jq and
 * pnpm, and per manager installs the main, platform and legacy tarballs in a fresh project. Files
 * reach the container through `docker exec -i ... tar` (a snap docker cannot read hidden paths).
 *
 * Inner mode (`--inner <scenario>`, in the container) runs, per scenario:
 *   1. the install; `navori --version`; what `navori` is (binary or JS launcher); whether
 *      `navori-rust`, the name every rendered hook looks for (native_hook.rs NATIVE_HOOK_BIN), is
 *      on PATH;
 *   2. `navori init --yes`, then engines claude+pi, `qualityGate.{fast,full}`, and `render --apply`;
 *      whether the guard carries the native block with the default plugins;
 *   3. `plugins.tgrep` enabled and `render --apply` again (the signed guard includes the
 *      tgrep-search-lane block), and a real guard call ("echo hi") through the Pi script,
 *      default and with NAVORI_HOOK_IMPL=rust, timed;
 *   4. activation-verify.mjs on the guard (decided by the native, and its time); a gate when the
 *      package's manifest has the guard active, information when it is in shadow;
 *   5. `navori doctor`: exit 0 and no warning outside EXPECTED_DOCTOR_WARNINGS.
 * The calls run without NODE_* variables (the node image exports NODE_VERSION, and any NODE_*
 * variable makes the native hook defer); one informative check documents that case.
 * `--alias` (diagnostic, not a release mode) links `navori-rust` to the package's binary first,
 * to show what the run looks like once the package exposes that name.
 *
 * Exit: 0 every scenario green, 1 a check failed, 2 usage or setup error.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFERRED, FAILED, decisionOf } from "./activation-verify.mjs";
import { platformPackage } from "./dist-assemble.mjs";
import { isMain } from "./is-main.mjs";

/** @typedef {{ name: string, ok: boolean, gate: boolean, detail: string }} Check */
/** @typedef {{ scenario: string, alias: boolean, facts: Record<string, unknown>, checks: Check[] }} ScenarioResult */
/** @typedef {{ managers: string[], alias: boolean, keep: boolean, binary: string, legacyTarball: string, legacyPin: string, json: string, inner: string, version: string }} Options */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PNPM_VERSION = "12.16.1";
export const SCENARIOS = ["npm", "pnpm", "npm-ignore-scripts"];

/**
 * Warnings (`▲` headings of the native doctor, Spanish) a fresh fabricated project legitimately
 * shows: external tools absent from the container and templates nobody filled yet.
 */
export const EXPECTED_DOCTOR_WARNINGS = [
  "Plugins habilitados con herramienta externa no instalada",
  "Herramientas opcionales no instaladas",
  "Skills instaladas con su user-section sin llenar",
  "Agentes sin perfil de modelo/effort",
];

/**
 * How each scenario installs the tarballs (npm with and without scripts, pnpm with builds allowed,
 * as dist-probe does for a local tarball).
 *
 * @param {string} scenario
 * @param {string[]} tarballs
 * @returns {{ argv: string[], env: Record<string, string> }}
 */
export function installPlan(scenario, tarballs) {
  switch (scenario) {
    case "npm":
      return { argv: ["npm", "install", "--no-audit", "--no-fund", ...tarballs], env: {} };
    case "npm-ignore-scripts":
      return { argv: ["npm", "install", "--no-audit", "--no-fund", "--ignore-scripts", ...tarballs], env: {} };
    case "pnpm":
      return { argv: ["pnpm", "add", ...tarballs], env: { PNPM_CONFIG_DANGEROUSLY_ALLOW_ALL_BUILDS: "true" } };
    default:
      throw new Error(`unknown scenario ${scenario}`);
  }
}

/**
 * The `▲` headings of a doctor output that are not expected.
 *
 * @param {string} output
 * @param {string[]} [expected]
 * @returns {string[]}
 */
export function unexpectedWarnings(output, expected = EXPECTED_DOCTOR_WARNINGS) {
  return output
    .split("\n")
    .filter((line) => line.startsWith("▲"))
    .map((line) => line.replace(/^▲\s*/, "").trim())
    .filter((heading) => !expected.some((prefix) => heading.startsWith(prefix)));
}

/**
 * Median of a list of numbers.
 *
 * @param {number[]} values
 * @returns {number}
 */
export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * First bytes of a file: `ELF` for the binary, `#!` for a launcher or shim.
 *
 * @param {string} file
 * @returns {"binary" | "script" | "other" | "missing"}
 */
function kindOf(file) {
  if (!existsSync(file)) return "missing";
  const fd = openSync(file, "r");
  try {
    const head = Buffer.alloc(4);
    readSync(fd, head, 0, 4, 0);
    if (head[0] === 0x7f && head.toString("latin1", 1, 4) === "ELF") return "binary";
    return head.toString("latin1", 0, 2) === "#!" ? "script" : "other";
  } finally {
    closeSync(fd);
  }
}

/**
 * Whether a guard call on `echo hi` allowed it: exit 0 and no `ask`/`deny`. The wrapper turns a
 * native crash or an unknown exit into a fail-closed `ask` with exit 0, so the stdout is checked
 * too (FAILED); a call killed by a signal or a timeout has no exit code and is not allowed.
 *
 * @param {{ status: number | null, stdout: string }} r
 * @returns {boolean}
 */
export function allowed(r) {
  return r.status === 0 && !FAILED.test(r.stdout) && ["pass (exit 0)", "allow"].includes(decisionOf(r.stdout, r.status));
}

/**
 * One activation-verify row for the report: problems or OK, the notes (an engine the hook is not
 * registered in), and the median when the calls were timed.
 *
 * @param {{ engine: string, ok: boolean, p50Ms?: number, problems: string[], notes?: string[] }} r
 * @returns {string}
 */
export function verifyRowDetail(r) {
  const parts = [r.ok ? "OK" : r.problems.join("; "), ...(r.notes ?? []).map((note) => `note: ${note}`)];
  if (r.p50Ms !== undefined) parts.push(`p50=${r.p50Ms} ms`);
  return `${r.engine}: ${parts.join(" ")}`;
}

/**
 * A child killed by SIGINT/SIGTERM means the run was interrupted (Ctrl-C reaches the whole
 * foreground group): stop here so the caller's `finally` cleans up. The docker client traps
 * those signals and exits 130/143 instead, so a caller may pass that status too.
 *
 * @param {NodeJS.Signals | null} signal
 * @param {number | null} [trappedStatus] exit status of a child that traps SIGINT/SIGTERM
 */
export function throwIfInterrupted(signal, trappedStatus = null) {
  if (signal === "SIGINT" || signal === "SIGTERM") throw new Error(`interrupted by ${signal}`);
  if (trappedStatus === 130) throw new Error("interrupted by SIGINT (exit 130)");
  if (trappedStatus === 143) throw new Error("interrupted by SIGTERM (exit 143)");
}

/**
 * Whether activation-verify gates the run for a guard in `mode` (from the package's ported.json):
 * everything but `shadow` gates, so a guard missing from the manifest is red too.
 *
 * @param {string} mode
 * @returns {boolean}
 */
export function verifyGates(mode) {
  return mode !== "shadow";
}

// ---------------------------------------------------------------- inner mode (container)

/**
 * @param {string} scenario
 * @param {{ version: string, alias: boolean }} options
 * @returns {ScenarioResult}
 */
function inner(scenario, { version, alias }) {
  /** @type {Check[]} */
  const checks = [];
  /** @type {Record<string, unknown>} */
  const facts = {};
  /** @type {(name: string, ok: boolean, detail?: string, gate?: boolean) => void} */
  const check = (name, ok, detail = "", gate = true) => {
    checks.push({ name, ok, gate, detail });
  };
  const name = `e2e-${scenario}`;
  const project = join("/e2e", scenario, name);
  mkdirSync(project, { recursive: true });
  const bin = join(project, "node_modules", ".bin");
  // The official node image exports NODE_VERSION; any NODE_* variable makes the native hook defer
  // (navori-hooks shell/prepare.rs), so the calls run as on a plain host and one check documents it.
  const env = Object.fromEntries(Object.entries({ ...process.env, PATH: `${bin}:${process.env.PATH}` }).filter(([k]) => !k.startsWith("NODE_")));
  /** @type {(argv: string[], extra?: Record<string, string>, input?: string) => import("node:child_process").SpawnSyncReturns<string>} */
  const run = (argv, extra = {}, input) =>
    spawnSync(argv[0], argv.slice(1), { cwd: project, env: { ...env, ...extra }, encoding: "utf8", input, timeout: 600_000 });
  const done = () => ({ scenario, alias, facts, checks });

  run(["git", "init", "-q"]);
  writeFileSync(join(project, "package.json"), `${JSON.stringify({ name, version: "1.0.0", private: true }, null, 2)}\n`);
  const tarballs = ["main", "platform", "legacy"].map((t) => `/e2e/pkg/${t}.tgz`);
  const plan = installPlan(scenario, tarballs);
  const install = run(plan.argv, plan.env);
  facts.manager = run([plan.argv[0], "--version"]).stdout.trim();
  facts.jq = run(["sh", "-c", "jq --version 2>/dev/null || echo absent"]).stdout.trim();
  facts.installWarnings = `${install.stdout}${install.stderr}`.split("\n").filter((l) => /warn/i.test(l)).slice(0, 8);
  check("install", install.status === 0, install.status === 0 ? "" : `${install.stderr}`.trim().slice(-400));
  if (install.status !== 0) return done();

  const pkg = join(project, "node_modules", "navori");
  facts.navoriBin = kindOf(join(pkg, "bin", "navori"));
  facts.nativeHookBin = kindOf(join(pkg, "bin", "navori-native-hook"));
  const platformBinary = join(project, "node_modules", platformPackage("linux-x64"), "bin", "navori");
  facts.platformBinary = kindOf(platformBinary);
  if (alias) symlinkSync(facts.navoriBin === "binary" ? join(pkg, "bin", "navori") : platformBinary, join(bin, "navori-rust"));
  const started = process.hrtime.bigint();
  const ver = run(["navori", "--version"]);
  facts.versionMs = Number(process.hrtime.bigint() - started) / 1e6;
  check("navori --version", ver.status === 0 && ver.stdout.trim() === version, `${ver.stdout.trim()} (expected ${version})`);
  const which = run(["sh", "-c", "command -v navori-rust"]);
  facts.navoriRust = which.status === 0 ? which.stdout.trim() : null;
  check(
    "navori-rust on PATH (the name the rendered hooks look for)",
    which.status === 0,
    which.status === 0 ? which.stdout.trim() : "absent: the package exposes only navori and navori-native-hook",
  );

  const init = run(["navori", "init", "--yes"]);
  check("navori init --yes", init.status === 0, init.status === 0 ? "" : `${init.stderr}`.trim().slice(-300));
  if (init.status !== 0) return done();
  const configPath = join(project, "navori.config.json");
  /** @type {(edit: (config: Record<string, unknown>) => void) => void} */
  const editConfig = (edit) => {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    edit(config);
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  };
  editConfig((config) => {
    config.name = name;
    config.engines = ["claude", "pi"];
    config.qualityGate = { .../** @type {Record<string, unknown>} */ (config.qualityGate ?? {}), fast: "true", full: "true" };
  });
  const guardScripts = [".pi/navori/hooks/guard-destructive.sh", ".claude/hooks/guard-destructive.sh"];
  const nativeBlock = () => guardScripts.every((s) => existsSync(join(project, s)) && readFileSync(join(project, s), "utf8").includes("navori:native-runtime start"));
  const render1 = run(["navori", "render", "--apply"]);
  check("render --apply (claude + pi)", render1.status === 0, render1.status === 0 ? "" : `${render1.stderr}`.trim().slice(-300));
  check(
    "guard carries the native block with the default plugins",
    nativeBlock(),
    nativeBlock() ? "" : "no: the signed guard includes tgrep-search-lane, so without plugins.tgrep the guard is shell only",
    // Informative until Ulises decides whether a guard without tgrep must go native for the release.
    false,
  );
  editConfig((config) => {
    config.plugins = { .../** @type {Record<string, unknown>} */ (config.plugins ?? {}), tgrep: { enabled: true } };
  });
  const render2 = run(["navori", "render", "--apply"]);
  check("render --apply with plugins.tgrep", render2.status === 0 && nativeBlock(), nativeBlock() ? "" : "guard still without the native block");

  const manifestPath = join(pkg, "legacy", "crates", "ported.json");
  const mode = JSON.parse(readFileSync(manifestPath, "utf8")).hooks?.["guard-destructive"]?.mode ?? "missing";
  facts.guardMode = mode;
  const payload = JSON.stringify({ session_id: "e2e", cwd: project, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "echo hi" } });
  const callGuard = (extra = {}) => run(["bash", guardScripts[0]], extra, payload);
  callGuard();
  const times = [];
  let last;
  for (let i = 0; i < 7; i += 1) {
    const t = process.hrtime.bigint();
    last = callGuard();
    times.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  facts.guardPiMs = Number(median(times).toFixed(1));
  check(
    'guard "echo hi" through the Pi script',
    last !== undefined && allowed(last),
    `exit ${last?.status}, ${last ? decisionOf(last.stdout, last.status) : "no run"}, median ${facts.guardPiMs} ms`,
  );
  const forced = callGuard({ NAVORI_HOOK_IMPL: "rust" });
  const deferred = DEFERRED.test(forced.stderr);
  check(
    "the native runtime answers the guard (NAVORI_HOOK_IMPL=rust)",
    !deferred && allowed(forced),
    deferred ? forced.stderr.trim().split("\n")[0] : `exit ${forced.status}, ${decisionOf(forced.stdout, forced.status)}`,
  );

  const withNodeVar = callGuard({ NODE_VERSION: process.versions.node, NAVORI_HOOK_IMPL: "rust" });
  check(
    "the native runtime answers with NODE_VERSION set (official node image, CI)",
    !DEFERRED.test(withNodeVar.stderr),
    withNodeVar.stderr.trim().split("\n")[0] ?? "",
    false,
  );

  const gates = verifyGates(mode);
  // The project renders both engines (config.engines above): a guard absent from either fails.
  const verify = run(["node", "/e2e/scripts/js/activation-verify.mjs", "--root", project, "--manifest", manifestPath, "--hook", "guard-destructive", "--engine", "claude", "--engine", "pi", "--runs", "10", "--json"]);
  try {
    const report = JSON.parse(verify.stdout);
    facts.activationVerify = report.rows.map((r) => ({ engine: r.engine, ok: r.ok, p50Ms: r.p50Ms, problems: r.problems, notes: r.notes ?? [] }));
    check(`activation-verify on guard-destructive (mode ${mode})`, report.rows.every((r) => r.ok), report.rows.map(verifyRowDetail).join(" | "), gates);
  } catch {
    check("activation-verify on guard-destructive", false, `${verify.stderr}`.trim().slice(-300), gates);
  }

  const doctor = run(["navori", "doctor"]);
  const doctorOutput = `${doctor.stdout}${doctor.stderr}`;
  // Without the postinstall (pnpm, --ignore-scripts) the bins are the Node launcher, and doctor
  // has to say so with the fix for each manager; with it, the note must not appear.
  const launcherOnPath = kindOf(join(bin, "navori-rust")) === "script" || kindOf(join(bin, "navori")) === "script";
  const note = launcherNote(doctorOutput);
  check(
    launcherOnPath ? "doctor warns that the bins on PATH are the Node launcher" : "doctor gives no Node-launcher note",
    launcherOnPath ? note !== undefined && note.includes("los hooks buscan 'navori-rust'") : note === undefined,
    note ?? "no note",
  );
  const unexpected = unexpectedWarnings(doctorOutput, launcherOnPath ? [...EXPECTED_DOCTOR_WARNINGS, note ?? ""].filter(Boolean) : undefined);
  check("navori doctor", doctor.status === 0 && unexpected.length === 0, [`exit ${doctor.status}`, ...unexpected.map((w) => `unexpected: ${w.slice(0, 160)}`)].join("; "));
  return done();
}

/**
 * The `▲` heading of doctor's Node-launcher note (Spanish), if any: `'navori', 'navori-rust' en
 * el PATH es el lanzador de Node del paquete ...`.
 *
 * @param {string} output
 * @returns {string | undefined}
 */
export function launcherNote(output) {
  return output
    .split("\n")
    .filter((line) => line.startsWith("▲"))
    .map((line) => line.replace(/^▲\s*/, "").trim())
    .find((heading) => /^'[^']+'(?:, '[^']+')* en el PATH es el lanzador de Node del paquete/.test(heading));
}

// ---------------------------------------------------------------- host mode

/**
 * @param {string[]} argv
 * @returns {Options}
 */
export function parseArgs(argv) {
  /** @type {Options} */
  const out = { managers: [...SCENARIOS], alias: false, keep: false, binary: "", legacyTarball: "", legacyPin: "", json: "", inner: "", version: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${flag} needs a value`);
      i += 1;
      return next;
    };
    if (flag === "--binary") out.binary = resolve(value());
    else if (flag === "--legacy-tarball") out.legacyTarball = resolve(value());
    else if (flag === "--legacy-pin") out.legacyPin = resolve(value());
    else if (flag === "--managers") {
      out.managers = value().split(",");
      const unknown = out.managers.filter((m) => !SCENARIOS.includes(m));
      if (unknown.length > 0) throw new Error(`unknown scenario ${unknown.join(", ")}`);
    } else if (flag === "--alias") out.alias = true;
    else if (flag === "--keep") out.keep = true;
    else if (flag === "--json") out.json = resolve(value());
    else if (flag === "--inner") out.inner = value();
    else if (flag === "--version") out.version = value();
    else throw new Error(`unknown option ${flag}`);
  }
  if (out.inner === "" && (out.binary === "" || out.legacyTarball === "" || out.legacyPin === "")) {
    throw new Error("--binary, --legacy-tarball and --legacy-pin are required");
  }
  return out;
}

/**
 * The image the scenarios run in: Node of `.nvmrc`, git, jq and pnpm; no Rust. Debian 13 (trixie)
 * because its jq is 1.7.1: the native hooks accredit only jq 1.7/1.8 and defer when another jq is
 * on PATH (navori-hooks shell/prepare.rs), so bookworm's jq 1.6 would keep every hook on the shell.
 *
 * @param {string} node
 * @returns {string}
 */
export function dockerfile(node) {
  return [
    `FROM node:${node}-trixie-slim`,
    "RUN apt-get update && apt-get install -y --no-install-recommends git jq ca-certificates && rm -rf /var/lib/apt/lists/* \\",
    ` && npm install --global pnpm@${PNPM_VERSION} \\`,
    " && git config --system user.email e2e@navori.test && git config --system user.name e2e",
    "",
  ].join("\n");
}

/**
 * Image tag of a Dockerfile: its Node version plus a hash of the text, so a change rebuilds it.
 *
 * @param {string} node
 * @param {string} text
 * @returns {string}
 */
export function imageTag(node, text) {
  return `navori-e2e:node${node}-${createHash("sha256").update(text).digest("hex").slice(0, 12)}`;
}

/**
 * @param {string[]} args
 * @param {string | Buffer} [input]
 */
function docker(args, input) {
  const result = spawnSync("docker", args, { encoding: input === undefined ? "utf8" : undefined, input, maxBuffer: 64 * 1024 * 1024 });
  throwIfInterrupted(result.signal, result.status);
  return result;
}

/**
 * @param {Options} options
 * @returns {Promise<number>} exit code
 */
async function host(options) {
  const { assemble, legacyPin, pack, workspaceVersion } = await import("./dist-assemble.mjs");
  if (spawnSync("docker", ["version"], { encoding: "utf8" }).status !== 0) throw new Error("docker is not available");
  const version = workspaceVersion();
  const root = mkdtempSync(join(tmpdir(), "navori-dist-e2e-"));
  const node = readFileSync(join(REPO_ROOT, ".nvmrc"), "utf8").trim();
  const recipe = dockerfile(node);
  const image = imageTag(node, recipe);
  const container = `navori-dist-e2e-${process.pid}`;
  const cleanup = () => {
    // Plain spawnSync: a second Ctrl-C here must not throw before the temp dir is removed.
    spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
    rmSync(root, { recursive: true, force: true });
  };
  // A Ctrl-C reaches the foreground group: the docker call dies with SIGINT and `docker()` throws, so
  // `finally` removes the container (`sleep infinity`) and the temp dir. spawnSync blocks the event
  // loop, so these handlers only cover a signal that arrives between calls (or is sent to node alone).
  /** @type {Array<[NodeJS.Signals, number]>} */
  const signals = [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ];
  const handlers = signals.map(([signal, code]) => {
    const handler = () => {
      if (!options.keep) cleanup();
      process.exit(code);
    };
    process.once(signal, handler);
    return /** @type {const} */ ([signal, handler]);
  });
  try {
    const dist = join(root, "dist");
    const dirs = assemble({
      out: dist,
      binaries: { "linux-x64": options.binary },
      legacyTarball: options.legacyTarball,
      pin: legacyPin(options.legacyPin),
      version,
    });
    const stage = join(root, "stage");
    mkdirSync(join(stage, "pkg"), { recursive: true });
    cpSync(pack(dirs.main, dist), join(stage, "pkg", "main.tgz"));
    cpSync(pack(dirs.platforms["linux-x64"], dist), join(stage, "pkg", "platform.tgz"));
    cpSync(options.legacyTarball, join(stage, "pkg", "legacy.tgz"));
    cpSync(join(REPO_ROOT, "scripts", "js"), join(stage, "scripts", "js"), { recursive: true });

    if (docker(["image", "inspect", image]).status !== 0) {
      const build = docker(["build", "-q", "-t", image, "-"], recipe);
      if (build.status !== 0) throw new Error(`docker build failed: ${String(build.stderr).slice(-400)}`);
    }
    const start = docker(["run", "-d", "--rm", "--name", container, image, "sleep", "infinity"]);
    if (start.status !== 0) throw new Error(`docker run failed: ${start.stderr}`);
    const tar = spawnSync("tar", ["-cf", "-", "-C", stage, "."], { maxBuffer: 256 * 1024 * 1024 });
    throwIfInterrupted(tar.signal);
    if (tar.status !== 0 || tar.error !== undefined) {
      throw new Error(`tar of ${stage} failed: ${tar.error?.message ?? String(tar.stderr).slice(-400)}`);
    }
    const copy = docker(["exec", "-i", container, "sh", "-c", "mkdir -p /e2e && tar -xf - -C /e2e"], tar.stdout);
    if (copy.status !== 0) throw new Error(`copy into the container failed: ${copy.stderr}`);

    /** @type {ScenarioResult[]} */
    const results = [];
    for (const scenario of options.managers) {
      const out = docker(["exec", container, "node", "/e2e/scripts/js/dist-e2e.mjs", "--inner", scenario, "--version", version, ...(options.alias ? ["--alias"] : [])]);
      try {
        results.push(JSON.parse(String(out.stdout).trim().split("\n").at(-1) ?? ""));
      } catch {
        results.push({ scenario, alias: options.alias, facts: {}, checks: [{ name: "inner run", ok: false, gate: true, detail: String(out.stderr).slice(-400) }] });
      }
    }
    for (const r of results) {
      const red = r.checks.some((c) => c.gate && !c.ok);
      process.stdout.write(`${red ? "FAIL" : "ok  "} ${r.scenario}${r.alias ? " (--alias)" : ""}  ${r.facts.manager ?? ""} ${r.facts.jq ?? ""} navori=${r.facts.navoriBin} guardMode=${r.facts.guardMode} guardPi=${r.facts.guardPiMs} ms\n`);
      for (const c of r.checks) process.stdout.write(`       ${c.ok ? "ok  " : c.gate ? "FAIL" : "info"} ${c.name}${c.detail ? `: ${c.detail}` : ""}\n`);
    }
    if (options.json !== "") writeFileSync(options.json, `${JSON.stringify({ version, image, results }, null, 2)}\n`);
    const ok = results.every((r) => r.checks.every((c) => !c.gate || c.ok));
    process.stdout.write(`dist-e2e: ${ok ? "green" : "red"} (${results.length} scenarios, ${version})\n`);
    return ok ? 0 : 1;
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    if (!options.keep) cleanup();
    else process.stdout.write(`kept: ${root} and container ${container}\n`);
  }
}

if (isMain(import.meta.url)) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`dist-e2e: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
  if (options.inner !== "") {
    process.stdout.write(`${JSON.stringify(inner(options.inner, { version: options.version, alias: options.alias }))}\n`);
    process.exit(0);
  }
  try {
    process.exit(await host(options));
  } catch (error) {
    process.stderr.write(`dist-e2e: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
