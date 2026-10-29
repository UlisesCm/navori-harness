import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Spec 0057 R8-R10 / D5 - differential oracle: `navori` (TS `dist/`) vs `navori-rust`.
 *
 *   node scripts/js/rust-oracle.mjs                        every case; exit 1 on any difference
 *   node scripts/js/rust-oracle.mjs --only <substring>     only the cases whose id contains it
 *   node scripts/js/rust-oracle.mjs --report <file>        also write the JSON report
 *   node scripts/js/rust-oracle.mjs --rust-bin <path>      use that binary and skip `cargo build`
 *   node scripts/js/rust-oracle.mjs --self-check           TS against itself: proves the harness is deterministic
 *
 * Prerequisite: `packages/cli/dist/` built (`bun run oracle:rust` runs `ensure-dist` first).
 *
 * Each case copies its fixture to ONE path (`<tmp>/w/repo`), runs the TS CLI, snapshots, wipes the
 * whole work dir, copies the fixture again to the SAME path and runs `navori-rust`. Path-derived
 * values (`sha256(repo + NUL + feature)`) therefore never differ and need no normalization.
 * What is compared: exit code, stdout, stderr (byte for byte), and the trees of the repo (with
 * `.git/` minus `index`, `logs/` and `objects/`), `NAVORI_BACKUP_ROOT` and `NAVORI_AUDITS_ROOT`
 * (path, type, mode, bytes). Normalization is the closed table in {@link RULES}, each rule
 * matching only the exact format the TS CLI emits.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..");
export const ORACLE_DIR = join(HERE, "rust-oracle");
export const FIXTURES_DIR = join(ORACLE_DIR, "fixtures");
export const CASES_PATH = join(ORACLE_DIR, "cases.json");
export const SURFACE_GOLDEN = join(
  REPO_ROOT,
  "packages",
  "cli",
  "src",
  "__tests__",
  "fixtures",
  "cli-surface.golden.json",
);
export const MANIFEST_PATH = join(REPO_ROOT, "crates", "ported.json");
const DEFAULT_DIST = join(REPO_ROOT, "packages", "cli", "dist", "index.js");
const TS_VERSION_SOURCE = join(REPO_ROOT, "packages", "cli", "package.json");
const CARGO_TOML = join(REPO_ROOT, "Cargo.toml");
const RUN_TIMEOUT_MS = 120_000;

/**
 * @typedef {{ name: string, token: string, apply: (text: string) => string }} Rule
 * @typedef {{ cmd: string, args: string[], version: string }} Runner  `version` feeds the notice and mask rules
 * @typedef {{ navori: string[] } | { write: string, content: string } | { git: string[] }} SetupStep
 * @typedef {{ id: string, fixture: string, args: string[], stdin?: string, mask?: string[], setup?: SetupStep[] }} OracleCase
 * @typedef {{ kind: string, detail: string }} Difference
 * @typedef {{ status: number | null, signal: string | null, stdout: Buffer, stderr: Buffer, trees: Record<string, Map<string, TreeEntry>> }} Outcome
 * @typedef {{ type: "file" | "dir" | "symlink", mode: number, bytes: Buffer }} TreeEntry
 */

/**
 * The closed normalization table (D5). Every rule recognises ONLY the exact format the TS CLI
 * emits: a changed format (`+00:00`, other precision, other hash length) stops matching and the
 * difference stays visible. Order matters: `@PID@` runs after `@BACKUP@`.
 *
 * @type {Rule[]}
 */
