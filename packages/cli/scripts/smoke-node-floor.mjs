import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Smoke test of the BUILT CLI on the oldest Node the published package accepts
 * (`engines.node` in package.json, run by CI's `node-floor` job).
 *
 * Plain Node on purpose: the vitest suite cannot run there, because its global
 * setup rebuilds `dist/` with tsdown, whose own floor is above the CLI's. This
 * script only spawns `dist/index.js`, so it exercises exactly what npm ships.
 *
 * Usage: node scripts/smoke-node-floor.mjs   (after `bun run ensure-dist`)
 */

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(PKG_ROOT, "dist", "index.js");
// No `pi`: that engine has its own, higher floor (`MIN_NODE_VERSION` in engines/pi/runtime-version.ts).
const ENGINES = ["claude", "agents-md"];
const EXPECTED_FILES = ["CLAUDE.md", "AGENTS.md"];

const home = mkdtempSync(join(tmpdir(), "navori-floor-home-"));
const repo = mkdtempSync(join(tmpdir(), "navori-floor-repo-"));
const env = { ...process.env, HOME: home, NO_COLOR: "1", NAVORI_BACKUP_ROOT: join(home, "backups") };

/** Runs the CLI and fails the smoke on a non-zero exit, printing its output. */
function run(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf-8", env });
  if (r.status !== 0) {
    process.stderr.write(r.stdout + r.stderr);
    throw new Error(`navori ${args.join(" ")} exited ${r.status}`);
  }
  return r.stdout;
}

/** `render --apply --json`, returning whether any engine changed a file. */
function applyChanged() {
  const json = JSON.parse(run(["render", "--apply", "--json", "--cwd", repo]));
  return json.root.changed || (json.extraEngines ?? []).some((e) => e.written.length > 0);
}

try {
  console.log(`node ${process.version} · navori ${run(["--version"]).trim()}`);
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "floor-fixture" }), "utf-8");
  run(["init", "--yes", "--no-render", "--cwd", repo]);
  const cfgPath = join(repo, "navori.config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, engines: ENGINES }, null, 2), "utf-8");

  if (!applyChanged()) throw new Error("first render --apply wrote nothing");
  const missing = EXPECTED_FILES.filter((rel) => !existsSync(join(repo, rel)));
  if (missing.length > 0) throw new Error(`render --apply did not write: ${missing.join(", ")}`);
  if (applyChanged()) throw new Error("second render --apply was not a no-op");
  console.log(`smoke ok: ${ENGINES.join("+")} rendered and re-rendered idempotently`);
} finally {
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
}
