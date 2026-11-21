import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ARTIFACT_SUITES } from "./post-cutover-check.mjs";

/**
 * Rehearses the `legacy` job of rust-release.yml on the tree the cutover leaves (spec 0062 T10
 * deletes `packages/cli/src` except the artifact suites). In a detached worktree of `HEAD` (the
 * commit before the cutover, which the release pins) it deletes the TS sources like T10, fills
 * `packaging/legacy.json` with that commit and commits the result locally (`git commit-tree`; no
 * branch moves), so the tree's `HEAD` is a cutover commit without TS. From there:
 *
 * 1. an empty pin is refused with its own message;
 * 2. the job's command, read from the workflow, builds the pinned commit, not the tree's `HEAD`;
 * 3. the package job assembles `navori` with that legacy;
 * 4. the previous command, `--from HEAD`, fails in the build, so the rehearsal tells the fix from
 *    the bug.
 *
 *   node scripts/js/dist-legacy-cutover.mjs [--out <dir>]
 *
 * Nothing is pushed or published; the worktree and its commit are discarded at the end.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const WORKFLOW = join(".github", "workflows", "rust-release.yml");

/**
 * The `legacy` job's `dist-assemble.mjs legacy` command, read from the workflow so the rehearsal
 * runs exactly what CI runs: the arguments after `node`, split on whitespace (the line has no
 * quoting).
 * @param {string} workflow the text of rust-release.yml
 * @returns {string[]}
 */
export function jobArgs(workflow) {
  const lines = [...workflow.matchAll(/^\s*- run: node (scripts\/js\/dist-assemble\.mjs legacy\b.*)$/gm)];
  if (lines.length !== 1) {
    throw new Error(`${WORKFLOW} must run dist-assemble.mjs legacy exactly once, found ${lines.length}`);
  }
  return lines[0][1].trim().split(/\s+/);
}

/** The command the job ran before #1764: it builds the tree's own `HEAD`. */
function fromHeadArgs(out) {
  return ["scripts/js/dist-assemble.mjs", "legacy", "--from", "HEAD", "--out", join(out, "from-head")];
}

/** The job's command with an empty pin, for the negative case. */
function emptyPinArgs(out) {
  return ["scripts/js/dist-assemble.mjs", "legacy", "--from-pin", "--out", join(out, "empty-pin")];
}

function git(args, cwd = REPO_ROOT, env = process.env) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env });
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

/** A fixed identity for the local cutover commit, so it does not depend on the runner's git config. */
const REHEARSAL_IDENTITY = {
  GIT_AUTHOR_NAME: "cutover rehearsal",
  GIT_AUTHOR_EMAIL: "rehearsal@navori.invalid",
  GIT_COMMITTER_NAME: "cutover rehearsal",
  GIT_COMMITTER_EMAIL: "rehearsal@navori.invalid",
};

function main(argv) {
  const outFlag = argv.indexOf("--out");
  if (outFlag >= 0 && (argv[outFlag + 1] === undefined || argv[outFlag + 1].startsWith("--"))) {
    throw new Error("--out needs a directory");
  }
  const ownOut = outFlag < 0;
  const out = ownOut ? mkdtempSync(join(tmpdir(), "navori-cutover-out-")) : resolve(argv[outFlag + 1]);
  const pinned = git(["rev-parse", "HEAD"]);
  const version = JSON.parse(readFileSync(join(REPO_ROOT, "packages", "cli", "package.json"), "utf8")).version;
  const tree = mkdtempSync(join(tmpdir(), "navori-cutover-tree-"));
  rmSync(tree, { recursive: true, force: true });
  git(["worktree", "add", "--detach", tree, pinned]);
  const failures = [];
  let cut = pinned;
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

    // The cutover commit: TS deleted, pin on the commit before it. `commit-tree` runs no hooks and
    // moves no branch; only this worktree's HEAD points at it.
    writeFileSync(pinFile, `${JSON.stringify({ version, integrity: null, commit: pinned }, null, 2)}\n`);
    git(["add", "--all"], tree);
    const treeId = git(["write-tree"], tree);
    cut = git(["commit-tree", treeId, "-p", pinned, "-m", "rehearsal: cutover (T10)"], tree, { ...process.env, ...REHEARSAL_IDENTITY });
    git(["update-ref", "--no-deref", "HEAD", cut], tree);
    if (git(["status", "--porcelain"], tree) !== "") failures.push("the cutover commit left the tree dirty");

    // 2. The job's command builds the pinned commit, not the tree's HEAD.
    const job = node(jobArgs(readFileSync(join(tree, WORKFLOW), "utf8")), tree);
    process.stdout.write(job.stdout);
    if (job.status !== 0) {
      failures.push(`the legacy job failed on the cutover tree (exit ${job.status}): ${job.stderr.trim().slice(-600)}`);
    } else {
      const report = JSON.parse(job.stdout.trim().split("\n").at(-1));
      if (report.commit !== pinned) {
        failures.push(`the legacy was built from ${report.commit}, expected the pinned ${pinned} (the tree's HEAD is ${cut})`);
      }
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

    // 4. The old command builds the cutover HEAD and must fail there, in the build.
    const head = node(fromHeadArgs(out), tree);
    if (head.status === 0) {
      failures.push("`legacy --from HEAD` passed on the cutover tree: the rehearsal cannot tell the fix from the bug");
    } else if (!head.stderr.includes("run build")) {
      failures.push(`\`legacy --from HEAD\` failed, but not in the build: ${head.stderr.trim().slice(-600)}`);
    }
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", tree], { cwd: REPO_ROOT });
    rmSync(tree, { recursive: true, force: true });
    if (ownOut) rmSync(out, { recursive: true, force: true });
  }
  for (const f of failures) process.stderr.write(`dist-legacy-cutover: ${f}\n`);
  process.stdout.write(
    `dist-legacy-cutover: ${failures.length === 0 ? "green" : "FAILED"} (pinned ${pinned.slice(0, 8)}, cutover ${cut.slice(0, 8)}, ${version})\n`,
  );
  return failures.length === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`dist-legacy-cutover: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