export const RULES = [
  {
    name: "ISO",
    token: "@ISO@",
    // toISOString()
    apply: (t) =>
      t.replace(/(?<![\dA-Za-z])\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z(?![\dA-Za-z])/g, "@ISO@"),
  },
  {
    name: "EPOCHMS",
    token: "@EPOCHMS@",
    // Date.now(), only as the value of `tsMs` / `observedAt`
    apply: (t) => t.replace(/("(?:tsMs|observedAt)"\s*:\s*)\d{13}(?![\d.])/g, "$1@EPOCHMS@"),
  },
  {
    name: "UUID",
    token: "@UUID@",
    // randomUUID(): v4, lower case
    apply: (t) =>
      t.replace(
        /(?<![\da-zA-Z])[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\da-zA-Z])/g,
        "@UUID@",
      ),
  },
  {
    name: "BACKUP",
    token: "@BACKUP@",
    // backup.ts: `<repo>-YYYY-MM-DDTHH-mm-ss-SSS-p<pid>-<seq>`; the stamp is replaced, `p<pid>` is @PID@'s
    apply: (t) =>
      t.replace(/(?<=-)\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}(?=-p\d+-\d+(?![\d]))/g, "@BACKUP@"),
  },
  {
    name: "PID",
    token: "@PID@",
    // only inside @BACKUP@ and as the value of the JSON key `pid`
    apply: (t) =>
      t
        .replace(/(?<=@BACKUP@-p)\d+(?=-\d+(?![\d]))/g, "@PID@")
        .replace(/("pid"\s*:\s*)\d+(?![\d.])/g, "$1@PID@"),
  },
  {
    name: "MS",
    token: "@MS@",
    // `navori bench` summary rows: `min|p50|p95|max <n>.<d>ms`
    apply: (t) => t.replace(/\b(min|p50|p95|max)(\s+)\d+(?:\.\d+)?ms\b/g, "$1$2@MS@"),
  },
];

/**
 * Side-specific masks. They exist because `navori-rust` is an internal prerelease whose version
 * differs from the TS CLI's, which is observable in exactly two places. They are NOT part of
 * {@link RULES}: they take literal values (never a pattern), they touch ONE side, and `version`
 * only applies to cases that list it in `mask`.
 *
 * - `notice`: the one-line delegation warning (D3) `navori-rust` prints before `exec`.
 * - `version`: the Rust version in the stdout of a command that runs natively.
 *
 * @param {string} text
 * @param {"ts" | "rust"} side
 * @param {{ tsVersion: string, rustVersion: string, tsCli: string }} ctx
 * @param {{ stream: "stdout" | "stderr" | "file", mask: string[] }} where
 */
export function maskSide(text, side, ctx, where) {
  if (side !== "rust") {
    return where.mask.includes("version") && where.stream === "stdout"
      ? replaceVersion(text, ctx.tsVersion)
      : text;
  }
  let out = text;
  if (where.stream === "stderr") {
    const notice = `navori-rust: warning: delegating to TS navori ${ctx.tsVersion} at ${ctx.tsCli} (navori-rust is ${ctx.rustVersion})\n`;
    if (ctx.rustVersion !== ctx.tsVersion) out = out.replace(notice, "");
  }
  if (where.mask.includes("version") && where.stream === "stdout")
    out = replaceVersion(out, ctx.rustVersion);
  return out;
}

function replaceVersion(text, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`(?<![\\d.+-])${escaped}(?![\\w.+-])`, "g"), "@VERSION@");
}

/**
 * Applies the closed table to text.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeText(text) {
  let out = text;
  for (const rule of RULES) out = rule.apply(out);
  return out;
}

/**
 * Normalizes a buffer when it is valid UTF-8; binary content is compared as is.
 *
 * @param {Buffer} bytes
 * @param {(text: string) => string} fn
 * @returns {Buffer}
 */
function mapBuffer(bytes, fn) {
  const text = bytes.toString("utf8");
  if (Buffer.from(text, "utf8").equals(bytes)) return Buffer.from(fn(text), "utf8");
  return bytes;
}

/**
 * Snapshot of a directory: path, type, mode and bytes of every entry, symlinks not followed.
 *
 * @param {string} root
 * @param {(rel: string, type: "file" | "dir" | "symlink") => boolean} [skip] true to leave an entry (and its subtree) out
 * @returns {Map<string, TreeEntry>}
 */
