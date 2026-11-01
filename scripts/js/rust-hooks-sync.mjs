import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { staleHashes } from "./rust-manifest-check.mjs";

/**
 * Spec 0060 T17 (D47) — `bun run rust:hooks-sync`: one command for the manual steps every change
 * to a ported hook or to the shared runtime used to need.
 *
 *   node scripts/js/rust-hooks-sync.mjs               rewrite stale hashes, render --apply, cargo install
 *   node scripts/js/rust-hooks-sync.mjs --no-install  same, with `cargo build` instead of installing
 *   node scripts/js/rust-hooks-sync.mjs --check       exit 1 if a hash or the rendered tree is stale
 *
 * Only the stale hash strings of `crates/ported.json` change; the file keeps its formatting. The
 * render rewrites the signed wrappers, which embed those hashes, and the binary has to be rebuilt
 * because `navori-rust` refuses a wrapper whose `impl` its compiled registry does not know.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const MANIFEST = join("crates", "ported.json");

/**
 * The `[start, end)` span of the JSON object that opens at `text[open]` (`{`), skipping strings.
 *
 * @param {string} text
 * @param {number} open
 * @returns {number} index just past the matching `}`
 */
function objectEnd(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
    } else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i + 1;
  }
  throw new Error("rust-hooks-sync: unbalanced crates/ported.json");
}

/**
 * The span of the value of `"key": {` searched from `from` up to `to`.
 *
 * @returns {[number, number]}
 */
function memberSpan(text, key, from, to) {
  const at = text.indexOf(`${JSON.stringify(key)}:`, from);
  if (at === -1 || at >= to) throw new Error(`rust-hooks-sync: ${key} not found in crates/ported.json`);
  const open = text.indexOf("{", at);
  return [open, objectEnd(text, open)];
}

/**
 * Replace every stale hash of `manifest.hooks` inside its own hook object, leaving the rest of the
 * text byte-for-byte.
 *
 * @param {string} root repository root (sources and assets are read from it)
 * @param {string} text current `crates/ported.json`
 * @returns {{ text: string, stale: ReturnType<typeof staleHashes> }}
 */
export function syncManifestText(root, text) {
  const stale = staleHashes(root, JSON.parse(text));
  let out = text;
  for (const entry of stale) {
    const [hooksStart, hooksEnd] = memberSpan(out, "hooks", 0, out.length);
    const [hookStart, hookEnd] = memberSpan(out, entry.id, hooksStart + 1, hooksEnd);
    let from = hookStart;
    let to = hookEnd;
    if (entry.kind !== "impl") [from, to] = memberSpan(out, entry.kind, hookStart + 1, hookEnd);
    const needle = `${JSON.stringify(entry.name)}: ${JSON.stringify(entry.recorded)}`;
    const at = out.indexOf(needle, from);
    if (at === -1 || at >= to)
      throw new Error(`rust-hooks-sync: cannot locate ${entry.id}.${entry.kind}.${entry.name}`);
    const replacement = `${JSON.stringify(entry.name)}: ${JSON.stringify(entry.expected)}`;
    out = out.slice(0, at) + replacement + out.slice(at + needle.length);
  }
  return { text: out, stale };
}

/** @param {string} root @param {string} cmd @param {string[]} args @returns {number} */
function spawnStep(root, cmd, args) {
  process.stderr.write(`rust-hooks-sync: ${[cmd, ...args].join(" ")}\n`);
  const result = spawnSync(cmd, args, { cwd: root, stdio: "inherit" });
  return result.status ?? 1;
}

const describe = (entry) =>
  entry.kind === "impl" ? `${entry.id}.impl` : `${entry.id}.${entry.kind}.${entry.name}`;

/**
 * @param {string[]} argv
 * @param {{ root?: string, run?: (cmd: string, args: string[]) => number }} [seams] test seams:
 *   the repository root and the runner of the render and cargo steps
 * @returns {number} exit code
 */
export function main(argv, seams = {}) {
  const root = seams.root ?? REPO_ROOT;
  const run = seams.run ?? ((cmd, args) => spawnStep(root, cmd, args));
  const path = join(root, MANIFEST);
  const { text, stale } = syncManifestText(root, readFileSync(path, "utf8"));
  if (argv.includes("--check")) {
    for (const entry of stale) process.stderr.write(`rust-hooks-sync: stale ${describe(entry)}\n`);
    if (stale.length > 0) {
      process.stderr.write("rust-hooks-sync: run `bun run rust:hooks-sync`\n");
      return 1;
    }
    // The wrappers embed the hashes: a manifest in sync with a stale render is still stale.
    return run("bun", ["run", "check:render"]) === 0 ? 0 : 1;
  }
  if (stale.length > 0) {
    writeFileSync(path, text);
    for (const entry of stale) process.stderr.write(`rust-hooks-sync: updated ${describe(entry)}\n`);
  }
  if (run("bun", ["run", "render:apply"]) !== 0) return 1;
  const cargo = argv.includes("--no-install")
    ? ["build", "-p", "navori-cli", "--locked"]
    : ["install", "--path", "crates/navori-cli", "--locked"];
  return run("cargo", cargo) === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
