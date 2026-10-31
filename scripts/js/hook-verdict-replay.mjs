import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize as normalizePath, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prepareRustReplay, runRustHook } from "./rust-hook-adapter.mjs";

/**
 * Spec 0055 R13 / D2 — hook verdict corpus: generation, replay and coverage.
 *
 *   node scripts/js/hook-verdict-replay.mjs                  replay; exit 1 at the FIRST case whose
 *                                                            exit, stdout, stderr (or audit event) differs
 *   node scripts/js/hook-verdict-replay.mjs --shell zsh      replay every case under that shell (D9 parity)
 *   node scripts/js/hook-verdict-replay.mjs --coverage       per-hook cases and % of the invocations the tests make
 *   node scripts/js/hook-verdict-replay.mjs --impl rust --only hook.sh
 *                                                         direct native replay of a ported hook; audit active
 *                                                         compares the event Rust drops in the session spool
 *   node scripts/js/hook-verdict-replay.mjs --generate <dir> [--hook a.sh,b.sh] build the corpus from the raw capture of
 *                                                            `NAVORI_HOOK_CORPUS=<dir> vitest run`
 *
 * A case is `{ hook, engine, shell, input, envDelta, cwdKind, expected: { off, active } }`. The hook
 * is a core asset name, re-expanded from `packages/core/core-assets/hooks` and installed under the
 * engine's directory of a scratch project, so an edit to a hook or a partial is what gets replayed.
 * `cwdKind: "repo"` runs in the scratch project (the checkout stand-in); `"none"` in an empty,
 * non-git directory. `expected.off` is the run with no audit root; `expected.active` has the
 * session log and spool dir of the payload's `session_id` (a fixed one is added when the payload
 * has none, see {@link withActiveSession}), and carries the audit events written (`tsMs` and
 * `ms` masked). Cases are replayed with `runHookBatch`; each has its own copy of the project and its
 * own audit root, so lanes can run in parallel without one case's state or events reaching another.
 * Only regenerate with a spec that changes verdicts on purpose.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI_SRC = join(REPO_ROOT, "packages", "cli", "src");
export const CORPUS_DIR = join(CLI_SRC, "__tests__", "fixtures", "hook-verdict-corpus");
const HOOKS_SOURCE = join(REPO_ROOT, "packages", "core", "core-assets", "hooks");
const ENGINE_DIRS = { claude: ".claude/hooks", codex: ".codex/hooks", pi: ".pi/navori/hooks" };
const MIN_COVERAGE_PCT = 60;
const MODES = ["off", "active"];

/**
 * @typedef {{ status: number, stdout: string, stderr: string }} Verdict
 * @typedef {Verdict & { event: unknown[] }} ActiveVerdict
 * @typedef {{ hook: string, engine: string, shell: string, input: string, envDelta: Record<string, string>, cwdKind: "none" | "repo", args?: string[], fixture?: Array<{ path: string, content: string, mode?: number }> }} CaseKey
 * @typedef {CaseKey & { expected: { off: Verdict, active: ActiveVerdict } }} CorpusCase
 * @typedef {{ impl: "shell" | "rust", modes: string[], all: boolean, stable: boolean, coverage: boolean, only?: string[], shell?: string, generate?: string }} ReplayArgs
 */

/** Stable identity of a case: the same invocation recorded twice is one case. */
export function caseKey(c) {
  const key = [c.hook, c.engine, c.shell, c.cwdKind, c.input, Object.entries(c.envDelta).sort()];
  // Hook arguments (spec 0059 T5) join the key only when present: argument-less keys, and so the
  // order of every corpus recorded before them, stay as they were.
  const hasArgs = c.args !== undefined && c.args.length > 0;
  const hasFixture = c.fixture !== undefined && c.fixture.length > 0;
  if (hasArgs || hasFixture) key.push(c.args ?? []);
  if (hasFixture) key.push(c.fixture);
  return JSON.stringify(key);
}

/**
 * Folds raw capture lines into unique cases plus the per-hook coverage denominator.
 *
 * @param {Array<CaseKey & { status: "included" | "excluded", reason?: string }>} lines
 * @returns {{ cases: CaseKey[], observed: Record<string, { observed: number, included: number, excluded: Record<string, number> }> }}
 */