export function snapshotTree(root, skip = () => false) {
  /** @type {Map<string, TreeEntry>} */
  const out = new Map();
  if (!existsSync(root)) return out;
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const rel = relative(root, full).split(sep).join("/");
      const stat = lstatSync(full);
      const type = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "dir" : "file";
      if (skip(rel, type)) continue;
      const mode = stat.mode & 0o7777;
      if (type === "symlink") {
        out.set(rel, { type, mode, bytes: Buffer.from(readlinkSync(full)) });
      } else if (type === "dir") {
        out.set(rel, { type, mode, bytes: Buffer.alloc(0) });
        walk(full);
      } else {
        out.set(rel, { type, mode, bytes: readFileSync(full) });
      }
    }
  };
  walk(root);
  return out;
}

/** `.git/` minus `index`, `logs/` and `objects/` (D5). */
function skipGitNoise(rel) {
  return rel === ".git/index" || rel === ".git/logs" || rel === ".git/objects";
}

/**
 * First differing byte offset of two buffers, or -1 when equal.
 *
 * @param {Buffer} a
 * @param {Buffer} b
 */
function firstDiff(a, b) {
  if (a.equals(b)) return -1;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) if (a[i] !== b[i]) return i;
  return n;
}

function preview(bytes, at) {
  return JSON.stringify(bytes.subarray(Math.max(0, at - 20), at + 40).toString("utf8"));
}

/**
 * Compares two byte streams.
 *
 * @param {string} kind
 * @param {Buffer} a
 * @param {Buffer} b
 * @returns {Difference[]}
 */
export function compareBytes(kind, a, b) {
  const at = firstDiff(a, b);
  if (at === -1) return [];
  return [
    {
      kind,
      detail: `first difference at byte ${at} (ts ${a.length} bytes, rust ${b.length} bytes): ts ${preview(a, at)} vs rust ${preview(b, at)}`,
    },
  ];
}

/**
 * Compares two snapshots after normalizing paths and text contents with `norm`.
 *
 * @param {string} root name of the tree (`repo`, `backups`, `audits`)
 * @param {Map<string, TreeEntry>} ts
 * @param {Map<string, TreeEntry>} rust
 * @param {(text: string) => string} norm
 * @returns {Difference[]}
 */
export function compareTrees(root, ts, rust, norm = (t) => t) {
  const rekey = (tree) => new Map([...tree].map(([path, entry]) => [norm(path), entry]));
  const a = rekey(ts);
  const b = rekey(rust);
  /** @type {Difference[]} */
  const diffs = [];
  for (const path of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const left = a.get(path);
    const right = b.get(path);
    if (!left || !right) {
      diffs.push({
        kind: `tree:${root}`,
        detail: `${path}: only in ${left ? "ts" : "rust"}`,
      });
      continue;
    }
    if (left.type !== right.type) {
      diffs.push({ kind: `tree:${root}`, detail: `${path}: type ${left.type} vs ${right.type}` });
      continue;
    }
    if (left.mode !== right.mode) {
      diffs.push({
        kind: `tree:${root}`,
        detail: `${path}: mode ${left.mode.toString(8)} vs ${right.mode.toString(8)}`,
      });
    }
    const lb = left.type === "file" ? mapBuffer(left.bytes, norm) : left.bytes;
    const rb = right.type === "file" ? mapBuffer(right.bytes, norm) : right.bytes;
    for (const d of compareBytes(`tree:${root}`, lb, rb)) {
      diffs.push({ kind: d.kind, detail: `${path}: ${d.detail}` });
    }
  }
  return diffs;
}

/**
 * Compares the two outcomes of one case.
 *
 * @param {Outcome} ts
 * @param {Outcome} rust
 * @param {{ tsVersion: string, rustVersion: string, tsCli: string }} ctx
 * @param {string[]} mask
 * @returns {Difference[]}
 */
