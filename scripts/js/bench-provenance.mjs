import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { withoutRepoGitEnv } from "./git-env.mjs";

/**
 * Spec 0055 / #1354 — provenance shared by `bench:tests`, `bench:hooks` and
 * `check-test-budget`: which bytes a bench report actually measured.
 *
 * It is an optional field of a report (no schema bump): reports without it stay valid.
 * It is hand-editable JSON, so it proves a convention (the tooling recorded what it ran),
 * not a signature.
 *
 * @typedef {{ head: string | null, dirty: boolean, distSha256: string | null, assetsSha256: string | null }} Provenance
 */

/** Runs git in `root` without the repo-local variables a hook may have exported. */
function git(root, args) {
  return spawnSync("git", args, { cwd: root, env: withoutRepoGitEnv(process.env), encoding: "utf8" });
}

/**
 * `git rev-parse HEAD` of a checkout.
 *
 * @param {string} root
 * @returns {string | null} 40-hex sha, or `null` when `root` is not a git checkout
 */
export function gitHead(root) {
  const run = git(root, ["rev-parse", "HEAD"]);
  const head = (run.stdout ?? "").trim();
  return run.status === 0 && /^[0-9a-f]{40}$/.test(head) ? head : null;
}

/** Sorted absolute paths of every regular file under `dir`. */
function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) =>
      entry.isDirectory() ? listFiles(join(dir, entry.name)) : entry.isFile() ? [join(dir, entry.name)] : [],
    );
}

/**
 * SHA-256 of a directory tree (relative paths and contents, in a stable order).
 *
 * @param {string} dir
 * @returns {string | null} `null` when the directory does not exist
 */
export function hashTree(dir) {
  if (!existsSync(dir)) return null;
  const hash = createHash("sha256");
  for (const file of listFiles(dir)) {
    hash.update(`${file.slice(dir.length)}\0`);
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * Provenance of a checkout: its HEAD, whether the tree is dirty (tracked or untracked,
 * gitignored paths excluded), and the hashes of what the CLI ships: `dist/index.js` and
 * `dist/assets` (the copied core and plugin assets `copy-assets` writes).
 * Without git the checkout cannot be proven clean: `head` is `null` and `dirty` is `true`.
 *
 * @param {string} root checkout root
 * @returns {Provenance}
 */
export function readProvenance(root) {
  const head = gitHead(root);
  const status = head === null ? null : git(root, ["status", "--porcelain"]);
  const dist = join(root, "packages", "cli", "dist");
  const entry = join(dist, "index.js");
  return {
    head,
    dirty: status === null || status.status !== 0 || (status.stdout ?? "").trim() !== "",
    distSha256: existsSync(entry) ? createHash("sha256").update(readFileSync(entry)).digest("hex") : null,
    assetsSha256: hashTree(join(dist, "assets")),
  };
}
