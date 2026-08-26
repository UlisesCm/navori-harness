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
 * THREE outcomes, three markers, and they are not interchangeable (#504):
 *   ⚠  ran, and assets cite something unreleased  → reported, exit 0
 *   ✓  ran clean over N asset files against a tag → exit 0
 *   ⊘  COULD NOT RUN (no tag, unreadable tag, no assets to walk) → nothing was
 *      compared. Exit 0 by default (a shallow clone is not a defect) and exit 1
 *      under --strict, the mode CI uses: there the environment is configured to
 *      make the check runnable (`fetch-depth: 0`), so "cannot run" means that
 *      configuration regressed. Before this the skip printed a ⚠ and exited 0 —
 *      indistinguishable from a real run, which is the #421 blind spot again.
 *
 * Usage: node scripts/check-asset-commands.mjs [--strict]
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INDEX_TS = "packages/cli/src/index.ts";
const ASSET_DIRS = ["packages/core/core-assets", "packages/plugins"];
/** Turns "could not run" into a failure. CI passes it; a local clone does not. */
const STRICT = process.argv.includes("--strict");

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

/**
 * The check could not run. NOT a clean run: say so with its own marker and
 * spell out that nothing was compared, so no reader (human or test) can mistake
 * this for a ✓.
 */
function cannotRun(reason, hint) {
  console.log(`⊘ could not run: ${reason} — NO asset was compared against a published CLI`);
  if (hint) console.log(`  ${hint}`);
  process.exit(STRICT ? 1 : 0);
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
let scanned = 0; // asset files actually read
for (const rel of ASSET_DIRS) {
  const root = join(REPO_ROOT, rel);
  let files;
  try {
    files = [...walk(root)];
  } catch {
    continue; // directory absent in this layout
  }
  for (const abs of files) {
    scanned++;
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

// Zero assets walked is not "no violations": a renamed or unbuilt asset layout
// would otherwise print a ✓ over an empty scan (same family as #454's "0 files
// to scan").
if (scanned === 0) {
  cannotRun(
    `no .md/.sh asset found under ${ASSET_DIRS.join(", ")}`,
    "the asset layout moved, or this is not the navori repo root",
  );
}

const tag = latestTag();
const published = tag ? publishedSubCommands(tag) : null;

if (!published) {
  cannotRun(
    tag ? `${INDEX_TS} is unreadable at ${tag}` : "there is no release tag to compare against",
    tag
      ? `\`git show ${tag}:${INDEX_TS}\` failed — a tag from before that path existed?`
      : "a shallow clone has no tags: `git fetch --tags` (CI uses actions/checkout with fetch-depth: 0)",
  );
}

const unreleased = [...citations.keys()].filter((cmd) => !published.has(cmd)).sort();

if (unreleased.length === 0) {
  // The file count is part of the verdict: it says the ✓ came from a real scan.
  console.log(
    `✓ every subcommand cited by an asset exists in ${tag} (${citations.size} cited across ${scanned} asset files, ${known.size} registered)`,
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
