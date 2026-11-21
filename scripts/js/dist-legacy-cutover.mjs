import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ARTIFACT_SUITES } from "./post-cutover-check.mjs";

/**
 * Rehearses the `legacy` job of rust-release.yml on the tree the cutover leaves (spec 0062 T10
 * deletes `packages/cli/src` except the artifact suites): a detached worktree of `HEAD` with only
 * `ARTIFACT_SUITES` left under `packages/cli/src`, whose
 * `packaging/legacy.json` pins `HEAD` (the commit before the cutover, as the release does). From
 * that tree it runs the job's exact command, then assembles the `navori` package with the result,
 * and checks that an empty pin there fails with its own message instead of a broken build.
 *
 *   node scripts/js/dist-legacy-cutover.mjs [--out <dir>]
 *
 * Nothing is committed or published; the worktree is removed at the end.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The `legacy` job's command (rust-release.yml), relative to the tree it runs in. */
export const JOB_ARGS = ["scripts/js/dist-assemble.mjs", "legacy", "--from-pin", "--out", "legacy-package", "--pin-out", "legacy-package/pin.json"];

function git(args, cwd = REPO_ROOT) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function node(args, cwd) {
  return spawnSync(process.execPath, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Deletes what T10 deletes: every file under `<cli>/src` outside the artifact suites (paths
 * relative to `packages/cli`, matched as prefixes). Returns how many files it kept.
 * @param {string} cli the `packages/cli` directory of the tree
 */
export function deleteTsSources(cli, suites = ARTIFACT_SUITES) {
  let kept = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (suites.some((s) => relative(cli, path).startsWith(s))) kept += 1;
      else rmSync(path);
    }
  };
  walk(join(cli, "src"));
  return kept;
}

function main(argv) {
  const outFlag = argv.indexOf("--out");
  if (outFlag >= 0 && (argv[outFlag + 1] === undefined || argv[outFlag + 1].startsWith("--"))) {
    throw new Error("--out needs a directory");
  }
  const ownOut = outFlag < 0;
  const out = ownOut ? mkdtempSync(join(tmpdir(), "navori-cutover-out-")) : resolve(argv[outFlag + 1]);
  const sha = git(["rev-parse", "HEAD"]);
  const version = JSON.parse(readFileSync(join(REPO_ROOT, "packages", "cli", "package.json"), "utf8")).version;
  const tree = mkdtempSync(join(tmpdir(), "navori-cutover-tree-"));
  rmSync(tree, { recursive: true, force: true });
  git(["worktree", "add", "--detach", tree, sha]);
  const failures = [];
  try {
    const cli = join(tree, "packages", "cli");
    const kept = deleteTsSources(cli);
    if (kept === 0) failures.push("no artifact suite survived the simulated cutover: ARTIFACT_SUITES does not match the tree");
    if (existsSync(join(cli, "src", "index.ts"))) failures.push("the simulated cutover left packages/cli/src/index.ts");
    const pinFile = join(tree, "packaging", "legacy.json");

    // 1. An empty pin after the cutover is refused up front.
    writeFileSync(pinFile, `${JSON.stringify({ version, integrity: null, commit: null }, null, 2)}\n`);
    const empty = node(emptyPinArgs(out), tree);
    if (empty.status === 0 || !empty.stderr.includes("pins no commit")) {
      failures.push(`an empty pin after the cutover did not fail with its message (exit ${empty.status}): ${empty.stderr.trim()}`);
    }

    // 2. The job's command with the pin filled in builds the pinned commit.
    writeFileSync(pinFile, `${JSON.stringify({ version, integrity: null, commit: sha }, null, 2)}\n`);
    const job = node(JOB_ARGS, tree);
    process.stdout.write(job.stdout);
    if (job.status !== 0) {
      failures.push(`the legacy job failed on the cutover tree (exit ${job.status}): ${job.stderr.trim().slice(-600)}`);
    } else {
      const report = JSON.parse(job.stdout.trim().split("\n").at(-1));
      if (report.commit !== sha) failures.push(`the legacy was built from ${report.commit}, expected the pinned ${sha}`);
      if (report.version !== version) failures.push(`the legacy is ${report.version}, expected ${version}`);

      // 3. The package job assembles `navori` with it on the same tree.
      const pkg = node(
        ["scripts/js/dist-assemble.mjs", "--out", join(out, "npm"), "--legacy-tarball", report.tarball, "--legacy-pin", join(tree, "legacy-package", "pin.json")],
        tree,
      );
      if (pkg.status !== 0) failures.push(`assembling navori on the cutover tree failed: ${pkg.stderr.trim()}`);
      else if (!existsSync(join(out, "npm", "navori", "legacy", "packages", "cli", "dist", "index.js"))) {
        failures.push("the assembled navori has no legacy/packages/cli/dist/index.js");
      }
    }
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", tree], { cwd: REPO_ROOT });
    rmSync(tree, { recursive: true, force: true });
    if (ownOut) rmSync(out, { recursive: true, force: true });
  }
  for (const f of failures) process.stderr.write(`dist-legacy-cutover: ${f}\n`);
  process.stdout.write(`dist-legacy-cutover: ${failures.length === 0 ? "green" : "FAILED"} (pinned ${sha.slice(0, 8)}, ${version})\n`);
  return failures.length === 0 ? 0 : 1;
}

/** The job's command with an empty pin, for the negative case. */
function emptyPinArgs(out) {
  return ["scripts/js/dist-assemble.mjs", "legacy", "--from-pin", "--out", join(out, "empty-pin")];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`dist-legacy-cutover: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
