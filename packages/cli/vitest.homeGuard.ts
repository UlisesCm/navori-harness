import { type Dirent, lstatSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/**
 * Suite guard for the machine-global `~/.navori` root (#404, generalized in #424).
 *
 * Several CLI modules resolve machine-global paths from `safeHomedir()`. Only
 * the backup store has an env override (`NAVORI_BACKUP_ROOT`); everywhere else
 * isolation rests on every spec remembering to mock `os.homedir`. #404 is what
 * happens when one forgets: the suite quietly wrote ~1,200 fixture backups into
 * the developer's real store and then purged from it. This snapshots the real
 * root before and after the run, so the day someone forgets is the day the suite
 * goes red, not the day data disappears.
 *
 * Note the asymmetry that leaves: `NAVORI_BACKUP_ROOT` PREVENTS the write, this
 * guard only DETECTS it after the fact. What should trigger extending the
 * override to the rest of the root (a `NAVORI_HOME`) is not "the guard goes red
 * often" but the first bite on data that cannot be rebuilt.
 *
 * Read-only on disk by construction: it never creates, modifies or removes
 * anything. Its one side effect is the stderr warning of `warnUnwatched`.
 */

/** No ceiling: `depth < NO_LIMIT` and `size > NO_LIMIT` never stop the walk. */
const NO_LIMIT = Number.POSITIVE_INFINITY;

/**
 * Top-level subtrees listed less than in full — the only place a ceiling exists,
 * keyed by name, each with the reason it earns. The shallowest useful value is
 * 2 (list the subtree's own children and stop).
 *
 * Everything else recurses all the way down, and that is the point: a ceiling
 * chosen from "where does each module keep its state" needs a census of writers
 * to stay true, and such a census goes stale every time a module starts nesting
 * one level deeper — leaving real, machine-local files unwatched with a comment
 * claiming otherwise. Recursing by default removes the question: nothing has to
 * be enumerated, and a module added later is covered without touching this file.
 *
 * `backups/` earns its cap on volume alone. Measured on a real home: its 1,869
 * entries at depth 2 hide ~39,500 more below them, because a backup entry is a
 * verbatim copy of a repo's harness. Its unit of state IS `backups/<stamp>`, a
 * fresh name per backup, so #404's creation and its purge both register at depth
 * 2 and descending buys no signal — only cost: 41,405 entries / ~310ms fully
 * recursive, against 1,892 entries / ~3ms with this cap.
 *
 * Nothing else came close on that home: 23 entries across `workspaces/`,
 * `migrations/`, `.trash/` and the loose files at the root. `.trash/` was
 * measured separately because it holds whole deleted workspaces — 6 entries,
 * and it is the landing path of a flow that REMOVES, so its contents are signal.
 */
const DEPTH_BY_SUBTREE = new Map<string, number>([["backups", 2]]);

/**
 * Defensive brake, counted in entries rather than depth: an unexpectedly huge
 * subtree would slow down every suite start. Past this many entries the guard
 * gives up on THAT subtree — the rest of the root keeps its coverage — and says
 * so on stderr, because a guard that switches itself off in silence is worse
 * than no guard at all.
 *
 * Sized from the same measurement: the largest real subtree at its listing depth
 * is `backups/` with 1,869 entries and everything else adds up to 23, so 5,000
 * leaves ~2.7x headroom over the former and ~200x over the latter, and walking
 * that many entries costs ~16ms.
 */
const SUBTREE_ENTRY_BUDGET = 5_000;

/** Aborts the walk of a subtree that blew the budget. Never leaves the module. */
class SubtreeTooLarge extends Error {}

/** Finder artifact — never written by navori, and Finder can touch it mid-run. */
const IGNORED_NAMES = new Set([".DS_Store"]);

/** Fingerprint for a directory: presence only. Its children are listed
 * separately, so carrying an mtime here would just double-report every added
 * child as "modified parent" too. */
const DIR_FINGERPRINT = "dir";

/**
 * Fingerprint of a top-level subtree the guard gave up on. Its children are
 * absent from the snapshot, so `describeNavoriHomeLeak` drops them from both
 * sides of the comparison instead of reading the gap as a diff.
 */
export const UNWATCHED_FINGERPRINT = "dir:unwatched";

/** Relative entry path → fingerprint. */
export type HomeSnapshot = ReadonlyMap<string, string>;

/** Ceilings for one walk. */
type Bounds = {
  /** Deepest level to list, counting the root's own children as level 1. */
  readonly maxDepth: number;
  /** Entries collected before the walk is abandoned. */
  readonly maxEntries: number;
};

/**
 * The developer's real `~/.navori` — the suite must never touch it. `null` when
 * HOME is unusable, which disables the guard: there is nothing to protect.
 */
export function realNavoriHome(): string | null {
  const home = homedir();
  return home && isAbsolute(home) ? join(home, ".navori") : null;
}

/** `lstat` (never follows symlinks) tolerating an entry that vanished between
 * the `readdir` and the `stat`. Any other error propagates: an unreadable home
 * disables the comparison rather than inventing a diff. */
function statOrNull(path: string): { size: number; mtimeMs: number } | null {
  try {
    return lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function record(acc: Map<string, string>, path: string, fingerprint: string, bounds: Bounds): void {
  acc.set(path, fingerprint);
  if (acc.size > bounds.maxEntries) throw new SubtreeTooLarge();
}

function collect(
  dir: string,
  rel: string,
  depth: number,
  bounds: Bounds,
  acc: Map<string, string>,
): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // A missing directory counts as an empty listing, so a run that CREATES it
    // (fresh machine, CI) still shows up as added entries.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for (const entry of entries) {
    if (IGNORED_NAMES.has(entry.name)) continue;
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      record(acc, relPath, DIR_FINGERPRINT, bounds);
      if (depth < bounds.maxDepth) collect(path, relPath, depth + 1, bounds, acc);
      continue;
    }
    // Size + mtime, not just presence: `registry.json` and `global.json` are
    // rewritten in place, so a leak there adds no entry — it corrupts one.
    const stat = statOrNull(path);
    if (stat) record(acc, relPath, `${stat.size}:${stat.mtimeMs}`, bounds);
  }
}

