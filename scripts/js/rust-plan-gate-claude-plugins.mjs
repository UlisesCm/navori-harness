/**
 * Plan-gate verdicts with and without `claudePlugins` in navori.config.json (#1747 follow-up):
 * the shell hook + TS CLI (`--impl shell`) against the native binary (`--impl rust`), replayed
 * over the same cases in `off` and `active` modes.
 *
 * Two families per config variant (absent, valid, invalid): the versioned plan-gate corpus
 * (stub `navori` on PATH) and the oracle's plan-gate scenarios (real `navori plan gate`).
 * The corpus is fabricated in memory and in scratch dirs, never written to the repo. Exits 1 on
 * any shell/rust difference, on a deferred real run, or if no invalid variant changes a verdict
 * (config::read would then not be exercised).
 *
 * Usage: node scripts/js/rust-plan-gate-claude-plugins.mjs
 *
 * Env:
 *   NAVORI_RUST_BIN  native binary (default: $CARGO_TARGET_DIR/debug/navori-rust).
 *
 * The repo is the checkout this script lives in. Node builtins only.
 */
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** @type {string} */
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** @type {string} */
const BIN = process.env.NAVORI_RUST_BIN ??
  join(process.env.CARGO_TARGET_DIR ?? `${process.env.HOME}/.cache/navori-rust/target-s2`, "debug", "navori-rust");
process.env.NAVORI_RUST_BIN = BIN;
/** @param {string} p script name under scripts/js @returns {Promise<any>} */
const mod = (p) => import(pathToFileURL(join(REPO, "scripts", "js", p)).href);
const replay = await mod("hook-verdict-replay.mjs");
const adapter = await mod("rust-hook-adapter.mjs");

const VARIANTS = {
  absent: undefined,
  "valid-sorted": { "a@m": true, "b@m": true },
  "valid-unsorted": { "zeta@market": true, "alpha@market": true, "Mid@market": true },
  "valid-with-false": { "b@m": false, "a@m": true },
  "valid-empty": {},
  "invalid-no-at": { noat: true },
  "invalid-non-boolean": { "a@m": "yes" },
  "invalid-non-object": ["a@m"],
  "invalid-null": null,
};
/**
 * @param {string} text navori.config.json content
 * @param {unknown} plugins `claudePlugins` value; `undefined` leaves the config untouched
 * @returns {string | undefined} the rewritten config, or `undefined` when it is not a JSON object
 */
const withPlugins = (text, plugins) => {
  if (plugins === undefined) return text;
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof config !== "object" || config === null || Array.isArray(config)) return undefined;
  return `${JSON.stringify({ ...config, claudePlugins: plugins }, null, 2)}\n`;
};

