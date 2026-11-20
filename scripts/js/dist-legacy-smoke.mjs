#!/usr/bin/env node
// Legacy package smoke (spec 0062, R22): runs the commands the native binary delegates to the
// frozen TS (23 steps x 5 configs) against a fake package `<root>/pkg/{bin,legacy}` and asserts
// that the frozen TS leaves a rendered project untouched, keeps `enabledPlugins` and rejects an
// invalid `claudePlugins` with the schema error.
//
// Usage: node scripts/js/dist-legacy-smoke.mjs --binary <navori-rust> --legacy-tarball <tgz> [--keep] [--json]
// Dependency-free (node: builtins only).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Stable substring of the frozen TS config error for an invalid `claudePlugins` (the issue list names the key only in some commands). */
const SCHEMA_ERROR = "Validation failed";
const SORTED_PLUGINS = { "alpha@market": false, "beta@other": true, "zeta@market": true };

const base = { name: "x", version: "1.0.0", engines: ["claude"], preset: "custom", language: "es", gitignoreHarness: "off" };

/** @type {Record<string, { config: object, valid: boolean, plugins: boolean }>} */
const VARIANTS = {
  none: { config: base, valid: true, plugins: false },
  valid: { config: { ...base, claudePlugins: { "zeta@market": true, "alpha@market": false, "beta@other": true } }, valid: true, plugins: true },
  empty: { config: { ...base, claudePlugins: {} }, valid: true, plugins: false },
  "invalid-id": { config: { ...base, claudePlugins: { noat: true } }, valid: false, plugins: false },
  "invalid-value": { config: { ...base, claudePlugins: { "a@m": "yes" } }, valid: false, plugins: false },
};

/**
 * `native`: the binary handles it (exit 0 on valid configs). `delegated`: runs in the legacy TS.
 * `mayFail`: exits 1 legitimately with the frozen TS (no state or `--yes` missing).
 * @type {Array<{ kind: "native" | "delegated", args: string[], mayFail?: boolean }>}
 */
const STEPS = [
  { kind: "native", args: ["render", "--apply"] },
  { kind: "native", args: ["status"] },
  { kind: "native", args: ["doctor"] },
  { kind: "native", args: ["sync", "--dry-run"] },
  { kind: "delegated", args: ["doctor", "--json"] },
  { kind: "delegated", args: ["master", "status"] },
  { kind: "delegated", args: ["master", "check"], mayFail: true },
  { kind: "delegated", args: ["master", "init"], mayFail: true },
  { kind: "delegated", args: ["master", "status"] },
  { kind: "delegated", args: ["codex", "trust", "--yes"], mayFail: true },
  { kind: "delegated", args: ["workspace", "init", "w1", "--yes"] },
  { kind: "delegated", args: ["workspace", "link", "w1"] },
  { kind: "delegated", args: ["workspace", "show", "w1"] },
  { kind: "delegated", args: ["workspace", "render", "w1"] },
  { kind: "delegated", args: ["workspace", "render", "w1", "--apply"] },
  { kind: "delegated", args: ["ticket", "new", "w1", "T-1"] },
  { kind: "delegated", args: ["ticket", "list", "w1"] },
  { kind: "delegated", args: ["registry", "add", "@REPO@"] },
  { kind: "delegated", args: ["registry", "ls"] },
  { kind: "delegated", args: ["registry", "scan", "@ROOT@/scan"] },
  { kind: "delegated", args: ["backup", "restore", "@BACKUP@"], mayFail: true },
  { kind: "delegated", args: ["migrations", "restore", "20260101-000000", "x"], mayFail: true },
  { kind: "native", args: ["render"] },
];

/** Invalid configs: these steps must exit 1 with the schema error. */
const INVALID_FAILS = new Set(["render --apply", "status", "doctor", "sync --dry-run", "doctor --json", "master status"]);

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {import("node:child_process").SpawnSyncOptionsWithStringEncoding} [opts]
 */