/**
 * Walk one top-level subtree on its own budget, so a single runaway directory
 * cannot blind the guard to the rest of the root. Over budget the subtree is
 * flagged unwatched and its half-collected listing discarded: a listing
 * truncated at an arbitrary point would fake a diff against the next snapshot.
 */
function collectSubtree(
  dir: string,
  name: string,
  maxEntries: number,
  acc: Map<string, string>,
): void {
  const bounds: Bounds = { maxDepth: DEPTH_BY_SUBTREE.get(name) ?? NO_LIMIT, maxEntries };
  const subtree = new Map<string, string>();
  try {
    collect(dir, name, 2, bounds, subtree);
  } catch (err) {
    if (!(err instanceof SubtreeTooLarge)) throw err;
    acc.set(name, UNWATCHED_FINGERPRINT);
    warnUnwatched(name, maxEntries);
    return;
  }
  for (const [path, fingerprint] of subtree) acc.set(path, fingerprint);
}

/** Degraded mode has to be audible: the run still goes green, but a whole
 * subtree stopped being watched and nobody would infer that from a green run. */
function warnUnwatched(name: string, maxEntries: number): void {
  process.stderr.write(
    `\n⚠ ~/.navori isolation guard: '${name}/' holds more than ${maxEntries} entries, ` +
      `so it is NO LONGER WATCHED — a test writing inside it will not fail the run.\n` +
      `  Give it a depth cap in DEPTH_BY_SUBTREE (packages/cli/vitest.homeGuard.ts) ` +
      `if that size is expected.\n\n`,
  );
}

/**
 * Fingerprint every entry under `root`, recursively. `null` when there is no
 * root, or when it can't be read — an unreadable home is not a test failure.
 * Never creates anything: a missing root yields an empty map.
 *
 * `maxEntriesPerSubtree` is a parameter only so the degraded path can be
 * exercised without a 5,000-entry fixture; production callers take the default.
 */
