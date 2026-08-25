import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

/**
 * #490 — an asset that invokes a CLI subcommand is coupled to the PUBLISHED
 * version, not to the working tree.
 *
 * A rendered asset (hook, agent, skill) that tells an agent to run
 * `navori <cmd>` resolves the binary on PATH — whatever the user installed
 * from npm. So a feature that lands a subcommand AND an asset calling it in
 * the same PR ships an asset that is broken for everyone until the next
 * release. That is exactly how `audit` shipped in #485: the hook ordered
 * `navori audit --start` while the published 0.6.1 had no such subcommand, and
 * citty answers an unknown subcommand by printing help and exiting 0 — so it
 * failed silently, looking like success.
 *
 * Same family as #392 (assets citing paths that don't exist) and #421 (the
 * rendered mirror falling behind core): the asset promises something the
 * environment does not deliver.
 *
 * Two verdicts, deliberately different:
 *   - cited but NOT registered anywhere  → ERROR. A typo or a removed command;
 *     nothing will ever make it work.
 *   - registered but not in the last tag → WARNING. Correct code that simply
 *     is not out yet. Blocking here would invert the natural order (you would
 *     have to publish before merging), so it reports instead.
 *
 * Scope note: only tokens that match a KNOWN subcommand are considered, which
 * keeps English prose ("navori detects the stack") out of the results. The
 * cost is that a typo'd subcommand reads as prose and is skipped — that case
 * belongs to #392's checker, not to this one.
 *
 * Usage: node scripts/check-asset-commands.mjs
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INDEX_TS = "packages/cli/src/index.ts";
const ASSET_DIRS = ["packages/core/core-assets", "packages/plugins"];

/** Subcommand names registered in the CLI's `subCommands: { ... }` block. */
function parseSubCommands(source) {
  const block = source.match(/subCommands:\s*\{([\s\S]*?)\n\s*\},/);
  if (!block) return null;
  return new Set([...block[1].matchAll(/^\s*([a-z][\w-]*)\s*:/gm)].map((m) => m[1]));
}

function fail(message, detail) {
  console.error(`✗ ${message}`);
  if (detail) console.error(detail);
  process.exit(1);
}

const known = parseSubCommands(readFileSync(join(REPO_ROOT, INDEX_TS), "utf-8"));
// A check that cannot run must be loud, never a silent pass — the blind spot
// #421 is about.
if (!known || known.size === 0) fail(`could not parse subCommands from ${INDEX_TS}`);

/** The newest release tag, or null in a shallow clone with no tags. */
function latestTag() {
  try {
    const out = execFileSync("git", ["tag", "--sort=-creatordate"], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
    }).trim();
    return out ? out.split("\n")[0] : null;
  } catch {
    return null;
  }
}

/** Subcommands the CLI had at that tag — i.e. what users actually installed. */
function publishedSubCommands(tag) {
  try {
    const source = execFileSync("git", ["show", `${tag}:${INDEX_TS}`], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
    });
    return parseSubCommands(source);
  } catch {
    return null;
  }
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) yield* walk(abs);
    else if (/\.(md|sh)$/.test(entry)) yield abs;
  }
}

// Collect every `navori <known-subcommand>` an asset cites, with its location.
const citations = new Map(); // subcommand -> Set<"path:line">
for (const rel of ASSET_DIRS) {
  const root = join(REPO_ROOT, rel);
  let files;
  try {
    files = [...walk(root)];
  } catch {
    continue; // directory absent in this layout
  }
  for (const abs of files) {
    const lines = readFileSync(abs, "utf-8").split("\n");
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/\bnavori\s+([a-z][\w-]*)/g)) {
        const cmd = m[1];
        if (!known.has(cmd)) continue; // prose, not an invocation
        if (!citations.has(cmd)) citations.set(cmd, new Set());
        citations.get(cmd).add(`${relative(REPO_ROOT, abs)}:${i + 1}`);
      }
    });
  }
}

const tag = latestTag();
const published = tag ? publishedSubCommands(tag) : null;

if (!published) {
  console.log(
    `⚠ no release tag to compare against${tag ? ` (could not read ${INDEX_TS} at ${tag})` : ""} — skipping the unreleased-subcommand check`,
  );
  process.exit(0);
}

const unreleased = [...citations.keys()].filter((cmd) => !published.has(cmd)).sort();

if (unreleased.length === 0) {
  console.log(
    `✓ every subcommand cited by an asset exists in ${tag} (${citations.size} cited, ${known.size} registered)`,
  );
  process.exit(0);
}

// A warning, not a failure: the code is right, it just is not out yet.
console.log(`⚠ assets cite ${unreleased.length} subcommand(s) missing from the published CLI (${tag}):`);
for (const cmd of unreleased) {
  console.log(`\n  navori ${cmd} — registered in the working tree, absent from ${tag}`);
  for (const where of [...citations.get(cmd)].sort()) console.log(`    ${where}`);
}
console.log(
  [
    ``,
    `  Until the next release those assets order a command users do not have.`,
    `  citty prints its help and exits 0 for an unknown subcommand, so the`,
    `  failure is SILENT and reads as success — an asset must not trust the`,
    `  exit code (see audit-mode-trigger.sh for the introspection pattern).`,
    ``,
    `  Not a build failure on purpose: blocking here would force publishing`,
    `  before merging. Publish, and this check goes quiet on its own.`,
  ].join("\n"),
);
process.exit(0);