export function mergeRaw(lines) {
  /** @type {Map<string, CaseKey>} */
  const included = new Map();
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {Record<string, { observed: number, included: number, excluded: Record<string, number> }>} */
  const observed = {};
  for (const line of lines) {
    const key = `${line.status}:${caseKey(line)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const slot = (observed[line.hook] ??= { observed: 0, included: 0, excluded: {} });
    slot.observed += 1;
    if (line.status === "included") {
      slot.included += 1;
      const { hook, engine, shell, input, envDelta, cwdKind, args, fixture } = line;
      included.set(caseKey(line), {
        hook, engine, shell, input, envDelta, cwdKind,
        ...(args !== undefined && args.length > 0 ? { args } : {}),
        ...(fixture !== undefined && fixture.length > 0 ? { fixture } : {}),
      });
    } else {
      const reason = line.reason ?? "unknown";
      slot.excluded[reason] = (slot.excluded[reason] ?? 0) + 1;
    }
  }
  const cases = [...included.values()].sort((a, b) => caseKey(a).localeCompare(caseKey(b)));
  return { cases, observed };
}

/**
 * Masks what changes per run in an audit event: `tsMs` (13-digit epoch) and `ms` (duration).
 *
 * @param {unknown} event parsed spool file
 * @returns {unknown}
 */
export function normalizeEvent(event) {
  const metadata = event?.metadata;
  if (typeof metadata !== "object" || metadata === null) return event;
  const tsMs = /^\d{13}$/.test(String(metadata.tsMs)) ? "<int13>" : metadata.tsMs;
  const ms = Number.isInteger(metadata.ms) && metadata.ms >= 0 ? "<int>=0" : metadata.ms;
  return { ...event, metadata: { ...metadata, tsMs, ms } };
}

/**
 * Masks the line number of shell diagnostics (bash `: line 12:`, zsh `file:12:`): it shifts whenever
 * a partial grows and says nothing about the verdict. Applied only to stderr on both sides.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function maskShellLines(value) {
  if (typeof value !== "string") return value;
  return value.replace(/: line \d+:/g, ": line N:").replace(/(\.sh):\d+:/g, "$1: line N:");
}

/**
 * First field in which `actual` differs from `expected`, or `null` when they are identical.
 *
 * @param {Verdict | ActiveVerdict} expected
 * @param {Verdict | ActiveVerdict} actual
 * @returns {{ field: string, expected: unknown, actual: unknown } | null}
 */
export function firstDifference(expected, actual) {
  for (const field of ["status", "stdout", "stderr", "event"]) {
    if (!(field in expected) && !(field in actual)) continue;
    const text = field === "stderr";
    const [e, a] = text
      ? [maskShellLines(expected[field]), maskShellLines(actual[field])]
      : [expected[field], actual[field]];
    if (JSON.stringify(e) !== JSON.stringify(a)) {
      return { field, expected: expected[field], actual: actual[field] };
    }
  }
  return null;
}

/**
 * Canonical form of the diagnostics a shell writes about itself, so a case captured under bash can be
 * compared with its zsh run (D9): bash says `<script>: line 50: cat: command not found` and
 * `<script>: line 9: <path>: No such file or directory`; zsh says `<script>:50: command not found: cat`
 * and `<script>:9: no such file or directory: <path>`. Anything else is compared byte for byte.
 *
 * @param {string} text stderr
 * @returns {string}
 */
export function normalizeShellDiagnostics(text) {
  return text
    .split("\n")
    .map((line) => {
      const bashNotFound = /^(.*?): line \d+: (.*): command not found$/.exec(line);
      if (bashNotFound) return `${bashNotFound[1]}: <shell>: command not found: ${bashNotFound[2]}`;
      const zshNotFound = /^(.*?):\d+: command not found: (.*)$/.exec(line);
      if (zshNotFound) return `${zshNotFound[1]}: <shell>: command not found: ${zshNotFound[2]}`;
      const bashMissing = /^(.*?): line \d+: (.*): No such file or directory$/.exec(line);
      if (bashMissing) return `${bashMissing[1]}: <shell>: no such file or directory: ${bashMissing[2]}`;
      const zshMissing = /^(.*?):\d+: no such file or directory: (.*)$/.exec(line);
      if (zshMissing) return `${zshMissing[1]}: <shell>: no such file or directory: ${zshMissing[2]}`;
      return line;
    })
    .join("\n");
}

/**
 * Hooks whose source has an unrendered `{{placeholder}}` standing alone as a command line (the
 * rendered hook gets policy code there). Replayed unrendered, bash only fails at that line when it
 * runs it while zsh rejects the whole file at parse time, so a cross-shell comparison of them is
 * parsing noise, not hook behavior.
 *
 * @param {string} hook core asset name
 * @returns {boolean}
 */
export function hasPlaceholderCommand(hook) {
  return /^\{\{[^}]+\}\}[ \t]*$/m.test(readFileSync(join(HOOKS_SOURCE, hook), "utf8"));
}

/**
 * Per-hook coverage rows: unique corpus cases, and their share of the invocations the tests make.
 *
 * @param {CaseKey[]} cases
 * @param {Record<string, { observed: number }>} observed
 * @returns {Array<{ hook: string, cases: number, observed: number, pct: number }>}
 */
export function coverageRows(cases, observed) {
  const counts = new Map();
  for (const c of cases) counts.set(c.hook, (counts.get(c.hook) ?? 0) + 1);
  const hooks = new Set([...counts.keys(), ...Object.keys(observed)]);
  return [...hooks].sort().map((hook) => {
    const total = observed[hook]?.observed ?? 0;
    const n = counts.get(hook) ?? 0;
    return { hook, cases: n, observed: total, pct: total === 0 ? 0 : Math.round((n / total) * 1000) / 10 };
  });
}

const sh = (text, token, value) => text.replaceAll(token, value);

/** Scratch project, tmp, home, empty cwd and local `navori` bin shared by every replay run. */
export function createScratch() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "navori-replay-")));
  const dirs = { root, project: join(root, "project"), tmp: join(root, "tmp"), home: join(root, "home"), none: join(root, "none"), bin: join(root, "bin"), nodeBin: join(root, "node-bin"), audits: join(root, "audits") };
  for (const dir of [dirs.project, dirs.tmp, dirs.home, dirs.none, dirs.bin, dirs.nodeBin]) mkdirSync(dir, { recursive: true });
  symlinkSync(process.execPath, join(dirs.nodeBin, "node"));
  dirs.cases = join(root, "cases");
  if (existsSync(join(REPO_ROOT, "navori.config.json"))) copyFileSync(join(REPO_ROOT, "navori.config.json"), join(dirs.project, "navori.config.json"));
  spawnSync("git", ["init", "-q"], { cwd: dirs.project, env: { PATH: process.env.PATH ?? "", HOME: dirs.home } });
  const dist = join(REPO_ROOT, "packages", "cli", "dist", "index.js");
  if (existsSync(dist)) symlinkSync(dist, join(dirs.bin, "navori"));
  // `project` is the template every "repo" case copies: a case never sees another's state files.
  return { ...dirs, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * Rebinds recorded tool directories in place, preserving shim priority and deliberately absent tools.
 * The Node directory contains only Node, so it cannot expose a host's global CLI to negative cases.
 *
 * @param {string} path recorded PATH before token expansion
 * @param {ReturnType<typeof createScratch>} scratch isolated tools
 * @returns {string}
 */
function replayToolPath(path, scratch) {
  return path.split(":").map((entry) => {
    if (entry === "@REPO@/packages/cli/node_modules/.bin") return scratch.bin;
    if (/\/\.nvm\/versions\/node\/v[^/]+\/bin$/.test(entry)) return scratch.nodeBin;
    return entry;
  }).join(":");
}

/**
 * The active mode needs a session to log against: a JSON object payload without a valid
 * `session_id` gets the fixed one below, so the audit path of every hook is exercised. The
 * transform is part of the replay definition, so base and branch see the same bytes.
 */
export const ACTIVE_SESSION = "corpus-active";
export function withActiveSession(input) {
  try {
    const payload = JSON.parse(input);
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return input;
    if (typeof payload.session_id === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(payload.session_id)) return input;
    return JSON.stringify({ ...payload, session_id: ACTIVE_SESSION });
  } catch {
    return input;
  }
}

/** Audit-repo name the hooks derive from a cwd (mirrors `navori_audit_repo_from_cwd`). */
function auditRepoOf(cwd) {
  const cut = cwd.replace(/\/\.claude\/worktrees(\/.*)?$/, "");
  return basename(cut);
}

/** Creates the session log and spool dir the payload's `session_id` needs; returns the spool dir or null. */
function armAudit(root, input, fallbackCwd) {
  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    return null;
  }
  const id = payload?.session_id;
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(id)) return null;
  const repo = auditRepoOf(typeof payload.cwd === "string" && payload.cwd !== "" ? payload.cwd : fallbackCwd);
  if (repo === "" || repo === "." || repo === ".." || /[^A-Za-z0-9_.-]/.test(repo)) return null;
  const spool = join(root, repo, `spool-${id}`);
  mkdirSync(spool, { recursive: true, mode: 0o700 });
  chmodSync(spool, 0o700);
  writeFileSync(join(root, repo, `session-${id}.log`), "");
  return spool;
}

/** Spool files of one case as normalized events. */
function readEvents(spool) {
  if (spool === null || !existsSync(spool)) return [];
  return readdirSync(spool)
    .sort()
    .map((name) => normalizeEvent(JSON.parse(readFileSync(join(spool, name), "utf8"))));
}

/**
 * Runs `cases` in one mode and returns one verdict per case, in order.
 *
 * @param {CaseKey[]} cases
 * @param {"off" | "active"} mode
 * @param {{ resolveHook: (hook: string, engine: string, scratch: ReturnType<typeof createScratch>) => string, runHookBatch?: Function, binary?: string, timeoutMs?: number, impl?: "shell" | "rust", scratch: ReturnType<typeof createScratch> }} deps
 * @returns {Array<Verdict | ActiveVerdict>}
 */
export function runMode(cases, mode, { resolveHook, runHookBatch, binary, timeoutMs, impl = "shell", scratch }) {
  const results = new Array(cases.length);
  const baseline = { PATH: [scratch.bin, scratch.nodeBin, process.env.PATH ?? ""].join(":"), HOME: scratch.home, TMPDIR: scratch.tmp };
  for (const key of ["LANG", "LC_ALL", "LC_CTYPE", "TERM"]) if (process.env[key] !== undefined) baseline[key] = process.env[key];
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, baseline);
  // Audit root and working dir are per case: events and state files are never mixed between cases,
  // which is why the batch can run its lanes in parallel in both modes.
  rmSync(scratch.audits, { recursive: true, force: true });
  rmSync(scratch.cases, { recursive: true, force: true });
  /** @type {Array<{ project: string, root: string }>} */
  const paths = new Array(cases.length);
  const spools = new Array(cases.length).fill(null);
  /** @type {Map<string, number[]>} */
  const groups = new Map();
  cases.forEach((c, i) => {
    const group = `${c.hook}\0${c.engine}\0${c.shell}`;
    groups.set(group, [...(groups.get(group) ?? []), i]);
  });
  const hostPaths = (text, project, cwd) =>
    sh(sh(sh(sh(text, "@CWD@", cwd), "@REPO@", project), "@TMP@", scratch.tmp), "@R@", "XXXXXX");
  const normalize = (text, i) =>
    text
      .replaceAll(paths[i].project, "@REPO@")
      .replaceAll(paths[i].root, "@CASE@")
      .replaceAll(scratch.tmp, "@TMP@")
      .replaceAll(scratch.home, "@HOME@")
      .replaceAll(scratch.root, "@SCRATCH@");
  try {
    for (const indexes of groups.values()) {
      const first = cases[indexes[0]];
      const hookPath = resolveHook(first.hook, first.engine, scratch);
      const batchCases = indexes.map((i) => {
        const c = cases[i];
        const caseRoot = join(scratch.cases, String(i));
        const project = join(caseRoot, "project");
        if (c.cwdKind === "repo") cpSync(scratch.project, project, { recursive: true });
        else mkdirSync(join(caseRoot, "none"), { recursive: true });
        paths[i] = { project, root: caseRoot };
        const cwd = c.cwdKind === "repo" ? project : join(caseRoot, "none");
        // Declared state (spec 0059 T5): recreated under the case's own cwd before it runs.
        for (const file of c.fixture ?? []) {
          if (isAbsolute(file.path) || normalizePath(file.path).split("/").includes("..")) throw new Error(`fixture escapes the case: ${file.path}`);
          const target = join(cwd, file.path);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, hostPaths(file.content, project, cwd));
          chmodSync(target, file.mode ?? 0o644);
        }
        const auditsRoot = join(scratch.audits, String(i));
        const env = Object.fromEntries(Object.entries(c.envDelta).map(([k, v]) => [k, hostPaths(k === "PATH" ? replayToolPath(v, scratch) : v, project, cwd)]));
        const input = mode === "active" ? withActiveSession(hostPaths(c.input, project, cwd)) : hostPaths(c.input, project, cwd);
        if (mode === "active") {
          mkdirSync(auditsRoot, { recursive: true });
          spools[i] = armAudit(auditsRoot, input, cwd);
        }
        env.NAVORI_AUDITS_ROOT = mode === "active" ? auditsRoot : join(scratch.root, "no-audits");
        const args = (c.args ?? []).map((arg) => hostPaths(arg, project, cwd));
        return { input, env, cwd, args };
      });
      const outputs = impl === "rust" ? batchCases.map((c, n) => {
        const result = runRustHook({ binary, script: hookPath, timeoutMs, ...c });
        if (result.modeDeferred) return { deferred: true };
        // Only where the recorded shell also died on the missing tool (`command not found`).
        if (result.toolDeferred && cases[indexes[n]].expected?.[mode]?.status === 127) {
          return { deferred: true, tool: true };
        }
        if (!result.available) throw new Error(`native unavailable: ${first.hook}: ${result.reason}`);
        // The corpus stores text. Reject malformed UTF-8 instead of hiding byte differences
        // through replacement characters; the adapter itself retains the original bytes.
        const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
        return { status: result.status, stdout: decoder.decode(result.stdout), stderr: decoder.decode(result.stderr) };
      }) : runHookBatch(hookPath, first.shell, batchCases);
      indexes.forEach((i, n) => {
        const out = outputs[n];
        if (out.deferred) {
          results[i] = { deferred: true, tool: out.tool === true };
          return;
        }
        // The native lane runs the signed asset outside the scratch; Bash names `$0` in its
        // diagnostics, so that copy reads as the installed one the shell lane runs.
        const signedRoot = impl === "rust" && hookPath.endsWith(`/${ENGINE_DIRS[first.engine]}/${first.hook}`)
          ? hookPath.slice(0, -`/${ENGINE_DIRS[first.engine]}/${first.hook}`.length)
          : undefined;
        const asInstalled = (text) => (signedRoot === undefined ? text : text.replaceAll(signedRoot, join(scratch.root, "installed")));
        const verdict = { status: out.status, stdout: normalize(asInstalled(out.stdout), i), stderr: normalize(asInstalled(out.stderr), i) };
        results[i] = mode === "active" ? { ...verdict, event: readEvents(spools[i]) } : verdict;
      });
    }
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(scratch.cases, { recursive: true, force: true });
  }
  return results;
}

/** Loads the TS helpers and the hook expander (Node strips the types). */
export async function loadDeps() {
  const batch = await import(pathToFileURL(join(CLI_SRC, "__tests__", "helpers", "hook-batch.ts")).href);
  const { corpusAsset } = await import("./corpus-asset.mjs");
  const resolveHook = (hook, engine, scratch) => {
    // Outside the project (cases copy it); hooks only read `$0` to tell the engines apart.
    const target = join(scratch.root, "installed", ENGINE_DIRS[engine], hook);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, corpusAsset(HOOKS_SOURCE, hook));
    chmodSync(target, 0o755);
    return target;
  };
  return { runHookBatch: batch.runHookBatch, resolveHook };
}

/** Reads every `raw-*.jsonl` of a capture directory. */
function readRaw(dir) {
  return readdirSync(dir)
    .filter((name) => /^raw-.*\.jsonl$/.test(name))
    .flatMap((name) =>
      readFileSync(join(dir, name), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    );
}

/**
 * Builds the corpus from a raw capture: expected output with the audit off and active, one
 * `<hook>.jsonl` per hook plus `coverage.json`. A case whose two runs differ (a clock, a random id
 * in the output) is dropped and counted as unstable. `only` limits the run to some hooks (their
 * files and coverage entries are replaced, the others kept), so a long generation can be split.
 *
 * @param {string} rawDir
 * @param {string} [outDir]
 * @param {string[]} [only] hook file names
 * @param {boolean} [stable] run each mode twice and drop unstable cases
 */
export async function generateCorpus(rawDir, outDir = CORPUS_DIR, only, stable = false) {
  const merged = mergeRaw(readRaw(rawDir));
  const wanted = (hook) => only === undefined || only.includes(hook);
  const cases = merged.cases.filter((c) => wanted(c.hook));
  if (cases.length === 0) throw new Error("selection contains no corpus cases");
  const observed = merged.observed;
  const deps = await loadDeps();
  const scratch = createScratch();
  try {
    const run = (mode) => runMode(cases, mode, { ...deps, scratch });
    // One pass per mode by default (the replay is the second run and fails on an unstable case);
    // `stable: true` runs each mode twice and drops cases whose runs differ.
    const off1 = run("off");
    const active1 = run("active");
    const [off2, active2] = stable ? [run("off"), run("active")] : [off1, active1];
    /** @type {Map<string, CorpusCase[]>} */
    const byHook = new Map();
    cases.forEach((c, i) => {
      const stable = !firstDifference(off1[i], off2[i]) && !firstDifference(active1[i], active2[i]);
      if (stable) byHook.set(c.hook, [...(byHook.get(c.hook) ?? []), { ...c, expected: { off: off1[i], active: active1[i] } }]);
      else (observed[c.hook].unstable = (observed[c.hook].unstable ?? 0) + 1);
    });
    const generated = [...byHook.values()].flat().length;
    if (generated === 0) throw new Error("generation produced no stable corpus cases");
    mkdirSync(outDir, { recursive: true });
    const coveragePath = join(outDir, "coverage.json");
    const coverage = existsSync(coveragePath) ? JSON.parse(readFileSync(coveragePath, "utf8")) : {};
    const hooks = new Set([...readdirSync(HOOKS_SOURCE).filter((n) => n.endsWith(".sh")), ...Object.keys(observed)]);
    for (const hook of [...hooks].sort().filter(wanted)) {
      const kept = byHook.get(hook) ?? [];
      const entry = observed[hook] ?? { observed: 0, included: 0, excluded: {} };
      // A hook with no case says why: the reasons its invocations were excluded, or that no test runs it.
      if (kept.length === 0) entry.note = Object.keys(entry.excluded).join(", ") || "never invoked by a test";
      coverage[hook] = entry;
      const file = join(outDir, `${hook}.jsonl`);
      if (kept.length > 0) writeFileSync(file, kept.map((c) => JSON.stringify(c)).join("\n") + "\n");
      else rmSync(file, { force: true });
    }
    writeFileSync(coveragePath, `${JSON.stringify(coverage, null, 2)}\n`);
    return { cases: generated, candidates: cases.length };
  } finally {
    scratch.cleanup();
  }
}

/**
 * Replays the corpus; stops at the first case that differs.
 *
 * `shell` replays every case under that shell instead of the one it was captured with, against the
 * same expected output (spec 0055 D9: the zsh parity net); `all` reports every differing case
 * instead of stopping at the first. Across shells, stderr is compared in shell-neutral form
 * ({@link normalizeShellDiagnostics}) and hooks with a placeholder command are skipped.
 *
 * Native mode uses NAVORI_RUST_BIN (otherwise navori-rust on PATH) and NAVORI_RUST_HOOKS_DIR
 * containing renderer-prepared engine hook directories or, without it, the expanded assets the
 * corpus recorded, signed for the binary ({@link signedAssets}). No live shell result can stand
 * in for a native verdict.
 *
 * @param {{ corpus?: CorpusCase[], modes?: string[], only?: string[], shell?: string, all?: boolean, impl?: "shell" | "rust", deps?: Awaited<ReturnType<typeof loadDeps>> }} [options]
 * @returns {Promise<{ ok: boolean, cases: number, deferred?: number, toolDeferred?: number, failure?: string }>}
 */
export async function replayCorpus({ corpus, modes = MODES, deps, only, shell, all = false, impl = "shell" } = {}) {
  const cases = (corpus ?? readCorpus())
    .filter((c) => only === undefined || only.includes(c.hook))
    .filter((c) => shell === undefined || shell === c.shell || !hasPlaceholderCommand(c.hook))
    .map((c) => (shell === undefined ? c : { ...c, shell, capturedShell: c.shell }));
  if (!["shell", "rust"].includes(impl) || modes.length === 0 || modes.some((mode) => !MODES.includes(mode))) {
    return { ok: false, cases: cases.length, failure: "invalid implementation or audit mode" };
  }
  if (cases.length === 0) return { ok: false, cases: 0, failure: "selection contains no corpus cases" };
  let deferred = 0;
  let toolDeferred = 0;
  /** @type {string[]} */
  const failures = [];
  let resolved;
  /** @type {string | undefined} */
  let signed;
  try {
    // Native preflight cannot be replaced by shell test dependencies.
    resolved = impl === "rust" ? prepareRustReplay({
      manifestPath: join(REPO_ROOT, "crates", "ported.json"),
      binary: process.env.NAVORI_RUST_BIN ?? "navori-rust",
      scriptsRoot: process.env.NAVORI_RUST_HOOKS_DIR ?? (signed = await signedAssets()),
    }) : deps ?? (await loadDeps());
  } catch (error) {
    if (signed !== undefined) rmSync(signed, { recursive: true, force: true });
    return { ok: false, cases: cases.length, failure: error instanceof Error ? error.message : "native preflight failed" };
  }
  const scratch = createScratch();
  try {
    for (const mode of modes) {
      const actual = runMode(cases, mode, { ...resolved, scratch, impl });
      for (let i = 0; i < cases.length; i += 1) {
        // A mode the binary defers by design (D31), or a call whose shell lacks a required text
        // tool, runs the shell in production: not compared.
        if (actual[i]?.deferred) {
          if (mode === modes[0] && actual[i].tool) toolDeferred += 1;
          else if (mode === modes[0]) deferred += 1;
          continue;
        }
        const cross = cases[i].capturedShell !== undefined && cases[i].capturedShell !== cases[i].shell;
        const diff = firstDifference(
          cross ? withShellDiagnostics(cases[i].expected[mode]) : cases[i].expected[mode],
          cross ? withShellDiagnostics(actual[i]) : actual[i],
        );
        if (diff === null) continue;
        const c = cases[i];
        const clip = (v) => JSON.stringify(v)?.slice(0, 400);
        const failure =
          `case ${i + 1}/${cases.length} (${c.hook}, ${c.engine}, ${c.shell}, audit ${mode}) differs in ${diff.field}\n` +
          `  input:    ${clip(c.input)}\n  expected: ${clip(diff.expected)}\n  actual:   ${clip(diff.actual)}`;
        if (!all) return { ok: false, cases: cases.length, failure };
        failures.push(failure);
      }
    }
    if (failures.length > 0) return { ok: false, cases: cases.length, failure: failures.join("\n") };
    const counts = { ...(deferred > 0 ? { deferred } : {}), ...(toolDeferred > 0 ? { toolDeferred } : {}) };
    return { ok: true, cases: cases.length - deferred - toolDeferred, ...counts };
  } catch (error) {
    return { ok: false, cases: cases.length, failure: error instanceof Error ? error.message : "replay execution failed" };
  } finally {
    scratch.cleanup();
    if (signed !== undefined) rmSync(signed, { recursive: true, force: true });
  }
}

/**
 * Without NAVORI_RUST_HOOKS_DIR the binary runs the bytes the corpus recorded: each registered
 * hook's expanded asset, signed in a fresh temporary directory the caller removes.
 *
 * @returns {Promise<string>}
 */
export async function signedAssets() {
  const { writeSignedAssets } = await import("./rust-replay-assets.mjs");
  const dir = mkdtempSync(join(tmpdir(), "navori-rust-assets-"));
  try {
    return writeSignedAssets(dir);
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/** Verdict with its stderr in the shell-neutral form of {@link normalizeShellDiagnostics}. */
const withShellDiagnostics = (verdict) => ({ ...verdict, stderr: normalizeShellDiagnostics(verdict.stderr) });

/** The committed corpus: every `<hook>.jsonl` of the directory. */
export function readCorpus(dir = CORPUS_DIR) {
  const files = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort() : [];
  if (files.length === 0) throw new Error(`no hook corpus in ${dir}; capture it with --generate`);
  const cases = files.flatMap((name) => readFileSync(join(dir, name), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)));
  if (cases.length === 0) throw new Error("hook corpus contains no cases");
  return cases;
}

/** Prints the per-hook coverage of the committed corpus. */
function printCoverage() {
  const cases = readCorpus();
  const observed = JSON.parse(readFileSync(join(CORPUS_DIR, "coverage.json"), "utf8"));
  /** @type {Record<string, number>} */
  const engines = { claude: 0, codex: 0, pi: 0 };
  for (const c of cases) engines[c.engine] = (engines[c.engine] ?? 0) + 1;
  process.stdout.write(
    `hook-verdict-replay coverage: ${cases.length} cases (${Object.entries(engines).map(([e, n]) => `${e}=${n}`).join(" ")})\n`,
  );
  const perEngine = (hook) =>
    ["claude", "codex", "pi"].map((e) => `${e}=${cases.filter((c) => c.hook === hook && c.engine === e).length}`).join(" ");
  for (const row of coverageRows(cases, observed)) {
    const note = observed[row.hook]?.note;
    const low = row.pct < MIN_COVERAGE_PCT ? `  < 60%: no test rewrite that cuts cases before replay passes (D2)${note ? ` [${note}]` : ""}` : "";
    process.stdout.write(`  ${row.hook.padEnd(32)} cases=${String(row.cases).padStart(5)} observed=${String(row.observed).padStart(5)} ${row.pct.toFixed(1).padStart(5)}%  ${perEngine(row.hook)}${low}\n`);
  }
}

/**
 * Strict CLI options: unsupported flags and empty selections can never report green.
 * @param {string[]} argv
 * @returns {ReplayArgs}
 */
export function parseReplayArgs(argv) {
  /** @type {ReplayArgs} */
  const options = { impl: "shell", modes: MODES, all: false, stable: false, coverage: false };
  /** @type {Set<string>} */
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const key = flag === "--only" ? "--hook" : flag;
    if (seen.has(key)) throw new Error(`duplicate option ${flag}`);
    seen.add(key);
    if (["--all", "--check-stable", "--coverage"].includes(flag)) {
      options[flag === "--all" ? "all" : flag === "--coverage" ? "coverage" : "stable"] = true;
      continue;
    }
    if (!["--impl", "--audit", "--only", "--hook", "--shell", "--generate"].includes(flag)) {
      throw new Error(`unknown option ${flag}`);
    }
    const value = argv[++i];
    if (value === undefined || value === "" || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    switch (flag) {
      case "--impl":
        if (!["shell", "rust"].includes(value)) throw new Error("--impl must be shell or rust");
        options.impl = value;
        break;
      case "--audit":
        if (!MODES.includes(value)) throw new Error("--audit must be off or active");
        options.modes = [value];
        break;
      case "--only":
      case "--hook":
        options.only = value.split(",");
        if (options.only.some((hook) => !/^[A-Za-z0-9_-]+(?:\.sh)?$/.test(hook))) throw new Error("hook selection must contain nonempty hook names");
        options.only = options.only.map((hook) => hook.endsWith(".sh") ? hook : `${hook}.sh`);
        break;
      case "--shell":
        if (!["bash", "zsh"].includes(value)) throw new Error("--shell must be bash or zsh");
        options.shell = value;
        break;
      case "--generate":
        options.generate = value;
        break;
    }
  }
  if (options.stable && options.generate === undefined) throw new Error("--check-stable requires --generate");
  if (options.generate !== undefined && (options.coverage || seen.has("--impl") || seen.has("--audit") || options.shell !== undefined || options.all)) {
    throw new Error("--generate cannot be combined with replay or coverage options");
  }
  if (options.coverage && seen.size !== 1) throw new Error("--coverage cannot be combined with other options");
  if (options.impl === "rust" && options.shell !== undefined) throw new Error("--shell applies only to shell replay");
  return options;
}

/**
 * CLI entry point, with every selected mode visible in the success summary.
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function main(argv) {
  const options = parseReplayArgs(argv);
  if (options.generate !== undefined) {
    const result = await generateCorpus(resolve(options.generate), CORPUS_DIR, options.only, options.stable);
    process.stdout.write(`hook-verdict-replay: wrote ${result.cases} cases (${result.candidates} candidates)\n`);
    return 0;
  }
  if (options.coverage) {
    printCoverage();
    return 0;
  }
  const result = await replayCorpus(options);
  if (!result.ok) {
    process.stderr.write(`hook-verdict-replay: ${result.failure}\n`);
    return 1;
  }
  const deferredNote =
    (result.deferred ? `, ${result.deferred} deferred by mode to the shell (D31)` : "") +
    (result.toolDeferred ? `, ${result.toolDeferred} deferred for a missing text tool` : "");
  process.stdout.write(`hook-verdict-replay: ${result.cases} cases identical (${options.impl === "rust" ? "impl rust, " : ""}audit ${options.modes.join(" and ")}${deferredNote})\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`hook-verdict-replay: ${error instanceof Error ? error.message : "invalid invocation"}\n`);
    process.exit(1);
  }
}