function sh(cmd, args, opts) {
  return spawnSync(cmd, args, { encoding: "utf8", timeout: 120_000, input: "", ...opts });
}

/** Hash of the repo tree excluding `.git` and `.navori`. @param {string} dir */
function treeHash(dir) {
  const h = createHash("sha256");
  const walk = (/** @type {string} */ d) => {
    for (const e of readdirSync(d).sort()) {
      if (e === ".git" || e === ".navori") continue;
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else h.update(`${p.slice(dir.length)}\0`).update(readFileSync(p));
    }
  };
  walk(dir);
  return h.digest("hex").slice(0, 12);
}

/** @param {string} repo @returns {unknown} */
function readPlugins(repo) {
  try {
    const s = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8"));
    return s.enabledPlugins ?? "(absent)";
  } catch {
    return "(no settings)";
  }
}

/**
 * Runs the 23 steps for one config and returns the list of failures.
 * @param {string} name
 * @param {string} binary
 * @param {string} legacyDir
 * @param {boolean} keep
 * @returns {{ rows: Array<{ variant: string, step: string, exit: number | null, ok: boolean }>, failures: string[], root: string }}
 */
function runVariant(name, binary, legacyDir, keep) {
  const { valid, plugins, config } = VARIANTS[name];
  const root = mkdtempSync(join(tmpdir(), `legacy-smoke-${name}-`));
  const repo = join(root, "repo");
  const pkg = join(root, "pkg");
  for (const d of [repo, join(root, "home"), join(root, "scan"), join(pkg, "bin")]) mkdirSync(d, { recursive: true });
  const bin = join(pkg, "bin", "navori-rust");
  cpSync(binary, bin);
  cpSync(legacyDir, join(pkg, "legacy"), { recursive: true });
  sh("git", ["init", "-q", "-b", "main"], { cwd: repo });
  const writeConfig = (/** @type {object} */ c) => writeFileSync(join(repo, "navori.config.json"), `${JSON.stringify(c, null, 2)}\n`);
  writeConfig(config);
  const env = {
    PATH: `${join(pkg, "bin")}:/usr/bin:/bin:${dirname(process.execPath)}`,
    HOME: join(root, "home"),
    LANG: "C.UTF-8",
    NO_COLOR: "1",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
    NAVORI_AUDITS_ROOT: join(root, "audits"),
    CI: "1",
  };
  /** @type {string[]} */
  const failures = [];
  const rows = [];
  let backup = "none";
  let baseline = "";
  for (const step of STEPS) {
    const label = step.args.join(" ");
    if (step.args[0] === "backup" && backup === "none") {
      // Render once with another language so a backup exists, then restore the config.
      writeConfig({ ...config, language: "en" });
      sh(bin, ["render", "--apply"], { cwd: repo, env });
      writeConfig(config);
      const list = sh(bin, ["backup", "list"], { cwd: repo, env });
      backup = (list.stdout.match(/\d{8}T?-?\d{6}[\w-]*/) ?? ["none"])[0];
    }
    const args = step.args.map((a) => a.replace("@REPO@", repo).replace("@ROOT@", root).replace("@BACKUP@", backup));
    const r = sh(bin, args, { cwd: repo, env });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.replaceAll(root, "<root>").replace(/\x1b\[[0-9;]*m/g, "");
    const fail = (/** @type {string} */ msg) => failures.push(`[${name}] ${label}: ${msg}`);
    const exit = r.status;
    let ok = true;
    const bad = (/** @type {string} */ msg) => {
      ok = false;
      fail(msg);
    };

    if (out.includes("no TS CLI found")) bad("not delegated to the legacy (\"no TS CLI found\")");
    if (r.signal || (valid && (/^\s+at .+:\d+:\d+/m.test(out) || out.includes("TypeError")))) bad(`crashed (${r.signal ?? "stack trace"}): ${out.slice(0, 200)}`);

    if (valid) {
      if (step.kind === "native" && exit !== 0) bad(`exit ${exit}, expected 0: ${out.slice(0, 200)}`);
      if (step.kind === "delegated" && !step.mayFail && exit !== 0) bad(`exit ${exit}, expected 0: ${out.slice(0, 200)}`);
      if (step.mayFail && exit !== 0 && exit !== 1) bad(`exit ${exit}, expected 0 or 1`);
      if (label === "workspace link w1" && exit === 0) {
        // Link rewrites the config: let the binary render the linked project, then freeze it.
        sh(bin, ["render", "--apply"], { cwd: repo, env });
        baseline = treeHash(repo);
      }
      if (label === "workspace render w1 --apply" && exit === 0) {
        if (!/\b0 changed\b/.test(out)) bad(`did not report "0 changed" over an up-to-date project: ${out.slice(0, 300)}`);
        if (treeHash(repo) !== baseline) bad("rewrote files of an up-to-date project (tree hash changed)");
      }
      if (label === "doctor --json" && exit === 0) {
        try {
          const j = JSON.parse(r.stdout);
          if (j.renderPending !== 0) bad(`renderPending ${j.renderPending}, expected 0`);
        } catch {
          bad("doctor --json is not JSON");
        }
      }
      const found = readPlugins(repo);
      const want = plugins ? SORTED_PLUGINS : "(absent)";
      if (JSON.stringify(found) !== JSON.stringify(want)) bad(`enabledPlugins ${JSON.stringify(found)}, expected ${JSON.stringify(want)}`);
    } else if (INVALID_FAILS.has(label)) {
      if (exit !== 1) bad(`exit ${exit}, expected 1`);
      if (!out.includes(SCHEMA_ERROR)) bad(`output lacks the schema error "${SCHEMA_ERROR}": ${out.slice(0, 200)}`);
    } else if (step.mayFail ? exit !== 0 && exit !== 1 : false) {
      bad(`exit ${exit}, expected 0 or 1`);
    }
    rows.push({ variant: name, step: label, exit, ok });
  }
  if (!keep) rmSync(root, { recursive: true, force: true });
  return { rows, failures, root };
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{ binary?: string, tarball?: string, keep: boolean, json: boolean }} */
  const o = { keep: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--binary") o.binary = argv[++i];
    else if (a === "--legacy-tarball") o.tarball = argv[++i];
    else if (a === "--keep") o.keep = true;
    else if (a === "--json") o.json = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!o.binary || !o.tarball) throw new Error("usage: dist-legacy-smoke.mjs --binary <navori-rust> --legacy-tarball <tgz> [--keep] [--json]");
  return o;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const binary = resolve(/** @type {string} */ (o.binary));
  const stage = mkdtempSync(join(tmpdir(), "legacy-smoke-tar-"));
  const x = sh("tar", ["-xzf", resolve(/** @type {string} */ (o.tarball)), "-C", stage, "package/navori"]);
  if (x.status !== 0) throw new Error(`cannot extract package/navori from the tarball: ${x.stderr}`);
  const legacyDir = join(stage, "package", "navori");
  /** @type {Array<{ variant: string, step: string, exit: number | null, ok: boolean }>} */
  const rows = [];
  /** @type {string[]} */
  const failures = [];
  try {
    for (const name of Object.keys(VARIANTS)) {
      const r = runVariant(name, binary, legacyDir, o.keep);
      rows.push(...r.rows);
      failures.push(...r.failures);
      if (o.keep) console.error(`kept ${r.root}`);
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  if (o.json) {
    console.log(JSON.stringify({ ok: failures.length === 0, steps: rows.length, rows, failures }, null, 2));
  } else {
    console.log("variant        step                                   exit  result");
    for (const r of rows) console.log(`${r.variant.padEnd(14)} ${r.step.padEnd(38)} ${String(r.exit).padEnd(5)} ${r.ok ? "ok" : "FAIL"}`);
    for (const f of failures) console.error(`FAIL ${f}`);
    console.log(`\n${rows.length} steps, ${failures.length} failure(s)`);
  }
  process.exit(failures.length === 0 ? 0 : 1);
}

try {
  main();
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
