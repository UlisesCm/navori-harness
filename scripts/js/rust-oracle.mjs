import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
 * @typedef {{ id: string, fixture: string, args: string[], stdin?: string, mask?: string[], files?: Record<string, string>, setup?: string[][] }} OracleCase  `files` overlay the fixture copy; `setup` runs with the TS CLI on both sides before `args`
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
 * - `provenance` (spec 0058 D23, Q11): the TS names the `core-assets` root it read; Rust reads
 *   embedded assets and prints `(embedded)`. Only the TS side's literal line `core: <root> (build
 *   copy)` (or its Spanish form) and the `--json` value `"coreRoot": "<root>"` are rewritten,
 *   with `<root>` the `assets/core` next to `tsCli`; a dev-sources or stale-core line stays visible.
 *
 * @param {string} text
 * @param {"ts" | "rust"} side
 * @param {{ tsVersion: string, rustVersion: string, tsCli: string }} ctx
 * @param {{ stream: "stdout" | "stderr" | "file", mask: string[] }} where
 */
export function maskSide(text, side, ctx, where) {
  if (side !== "rust") {
    let out = text;
    if (where.mask.includes("provenance") && where.stream === "stdout")
      out = replaceProvenance(out, ctx.tsCli);
    return where.mask.includes("version") && where.stream === "stdout"
      ? replaceVersion(out, ctx.tsVersion)
      : out;
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

/** What Rust prints in place of the TS core root. */
export const EMBEDDED_CORE = "(embedded)";

function replaceProvenance(text, tsCli) {
  const root = join(dirname(tsCli), "assets", "core");
  let out = text;
  for (const label of ["(build copy)", "(copia del build)"])
    out = out.split(`core: ${root} ${label}\n`).join(`core: ${EMBEDDED_CORE}\n`);
  return out
    .split(`"coreRoot": ${JSON.stringify(root)},\n`)
    .join(`"coreRoot": ${JSON.stringify(EMBEDDED_CORE)},\n`);
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

/** Deterministic `git init` + one commit of the fixture (D5). */
function gitInit(repo, env) {
  const identity = {
    ...env,
    GIT_AUTHOR_NAME: "oracle",
    GIT_AUTHOR_EMAIL: "oracle@example.invalid",
    GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
    GIT_COMMITTER_NAME: "oracle",
    GIT_COMMITTER_EMAIL: "oracle@example.invalid",
    GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
  };
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["add", "-A"],
    ["commit", "-q", "--no-gpg-sign", "-m", "fixture"],
  ]) {
    const run = spawnSync("git", args, { cwd: repo, env: identity, encoding: "utf8" });
    if (run.status !== 0) throw new Error(`git ${args[0]} failed in ${repo}: ${run.stderr}`);
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
 * Wipes `work`, lays out a fresh copy of the fixture and the state roots, and runs `runner`.
 *
 * @param {string} work
 * @param {Runner} runner
 * @param {OracleCase} testCase
 * @param {string} tsCli
 * @param {string} fixturesDir
 * @returns {Outcome}
 */
function runOnce(work, runner, testCase, tsCli, fixturesDir) {
  rmSync(work, { recursive: true, force: true });
  const repo = join(work, "repo");
  mkdirSync(work, { recursive: true });
  copyFixture(join(fixturesDir, testCase.fixture), repo);
  for (const [rel, text] of Object.entries(testCase.files ?? {})) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), text);
  }
  for (const dir of ["home", "tmp", "backups", "audits", "git-template/hooks", "git-template/info", "xdg"]) {
    mkdirSync(join(work, dir), { recursive: true });
  }
  writeFileSync(join(work, "gitconfig"), "");
  const env = hermeticEnv(work, tsCli);
  gitInit(repo, env);
  for (const step of testCase.setup ?? []) {
    const prep = spawnSync(process.execPath, [tsCli, ...step], { cwd: repo, env, input: "", timeout: RUN_TIMEOUT_MS });
    if (prep.status !== 0) throw new Error(`setup ${step.join(" ")} failed: ${prep.stderr}`);
  }
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
  const fixturesDir = opts.fixturesDir ?? FIXTURES_DIR;
  const work = join(opts.base, "w");
  const ts = runOnce(work, opts.ts, testCase, opts.tsCli, fixturesDir);
  const rust = runOnce(work, opts.rust, testCase, opts.tsCli, fixturesDir);
  const ctx = { tsVersion: opts.ts.version, rustVersion: opts.rust.version, tsCli: opts.tsCli };
  rmSync(work, { recursive: true, force: true });
  return {
    id: testCase.id,
    exit: ts.status,
    differences: compareOutcomes(ts, rust, ctx, testCase.mask ?? []),
  };
}

/** `computeManagedHash(body)` (`marker.ts`): sha1 of the body with CRLF/CR folded and the end trimmed. */
function managedHash(body) {
  const normalized = body.replace(/\r\n?/g, "\n").replace(/\s+$/, "");
  return createHash("sha1").update(normalized, "utf-8").digest("hex").slice(0, 8);
}

/** A managed block whose hash matches its body (so it reads as navori's, never hand-edited). */
function managedBlock(style, id, body, version) {
  const attrs = `id="${id}" hash="${managedHash(body)}"${version ? ` version="${version}"` : ""} source="@navori/core"`;
  return style === "shell"
    ? `# navori:managed start ${attrs}\n${body}\n# navori:managed end id="${id}"\n`
    : `<!-- navori:managed ${attrs} -->\n${body}\n<!-- /navori:managed id="${id}" -->\n`;
}