export function compareOutcomes(ts, rust, ctx, mask = []) {
  /** @type {Difference[]} */
  const diffs = [];
  if (ts.status !== rust.status || ts.signal !== rust.signal) {
    diffs.push({
      kind: "exit",
      detail: `ts ${ts.status ?? ts.signal} vs rust ${rust.status ?? rust.signal}`,
    });
  }
  for (const stream of /** @type {const} */ (["stdout", "stderr"])) {
    const side = (outcome, which) =>
      mapBuffer(outcome[stream], (t) => normalizeText(maskSide(t, which, ctx, { stream, mask })));
    diffs.push(...compareBytes(stream, side(ts, "ts"), side(rust, "rust")));
  }
  for (const root of Object.keys(ts.trees)) {
    diffs.push(...compareTrees(root, ts.trees[root], rust.trees[root] ?? new Map(), normalizeText));
  }
  return diffs;
}

/**
 * Hermetic environment of a case (D5): nothing inherited but `PATH`, every state root in the work
 * dir, no `GIT_*` from the caller, no TTY (stdin is a pipe).
 *
 * @param {string} work
 * @param {string} tsCli
 * @returns {Record<string, string>}
 */
export function hermeticEnv(work, tsCli) {
  return {
    PATH: process.env.PATH ?? "",
    HOME: join(work, "home"),
    USERPROFILE: join(work, "home"),
    TMPDIR: join(work, "tmp"),
    TMP: join(work, "tmp"),
    TEMP: join(work, "tmp"),
    NAVORI_BACKUP_ROOT: join(work, "backups"),
    NAVORI_AUDITS_ROOT: join(work, "audits"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(work, "gitconfig"),
    GIT_TEMPLATE_DIR: join(work, "git-template"),
    XDG_CONFIG_HOME: join(work, "xdg"),
    // Node prints `(node:<pid>) ExperimentalWarning` to stderr; that pid is not navori output.
    NODE_NO_WARNINGS: "1",
    NAVORI_NO_UPDATE_NOTIFIER: "1",
    NO_COLOR: "1",
    NAVORI_TS_CLI: tsCli,
    TZ: "UTC",
    LC_ALL: "C",
  };
}

/** Runs git in `repo` with a fixed identity and dates; throws on failure. */
function git(repo, env, args) {
  const identity = {
    ...env,
    GIT_AUTHOR_NAME: "oracle",
    GIT_AUTHOR_EMAIL: "oracle@example.invalid",
    GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
    GIT_COMMITTER_NAME: "oracle",
    GIT_COMMITTER_EMAIL: "oracle@example.invalid",
    GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
  };
  const run = spawnSync("git", args, { cwd: repo, env: identity, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`git ${args[0]} failed in ${repo}: ${run.stderr}`);
}

/** Deterministic `git init` + one commit of the fixture (D5). */
function gitInit(repo, env) {
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["add", "-A"],
    ["commit", "-q", "--no-gpg-sign", "-m", "fixture"],
  ]) {
    git(repo, env, args);
  }
}

/**
 * Applies a case's `setup` in its repo: `navori` steps run the TS CLI (state both sides start
 * from), `write` lays a file, `git` runs git. Any failure aborts the case.
 *
 * @param {string} repo
 * @param {Record<string, string>} env
 * @param {Runner} ts
 * @param {SetupStep[]} steps
 */
function applySetup(repo, env, ts, steps) {
  for (const step of steps) {
    if ("navori" in step) {
      const run = spawnSync(ts.cmd, [...ts.args, ...step.navori], { cwd: repo, env, input: "" });
      if (run.status !== 0)
        throw new Error(`setup navori ${step.navori.join(" ")} failed: ${run.stdout}${run.stderr}`);
    } else if ("write" in step) {
      const path = join(repo, step.write);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, step.content);
    } else {
      git(repo, env, step.git);
    }
  }
}

/**
 * Copies a fixture tree. A file stored as `<name>.fixture` lands as `<name>`: fixtures that are
 * Markdown (`CLAUDE.md`, `AGENTS.md`) are kept under that suffix so the repo's Markdown tooling and
 * ownership rules do not treat them as docs.
 *
 * @param {string} from
 * @param {string} to
 */