export function snapshotNavoriHome(
  root: string | null,
  maxEntriesPerSubtree: number = SUBTREE_ENTRY_BUDGET,
): HomeSnapshot | null {
  if (!root) return null;
  const acc = new Map<string, string>();
  try {
    collect(root, "", 1, { maxDepth: 1, maxEntries: NO_LIMIT }, acc);
    for (const [name, fingerprint] of [...acc]) {
      if (fingerprint === DIR_FINGERPRINT) {
        collectSubtree(join(root, name), name, maxEntriesPerSubtree, acc);
      }
    }
  } catch {
    return null;
  }
  return acc;
}

const MAX_LISTED = 20;

function bullets(entries: string[]): string {
  const shown = entries.slice(0, MAX_LISTED).map((e) => `    - ${e}`);
  const rest = entries.length - shown.length;
  return [...shown, ...(rest > 0 ? [`    …and ${rest} more`] : [])].join("\n");
}

function section(label: string, entries: string[]): string[] {
  if (entries.length === 0) return [];
  const noun = entries.length === 1 ? "entry" : "entries";
  return [`  ${label} ${entries.length} ${noun}:`, bullets(entries)];
}

/** Subtrees either snapshot gave up on. Excluded from both sides, so one that
 * crossed the budget between the two listings can't fake hundreds of deletions. */
function unwatchedNames(before: HomeSnapshot, after: HomeSnapshot): string[] {
  const names = new Set<string>();
  for (const snapshot of [before, after]) {
    for (const [path, fingerprint] of snapshot) {
      if (fingerprint === UNWATCHED_FINGERPRINT) names.add(path);
    }
  }
  return [...names];
}

/** A snapshot without the contents of the unwatched subtrees. The subtree's own
 * entry stays, normalized, so losing the whole directory is still reported. */
function comparable(snapshot: HomeSnapshot, unwatched: readonly string[]): HomeSnapshot {
  if (unwatched.length === 0) return snapshot;
  const kept = new Map<string, string>();
  for (const [path, fingerprint] of snapshot) {
    if (unwatched.some((name) => path.startsWith(`${name}/`))) continue;
    kept.set(path, fingerprint === UNWATCHED_FINGERPRINT ? DIR_FINGERPRINT : fingerprint);
  }
  return kept;
}

/**
 * Compare the before/after snapshots and describe the damage, or `null` when
 * the run left the real root untouched. Names every entry that appeared,
 * disappeared or changed — a guard that only says "something changed" is a
 * riddle. Paths are relative to `~/.navori`, so `backups/<label>-<timestamp>-<n>`
 * or `workspaces/<name>` points straight at the spec that escaped isolation.
 */
export function describeNavoriHomeLeak(
  root: string,
  before: HomeSnapshot | null,
  after: HomeSnapshot | null,
): string | null {
  if (!before || !after) return null;
  const unwatched = unwatchedNames(before, after);
  const from = comparable(before, unwatched);
  const to = comparable(after, unwatched);
  const created: string[] = [];
  const modified: string[] = [];
  for (const [path, fingerprint] of to) {
    if (!from.has(path)) created.push(path);
    else if (from.get(path) !== fingerprint) modified.push(path);
  }
  const deleted = [...from.keys()].filter((path) => !to.has(path));
  if (created.length === 0 && modified.length === 0 && deleted.length === 0) return null;

  return [
    `The test run touched the REAL machine-global store at ${root}.`,
    `Tests must never read or write it: point the module under test at a throwaway`,
    `directory — mock os.homedir() (registry, global-config, workspaces, migrations,`,
    `workspace trash) or set NAVORI_BACKUP_ROOT, which vitest.setup.ts already does`,
    `for every spec. Entry paths are relative to the root, so the fixture label or`,
    `workspace name below names the spec that escaped isolation — unless a real`,
    `navori run happened concurrently, which reads as a false positive.`,
    ...section("Created", created.sort()),
    ...section("MODIFIED", modified.sort()),
    ...section("DELETED", deleted.sort()),
  ].join("\n");
}