/** The anti-rollback levels of D26: absent, lower, equal to the checkout's CLI, higher. */
export const ANTI_ROLLBACK_LEVELS = ["absent", "lower", "equal", "higher"];

/** The operations of the matrix (D26). */
export const ANTI_ROLLBACK_OPS = ["inject", "hook", "settings", "remove"];

/**
 * The anti-rollback matrix (spec 0058 D26, T27): config floor (`harnessVersion`) × the stamp
 * on navori's own content × operation, each cell over `fresh-init` with one file overlaid whose
 * content differs from what this CLI renders:
 *
 * - `inject`: a `CLAUDE.md` block with an older body (`render --apply`);
 * - `hook`: a hook script's base block with an older body (`render --apply`);
 * - `settings`: a managed `settings.json` with an older body under `$navori.version`
 *   (`render --apply`);
 * - `remove`: the stamped `CLAUDE.md` block of an enabled plugin (`remove tgrep --yes`), where
 *   the guarded removal ignores the floor (D21).
 *
 * @param {string} cliVersion the checkout's TS CLI version (the stamp Rust also writes, D20)
 * @returns {OracleCase[]}
 */
export function antiRollbackCases(cliVersion) {
  const level = (name) =>
    ({ absent: null, lower: "0.1.0", equal: cliVersion, higher: "999.0.0" })[name];
  const base = JSON.parse(readFileSync(join(FIXTURES_DIR, "fresh-init", "navori.config.json"), "utf8"));
  /** @type {OracleCase[]} */
  const cases = [];
  for (const op of ANTI_ROLLBACK_OPS) {
    for (const floor of ANTI_ROLLBACK_LEVELS) {
      for (const marker of ANTI_ROLLBACK_LEVELS) {
        const config = { ...base };
        if (op === "remove") config.plugins = { ...base.plugins, tgrep: { enabled: true } };
        if (level(floor) === null) delete config.harnessVersion;
        else config.harnessVersion = level(floor);
        const stamp = level(marker);
        /** @type {Record<string, string>} */
        const files = { "navori.config.json": `${JSON.stringify(config, null, 2)}\n` };
        if (op === "inject") {
          files["CLAUDE.md"] = `# Notes\n\n${managedBlock("html", "idioma-rol", "Older body.", stamp)}`;
        } else if (op === "hook") {
          files[".claude/hooks/implementer-no-markdown.sh"] =
            `${managedBlock("shell", "implementer-no-markdown-base", "#!/usr/bin/env bash\nexit 0", stamp)}`;
        } else if (op === "remove") {
          files["CLAUDE.md"] = `# Notes\n\n${managedBlock("html", "tgrep-search-v2", "Older body.", stamp)}`;
        } else {
          const navori = stamp === null ? { managed: true } : { managed: true, version: stamp };
          files[".claude/settings.json"] = `${JSON.stringify({ $navori: navori, hooks: {} }, null, 2)}\n`;
        }
        cases.push({
          id: `anti-rollback:${op}:floor-${floor}:marker-${marker}`,
          fixture: "fresh-init",
          ...(op === "remove"
            ? { args: ["remove", "tgrep", "--yes"] }
            : { args: ["render", "--apply"], mask: ["provenance"] }),
          files,
        });
      }
    }
  }
  return cases;
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
  const cliVersion = JSON.parse(readFileSync(TS_VERSION_SOURCE, "utf8")).version;
  return [...casesFile.cases, ...surface, ...antiRollbackCases(cliVersion)];
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
