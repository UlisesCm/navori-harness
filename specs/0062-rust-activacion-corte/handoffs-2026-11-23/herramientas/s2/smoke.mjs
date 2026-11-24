// Legacy 0.12.5 smoke (decision of Ulises, 20 nov 11:25): run every command the native binary
// delegates to the TS on a project with and without claudePlugins, once with the packaged legacy
// (0.12.5) and once with the frozen TS of the checkout (#1747 included), and diff them.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const BIN = process.env.SMOKE_BIN;
const LEGACY = process.env.SMOKE_LEGACY; // dir with package.json + dist/
const FROZEN = process.env.SMOKE_FROZEN; // frozen TS dist/index.js of the checkout
const OUT = process.env.SMOKE_OUT;

const base = { name: "x", version: "1.0.0", engines: ["claude"], preset: "custom", language: "es", gitignoreHarness: "off" };
const VARIANTS = {
  none: base,
  valid: { ...base, claudePlugins: { "zeta@market": true, "alpha@market": false, "beta@other": true } },
  empty: { ...base, claudePlugins: {} },
  "invalid-id": { ...base, claudePlugins: { noat: true } },
  "invalid-value": { ...base, claudePlugins: { "a@m": "yes" } },
};

/** Each step: args, plus whether it is a permanent delegation (P) or a native command that may defer (N). */
const STEPS = [
  ["N", ["render", "--apply"]],
  ["N", ["status"]],
  ["N", ["doctor"]],
  ["N", ["sync", "--dry-run"]],
  ["P", ["doctor", "--json"]],
  ["P", ["master", "status"]],
  ["P", ["master", "check"]],
  ["P", ["master", "init"]],
  ["P", ["master", "status"]],
  ["P", ["codex", "trust", "--yes"]],
  ["P", ["workspace", "init", "w1", "--yes"]],
  ["P", ["workspace", "link", "w1"]],
  ["P", ["workspace", "show", "w1"]],
  ["P", ["workspace", "render", "w1"]],
  ["P", ["workspace", "render", "w1", "--apply"]],
  ["P", ["ticket", "new", "w1", "T-1"]],
  ["P", ["ticket", "list", "w1"]],
  ["P", ["registry", "add", "@REPO@"]],
  ["P", ["registry", "ls"]],
  ["P", ["registry", "scan", "@ROOT@/scan"]],
  ["P", ["backup", "restore", "@BACKUP@"]],
  ["P", ["migrations", "restore", "20260101-000000", "x"]],
  ["N", ["render"]],
];

function sh(cmd, args, opts) {
  return spawnSync(cmd, args, { encoding: "utf8", timeout: 120_000, input: "", ...opts });
}

function treeHash(dir) {
  const h = createHash("sha256");
  const walk = (d) => {
    for (const e of readdirSync(d).sort()) {
      if (e === ".git" || e === ".navori") continue;
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else h.update(p.slice(dir.length) + "\0" + readFileSync(p));
    }
  };
  walk(dir);
  return h.digest("hex").slice(0, 12);
}

function run(variant, impl) {
  const root = mkdtempSync(join(tmpdir(), `s2-smoke-${variant}-${impl}-`));
  const repo = join(root, "repo");
  const home = join(root, "home");
  const pkg = join(root, "pkg");
  mkdirSync(repo, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(join(root, "scan"), { recursive: true });
  mkdirSync(join(pkg, "bin"), { recursive: true });
  cpSync(BIN, join(pkg, "bin", "navori-rust"));
  if (impl === "legacy") cpSync(LEGACY, join(pkg, "legacy"), { recursive: true });
  sh("git", ["init", "-q", "-b", "main"], { cwd: repo });
  writeFileSync(join(repo, "navori.config.json"), JSON.stringify(VARIANTS[variant], null, 2) + "\n");
  const env = {
    PATH: `${join(pkg, "bin")}:/usr/bin:/bin:${process.execPath.replace(/\/node$/, "")}`,
    HOME: home,
    LANG: "C.UTF-8",
    NO_COLOR: "1",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
    NAVORI_AUDITS_ROOT: join(root, "audits"),
    CI: "1",
  };
  if (impl === "frozen") env.NAVORI_TS_CLI = FROZEN;
  // A backup to restore: render once, then change the language and render again.
  const results = [];
  let backup = "none";
  for (const [kind, rawArgs] of STEPS) {
    if (rawArgs[0] === "backup" && backup === "none") {
      const cfg = { ...VARIANTS[variant], language: "en" };
      writeFileSync(join(repo, "navori.config.json"), JSON.stringify(cfg, null, 2) + "\n");
      sh(join(pkg, "bin", "navori-rust"), ["render", "--apply"], { cwd: repo, env });
      writeFileSync(join(repo, "navori.config.json"), JSON.stringify(VARIANTS[variant], null, 2) + "\n");
      const list = sh(join(pkg, "bin", "navori-rust"), ["backup", "list"], { cwd: repo, env });
      backup = (list.stdout.match(/\d{8}T?-?\d{6}[\w-]*/) ?? ["none"])[0];
    }
    const args = rawArgs.map((a) => a.replace("@REPO@", repo).replace("@ROOT@", root).replace("@BACKUP@", backup));
    const r = sh(join(pkg, "bin", "navori-rust"), args, { cwd: repo, env });
    const norm = (s) => (s ?? "")
      .replaceAll(root, "@ROOT@")
      .replace(/\x1b\[[0-9;]*m/g, "")
      .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "@TS@")
      .replace(/\d{8}T?-?\d{6}[\w-]*/g, "@BACKUPID@")
      .replace(/\b\d+(\.\d+)? ?ms\b/g, "@MS@");
    let settings = null;
    try { settings = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8")).enabledPlugins ?? "(absent)"; } catch { settings = "(no settings)"; }
    results.push({ kind, args: rawArgs.join(" "), status: r.status, stdout: norm(r.stdout), stderr: norm(r.stderr), enabledPlugins: settings, tree: treeHash(repo) });
  }
  rmSync(root, { recursive: true, force: true });
  return results;
}

mkdirSync(OUT, { recursive: true });
const summary = [];
for (const variant of Object.keys(VARIANTS)) {
  const legacy = run(variant, "legacy");
  const frozen = run(variant, "frozen");
  writeFileSync(join(OUT, `${variant}.json`), JSON.stringify({ legacy, frozen }, null, 2));
  legacy.forEach((l, i) => {
    const f = frozen[i];
    const diff = [];
    if (l.status !== f.status) diff.push(`status ${l.status}≠${f.status}`);
    if (l.stdout !== f.stdout) diff.push("stdout");
    if (l.stderr !== f.stderr) diff.push("stderr");
    if (JSON.stringify(l.enabledPlugins) !== JSON.stringify(f.enabledPlugins)) diff.push(`enabledPlugins ${JSON.stringify(l.enabledPlugins)}≠${JSON.stringify(f.enabledPlugins)}`);
    if (l.tree !== f.tree) diff.push("tree");
    summary.push(`${variant.padEnd(14)} ${l.kind} ${l.args.padEnd(32)} legacy=${l.status} frozen=${f.status} ${diff.length ? "DIFF " + diff.join(", ") : "same"}`);
  });
}
writeFileSync(join(OUT, "summary.txt"), summary.join("\n") + "\n");
console.log(summary.join("\n"));