// --- Family 1: the versioned plan-gate corpus (stub `navori` on PATH) --------------------------
const corpusFile = join(REPO, "packages/cli/src/__tests__/fixtures/hook-verdict-corpus/plan-gate.sh.jsonl");
const corpus = readFileSync(corpusFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const stubCases = [];
for (const [variant, plugins] of Object.entries(VARIANTS)) {
  for (const [i, c] of corpus.entries()) {
    const fixture = [...(c.fixture ?? [])];
    const at = fixture.findIndex((f) => f.path === "navori.config.json");
    const base = at >= 0 ? fixture[at].content : '{ "name": "x", "version": "1.0.0" }\n';
    if (plugins === undefined && at < 0) {
      stubCases.push({ ...c, expected: undefined, family: "corpus", variant, label: `corpus#${i}` });
      continue;
    }
    const content = withPlugins(base, plugins) ?? base;
    if (at >= 0) fixture[at] = { ...fixture[at], content };
    else fixture.push({ path: "navori.config.json", content });
    stubCases.push({ ...c, fixture, expected: undefined, family: "corpus", variant, label: `corpus#${i}` });
  }
}

// --- Family 2: real `navori plan gate` (TS dist on PATH) with the oracle's plan-gate scenarios --
const ORACLE = join(REPO, "scripts/js/rust-oracle");
/** @param {string} dir @returns {string[]} every file below `dir` */
const walk = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const fixtureDir = join(ORACLE, "fixtures/plan-gate");
const baseFiles = walk(fixtureDir).map((p) => ({ path: relative(fixtureDir, p), content: readFileSync(p, "utf8") }));
const oracleCases = JSON.parse(readFileSync(join(ORACLE, "cases/plan.json"), "utf8")).cases
  .filter((c) => c.fixture === "plan-gate" && c.args.join(" ") === "plan gate" && c.setup.every((s) => !Array.isArray(s)));
const PICK = new Set([
  "workplan-ok", "workplan-aprobado", "workplan-rechazado", "workplan-matches", "sin-apertura", "nivel0-ok",
  "nivel0-critico", "spec-ok", "sin-plan-tiers", "config-con-aviso", "workplan-nivel2-sin-fases",
  "rol-no-implementer", "payload-roto", "codex-dispatch-ok", "codex-worker-workplan",
]);
const realCases = [];
for (const [variant, plugins] of Object.entries(VARIANTS)) {
  for (const oc of oracleCases) {
    const name = oc.id.replace(/^plan-gate:/, "");
    if (!PICK.has(name)) continue;
    const files = new Map(baseFiles.map((f) => [f.path, f.content]));
    for (const s of oc.setup) files.set(s.write, s.content);
    const config = withPlugins(files.get("navori.config.json"), plugins);
    if (config === undefined) continue;
    files.set("navori.config.json", config);
    const codex = name.startsWith("codex");
    realCases.push({
      hook: "plan-gate.sh",
      engine: codex ? "codex" : "claude",
      shell: "bash",
      input: oc.stdin,
      envDelta: {
        // The nvm-style entry is rebound to the Node-only dir (see replayToolPath).
        PATH: "@REPO@/packages/cli/node_modules/.bin:/x/.nvm/versions/node/v0/bin:/usr/bin:/bin",
        CLAUDE_PROJECT_DIR: "@CWD@",
        ...(oc.env ?? {}),
      },
      cwdKind: "repo",
      fixture: [...files].map(([path, content]) => ({ path, content })),
      family: "real", variant, label: name,
    });
  }
}

// --- Run both implementations over the same cases ------------------------------------------------
const cases = [...stubCases, ...realCases];
const shellDeps = await replay.loadDeps();
const signed = await replay.signedAssets();
const rustDeps = adapter.prepareRustReplay({
  manifestPath: join(REPO, "crates", "ported.json"),
  binary: BIN,
  scriptsRoot: signed,
});
const deferralReasons = new Map();
/** @param {"shell" | "rust"} impl @param {any} deps @param {"off" | "active"} mode @returns {any[]} */
const run = (impl, deps, mode) => {
  const scratch = replay.createScratch();
  try {
    if (impl === "shell") return replay.runMode(cases, mode, { ...deps, scratch, impl });
    // Rust: one case at a time, so a native deferral names its case instead of aborting the batch.
    return cases.map((c, i) => {
      try {
        return replay.runMode([c], mode, { ...deps, scratch, impl })[0];
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        deferralReasons.set(`${c.family}/${c.variant}/${c.label}`, reason);
        return { deferred: true, reason };
      }
    });
  } finally {
    scratch.cleanup();
  }
};
const outcome = {};
try {
  for (const mode of ["off", "active"]) {
    outcome[mode] = { shell: run("shell", shellDeps, mode), rust: run("rust", rustDeps, mode) };
  }
} finally {
  rmSync(signed, { recursive: true, force: true });
}

// --- Compare -------------------------------------------------------------------------------------
const rows = new Map();
const failures = [];
const bump = (key, field) => {
  const row = rows.get(key) ?? { cases: 0, same: 0, diff: 0, deferred: 0 };
  row[field] += 1;
  rows.set(key, row);
};
cases.forEach((c, i) => {
  const key = `${c.family.padEnd(6)} ${c.variant}`;
  for (const mode of ["off", "active"]) {
    const s = outcome[mode].shell[i];
    const r = outcome[mode].rust[i];
    bump(key, "cases");
    if (r?.deferred || s?.deferred) {
      bump(key, "deferred");
      continue;
    }
    const diff = replay.firstDifference(s, r);
    if (diff === null) bump(key, "same");
    else {
      bump(key, "diff");
      failures.push(`${c.family}/${c.variant}/${c.label} [${mode}] differs in ${diff.field}\n  shell: ${JSON.stringify(diff.expected)?.slice(0, 300)}\n  rust:  ${JSON.stringify(diff.actual)?.slice(0, 300)}`);
    }
  }
});
for (const [key, r] of rows) console.log(`${key.padEnd(34)} runs=${r.cases} identical=${r.same} different=${r.diff} deferred=${r.deferred}`);

// Does config::read matter? An invalid variant must change a real-navori verdict vs `absent`, in both impls.
const sensitivity = {};
for (const impl of ["shell", "rust"]) {
  let changed = 0;
  const byLabel = new Map();
  cases.forEach((c, i) => {
    if (c.family === "real" && c.variant === "absent") byLabel.set(c.label, outcome.off[impl][i]);
  });
  cases.forEach((c, i) => {
    if (c.family !== "real" || !c.variant.startsWith("invalid")) return;
    const base = byLabel.get(c.label);
    if (base !== undefined && replay.firstDifference(base, outcome.off[impl][i]) !== null) changed += 1;
  });
  sensitivity[impl] = changed;
}
console.log(`invalid-vs-absent verdict changes (real family, audit off): shell=${sensitivity.shell} rust=${sensitivity.rust}`);
const deferredReal = [...rows].filter(([k, r]) => k.startsWith("real") && r.deferred > 0);
for (const [key, reason] of [...deferralReasons].slice(0, 10)) console.log(`deferred: ${key}: ${reason}`);
console.log(`total runs=${cases.length * 2} binary=${BIN}`);
if (sensitivity.shell === 0 || sensitivity.rust === 0) failures.push("no invalid variant changed a verdict: config::read is not exercised");
if (deferredReal.length > 0) failures.push(`real-navori runs deferred: ${deferredReal.map(([k]) => k).join(", ")}`);
if (failures.length > 0) {
  console.error(`plan-gate claudePlugins: ${failures.length} problem(s)\n${failures.slice(0, 20).join("\n")}`);
  process.exit(1);
}
console.log("plan-gate claudePlugins: 0 differences shell vs rust");