export function copyFixture(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const name = entry.name.endsWith(".fixture") ? entry.name.slice(0, -".fixture".length) : entry.name;
    const target = join(to, name);
    if (entry.isDirectory()) copyFixture(join(from, entry.name), target);
    else cpSync(join(from, entry.name), target, { verbatimSymlinks: true });
  }
}

/**
 * Wipes `work` and lays out a fresh copy of the fixture, the state roots and the case's setup.
 *
 * @param {string} work
 * @param {OracleCase} testCase
 * @param {{ ts: Runner, tsCli: string, fixturesDir: string }} opts
 */
function layout(work, testCase, opts) {
  rmSync(work, { recursive: true, force: true });
  const repo = join(work, "repo");
  mkdirSync(work, { recursive: true });
  copyFixture(join(opts.fixturesDir, testCase.fixture), repo);
  for (const dir of ["home", "tmp", "backups", "audits", "git-template/hooks", "git-template/info", "xdg"]) {
    mkdirSync(join(work, dir), { recursive: true });
  }
  writeFileSync(join(work, "gitconfig"), "");
  const env = hermeticEnv(work, opts.tsCli);
  gitInit(repo, env);
  applySetup(repo, env, opts.ts, testCase.setup ?? []);
}

/**
 * Lays out `work` (from `template` when given: a setup's output is laid out once, so files it
 * names after the clock are the same for both runners) and runs `runner`.
 *
 * @param {string} work
 * @param {Runner} runner
 * @param {OracleCase} testCase
 * @param {{ ts: Runner, tsCli: string, fixturesDir: string, template?: string }} opts
 * @returns {Outcome}
 */
function runOnce(work, runner, testCase, opts) {
  if (opts.template) {
    rmSync(work, { recursive: true, force: true });
    cpSync(opts.template, work, { recursive: true, verbatimSymlinks: true });
  } else {
    layout(work, testCase, opts);
  }
  const repo = join(work, "repo");
  const env = hermeticEnv(work, opts.tsCli);
  const run = spawnSync(runner.cmd, [...runner.args, ...testCase.args], {
    cwd: repo,
    env,
    input: testCase.stdin ?? "",
    maxBuffer: 256 * 1024 * 1024,
    timeout: RUN_TIMEOUT_MS,
  });
  if (run.error) throw new Error(`cannot run ${runner.cmd}: ${run.error.message}`);
  return {
    status: run.status,
    signal: run.signal,
    stdout: run.stdout,
    stderr: run.stderr,
    trees: {
      repo: snapshotTree(repo, skipGitNoise),
      backups: snapshotTree(join(work, "backups")),
      audits: snapshotTree(join(work, "audits")),
    },
  };
}

/**
 * Runs one case with both runners, sequentially on the same path, and compares.
 *
 * @param {OracleCase} testCase
 * @param {{ ts: Runner, rust: Runner, tsCli: string, base: string, fixturesDir?: string }} opts
 * @returns {{ id: string, exit: number | null, differences: Difference[] }}
 */
export function runCase(testCase, opts) {
  const layoutOpts = { ts: opts.ts, tsCli: opts.tsCli, fixturesDir: opts.fixturesDir ?? FIXTURES_DIR };
  const work = join(opts.base, "w");
  if (testCase.setup) {
    layoutOpts.template = join(opts.base, "template");
    layout(work, testCase, layoutOpts);
    rmSync(layoutOpts.template, { recursive: true, force: true });
    cpSync(work, layoutOpts.template, { recursive: true, verbatimSymlinks: true });
  }
  const ts = runOnce(work, opts.ts, testCase, layoutOpts);
  const rust = runOnce(work, opts.rust, testCase, layoutOpts);
  if (layoutOpts.template) rmSync(layoutOpts.template, { recursive: true, force: true });
  const ctx = { tsVersion: opts.ts.version, rustVersion: opts.rust.version, tsCli: opts.tsCli };
  rmSync(work, { recursive: true, force: true });
  return {
    id: testCase.id,
    exit: ts.status,
    differences: compareOutcomes(ts, rust, ctx, testCase.mask ?? []),
  };
}

