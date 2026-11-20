import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Rehearses the `legacy` job of rust-release.yml on the tree the cutover leaves (spec 0062 T10
 * deletes `packages/cli/src`): a detached worktree of `HEAD` without `packages/cli/src`, whose
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

function main(argv) {
  const outFlag = argv.indexOf("--out");
  const out = outFlag >= 0 ? resolve(argv[outFlag + 1]) : mkdtempSync(join(tmpdir(), "navori-cutover-out-"));
  const sha = git(["rev-parse", "HEAD"]);
  const version = JSON.parse(readFileSync(join(REPO_ROOT, "packages", "cli", "package.json"), "utf8")).version;
  const tree = mkdtempSync(join(tmpdir(), "navori-cutover-tree-"));
  rmSync(tree, { recursive: true, force: true });
  git(["worktree", "add", "--detach", tree, sha]);
  const failures = [];
  try {
    rmSync(join(tree, "packages", "cli", "src"), { recursive: true, force: true });
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
  process.exitCode = main(process.argv.slice(2));
}