/**
 * Cases to run: the hand-written ones plus one per entry of the CLI surface golden. A surface case
 * whose args are a native command of the manifest masks the Rust version (see {@link maskSide}).
 *
 * @param {{ casesPath?: string, goldenPath?: string, manifestPath?: string }} [paths]
 * @returns {OracleCase[]}
 */
export function loadCases(paths = {}) {
  const casesFile = JSON.parse(readFileSync(paths.casesPath ?? CASES_PATH, "utf8"));
  const golden = JSON.parse(readFileSync(paths.goldenPath ?? SURFACE_GOLDEN, "utf8"));
  const manifest = JSON.parse(readFileSync(paths.manifestPath ?? MANIFEST_PATH, "utf8"));
  const native = new Set(manifest.commands.map((c) => c.path.join(" ")));
  const surface = golden.cases.map((c) => ({
    id: `surface:${c.args.join("_")}`,
    fixture: casesFile.surfaceFixture,
    args: c.args,
    ...(native.has(c.args.join(" ")) ? { mask: ["version"] } : {}),
  }));
  return [...casesFile.cases, ...surface];
}

/** `version` of the workspace package in the root `Cargo.toml`. */
function rustVersion() {
  const m = /^\[workspace\.package\][^[]*?^version\s*=\s*"([^"]+)"/ms.exec(readFileSync(CARGO_TOML, "utf8"));
  if (!m) throw new Error("cannot read [workspace.package].version from Cargo.toml");
  return m[1];
}

function flagValue(argv, name) {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

/**
 * CLI entry point.
 *
 * @param {string[]} argv
 * @returns {number} exit code: 0 no differences, 1 differences, 2 cannot run
 */
export function main(argv) {
  const dist = process.env.NAVORI_TS_CLI || DEFAULT_DIST;
  if (!existsSync(dist)) {
    process.stderr.write(`rust-oracle: ${dist} not found; build it first (bun run ensure-dist)\n`);
    return 2;
  }
  const tsVersion = JSON.parse(readFileSync(TS_VERSION_SOURCE, "utf8")).version;
  const selfCheck = argv.includes("--self-check");
  const ts = { cmd: process.execPath, args: [dist], version: tsVersion };
  let rust = ts;
  if (!selfCheck) {
    let bin = flagValue(argv, "--rust-bin");
    if (!bin) {
      const build = spawnSync("cargo", ["build", "-p", "navori-cli", "--locked", "--quiet"], {
        cwd: REPO_ROOT,
        stdio: "inherit",
      });
      if (build.status !== 0) {
        process.stderr.write("rust-oracle: cargo build failed\n");
        return 2;
      }
      bin = join(process.env.CARGO_TARGET_DIR ?? join(REPO_ROOT, "target"), "debug", "navori-rust");
    }
    rust = { cmd: resolve(bin), args: [], version: rustVersion() };
  }
  const only = flagValue(argv, "--only");
  const cases = loadCases().filter((c) => !only || c.id.includes(only));
  if (cases.length === 0) {
    process.stderr.write("rust-oracle: no case matches\n");
    return 2;
  }
  const base = realpathSync(mkdtempSync(join(tmpdir(), "navori-rust-oracle-")));
  /** @type {Array<{ id: string, exit: number | null, differences: Difference[] }>} */
  const results = [];
  try {
    for (const testCase of cases) {
      const result = runCase(testCase, { ts, rust, tsCli: dist, base });
      results.push(result);
      for (const d of result.differences) {
        process.stdout.write(`DIFF ${result.id} [${d.kind}] ${d.detail}\n`);
      }
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
  const total = results.reduce((n, r) => n + r.differences.length, 0);
  const report = { cases: results.length, differences: total, results };
  const reportPath = flagValue(argv, "--report");
  if (reportPath) writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`rust-oracle: ${results.length} cases, ${total} differences\n`);
  return total === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
