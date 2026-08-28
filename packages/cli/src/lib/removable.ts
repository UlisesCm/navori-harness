import { lstatSync, readFileSync, readdirSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { readCliVersion } from "./bundled-assets.ts";
import { readNavoriOwnership } from "./json-ownership.ts";
import { isDowngrade } from "./semver.ts";

/** Read once per process, like the `CORE_META` constant this criterion was
 *  extracted from: `readCliVersion()` re-reads package.json on every call and a
 *  prune asks the question once per file. */
const CLI_VERSION = readCliVersion();

/**
 * THE authorship test: may navori delete this file?
 *
 * SINGLE SOURCE OF TRUTH for every delete path in the product. It answers
 * "did navori write this?" from the file's own content — the managed marker
 * plus a `version=` that is not ahead of this CLI — never from a static list of
 * paths an engine is *known* to use.
 *
 * It lives here because the product had THREE delete paths with three different
 * criteria. `commitWrites` (engines/shared/execute-plan.ts) demanded the marker
 * before removing a stale skill; `render --prune` deleted whatever a hardcoded
 * per-engine path map said, recursively, sight unseen — taking a hand-written
 * `AGENTS.md`, a user's `.cursor/` rules and their `mcp.json` with it, in an
 * operation `doctor` actively recommends (#496); and the Claude engine's skill
 * prunes (engines/claude/index.ts §8.6–8.8) checked the marker id but NOT the
 * version, so they deleted a file a newer navori wrote. Separate patches would
 * not have stopped a fourth one from appearing — one criterion, one function,
 * and `removal-parity.test.ts`, which fails when a caller stops using it or a
 * new delete path shows up unaccounted for, does.
 *
 * `markerId` narrows the question from "does navori own this file?" to "does
 * navori own it *as that block*", which is what the Claude skill prunes need:
 * they delete `<id>.md` only because navori stamped `<id>` into it, and a
 * user's hand-written skill of the same name must survive. Without it, any
 * managed marker in the file makes it navori's — the rule the orphan scans and
 * the prune already run on.
 *
 * The version guard is not decoration: a file a NEWER navori wrote is not ours
 * to delete (same anti-rollback rule render applies to managed blocks, #79).
 */
export function isRemovableNavoriFile(path: string, markerId?: string): boolean {
  return navoriAuthorship(path, markerId) === "ours";
}

/**
 * Who wrote this file, as far as navori can tell from its bytes.
 *
 * `ours` is the only deletable verdict; the other two are kept apart because
 * they are DIFFERENT ANSWERS and the run says which one it gave. `foreign` means
 * "we read it and nothing in it says navori wrote it"; `newer` means "navori
 * wrote it — a newer one than this CLI — so it is not ours to roll back" (#79).
 * Collapsing the two is how the prune came to report a file navori had generated
 * whole under "left untouched what navori did not write" (#538).
 */
export function navoriAuthorship(path: string, markerId?: string): NavoriAuthorship {
  let stats;
  try {
    // `lstat`, never `stat`/`existsSync`: both resolve the link, so a symlink
    // would be judged by its TARGET's bytes — answering "did navori write the
    // file over there?" to the question "may navori delete this path?". A link
    // is the user's whatever it points at, so it is never navori's to remove.
    stats = lstatSync(path, { throwIfNoEntry: false });
  } catch {
    return "foreign";
  }
  if (!stats?.isFile()) return "foreign";
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return "foreign";
  }
  const writer = writerVersion(content, markerId);
  if (writer === null) return "foreign";
  return isDowngrade(writer, CLI_VERSION) ? "newer" : "ours";
}

/** The three answers `navoriAuthorship` can give. Only `ours` may be deleted. */
export type NavoriAuthorship = "ours" | "newer" | "foreign";

/**
 * The navori release that wrote this content, or null when nothing in it claims
 * navori did — read from whichever of the TWO notations the file can carry.
 *
 * 1. The comment marker, in every format that has comments. `markerId` narrows
 *    the read to that block's opening tag; without one, any managed marker in
 *    the file answers for it.
 * 2. The `$navori` key, for the JSON files navori generates whole. JSON has no
 *    comments, so notation 1 can never appear in one — which left EVERY
 *    generated JSON permanently unauthored: `.claude/settings.json` survived the
 *    prune of a disabled `claude` engine, reported as a file navori had not
 *    written, with its hooks pointing at the scripts the same prune had just
 *    deleted (#538).
 *
 * A caller that named a `markerId` is asking "does navori own this file AS that
 * block", and a JSON file has no blocks — so notation 2 is not offered there,
 * rather than pretending the id matched.
 *
 * Still authorship BY CONTENT, never by path: no extension is tested, no list of
 * "files navori is known to write" exists here. Reintroducing one is the exact
 * defect #496 removed.
 */
function writerVersion(content: string, markerId?: string): string | null {
  const scope = markerId === undefined ? content : openingTagFor(content, markerId);
  if (scope !== null && scope.includes("navori:managed")) {
    const marked = scope.match(/version="([^"]+)"/)?.[1];
    if (marked) return marked;
  }
  if (markerId !== undefined) return null;
  const ownership = readNavoriOwnership(content);
  // `managed` is what separates a file navori GENERATED from one it merely edits
  // by key (`.mcp.json`, a coexisting settings.json, which record their tracking
  // under the same `$navori` key). The second kind is the user's file and no
  // delete path may touch it.
  if (!ownership?.managed) return null;
  return ownership.version ?? null;
}

/**
 * The opening marker LINE for `id`, or null when the file carries no block with
 * that exact id. Scoping the version read to one line matters in a file with
 * several managed blocks: the answer must be "the version of the block that
 * makes this file ours", not whichever `version=` appears first.
 *
 * `indexOf` finds the opening tag before the closing one (`/navori:managed
 * id="…"`, which contains the same substring) simply because it comes first. A
 * file left with only a close tag yields a line with no `version=`, so the
 * caller keeps it — the conservative answer for a mangled file.
 */
function openingTagFor(content: string, id: string): string | null {
  const start = content.indexOf(`navori:managed id="${id}"`);
  if (start === -1) return null;
  const end = content.indexOf("\n", start);
  return content.slice(start, end === -1 ? undefined : end);
}

/** Why a path survived the prune. Each reason answers a DIFFERENT question, so
 *  none is a flavour of another: `foreign` means "we read this file and it is
 *  not ours", `newer` means "it is ours but a newer navori wrote it, so we will
 *  not roll it back" (#79), `symlink` means "we did not follow it and will not
 *  unlink it", `ephemeral` means "machine-local state we never version". The
 *  user acts differently on each, and a run that called them all `foreign` told
 *  them navori had not written a file it had generated whole (#538). */
export type KeepReason = "foreign" | "newer" | "ephemeral" | "symlink";

/** What a prune may and may not touch, decided file by file. */
export interface OrphanRemovalPlan {
  /** Files navori wrote — back these up, then delete them. */
  remove: string[];
  /** Paths left in place, with the reason, so the run can SAY what it spared
   *  instead of deleting a directory whose contents it never inspected. */
  keep: Array<{ path: string; reason: KeepReason }>;
}

/** Directory nesting cap for the walk — engine output trees are shallow; the cap
 *  bounds a pathological (or symlink-inflated) tree the same way health.ts's
 *  scan does. */
const MAX_DEPTH = 8;

/** `rel` is `ex` or lives under it. Mirrors `createBackup`'s exclusion rule so
 *  "the harness never versions this" means the same thing in both places. */
function matchesPrefix(rel: string, prefixes: readonly string[]): boolean {
  return prefixes.some((ex) => rel === ex || rel.startsWith(`${ex}/`));
}

/**
 * Decide, path by path, what `render --prune` may delete out of the orphaned
 * outputs of a disabled engine.
 *
 * The orphan scan reports OWNERSHIP paths derived from a static map (`.cursor`,
 * `AGENTS.md`, `.codex`) — "an engine that is no longer configured would write
 * here". That is not evidence anything under them is navori's, so a directory is
 * walked and each file judged on its own content: navori's files are removed,
 * everything else stays and is reported.
 *
 * `skip` (the ephemeral harness paths) is load-bearing, not an optimisation: the
 * walk must never descend into `.claude/worktrees/`, whose checkouts contain
 * copies of navori's OWN managed files — every one of them would pass the
 * authorship test and a prune of a disabled `claude` engine would delete (and
 * back up, #348) entire worktrees.
 *
 * Symlinks are never followed and never removed, and that is decided by `lstat`
 * on EVERY path the walk touches, roots included: a link is the user's whatever
 * it points at, and its target commonly lives outside the repository, where a
 * prune has no business writing. They come back as `keep` with reason
 * `"symlink"` so the run says so instead of looking like it failed.
 */
export function planOrphanRemoval(
  cwd: string,
  paths: readonly string[],
  skip: readonly string[] = [],
): OrphanRemovalPlan {
  // The list ships directory entries with a trailing slash (it doubles as a
  // .gitignore body); the prefix rule below wants them bare.
  const skipPrefixes = skip.map((s) => s.replace(/\/$/, ""));
  const plan: OrphanRemovalPlan = { remove: [], keep: [] };
  const seenKeep = new Set<string>();
  const keep = (path: string, reason: KeepReason): void => {
    if (seenKeep.has(path)) return;
    seenKeep.add(path);
    plan.keep.push({ path, reason });
  };

  const visit = (rel: string, depth: number): void => {
    if (matchesPrefix(rel, skipPrefixes)) {
      keep(rel, "ephemeral");
      return;
    }
    let stats;
    try {
      // `lstat`, not `stat`: `stat` FOLLOWS the link, so a root that is a
      // symlink to a directory was classified `isDirectory()`, walked, and its
      // contents — the user's files, outside the repository — planned for
      // deletion. The guard used to live on the dirents, which only ever see
      // children; the roots come from the caller and reached here unexamined.
      stats = lstatSync(join(cwd, rel), { throwIfNoEntry: false });
    } catch {
      return;
    }
    if (!stats) return;
    if (stats.isSymbolicLink()) {
      keep(rel, "symlink");
      return;
    }
    if (stats.isFile()) {
      const authorship = navoriAuthorship(join(cwd, rel));
      if (authorship === "ours") plan.remove.push(rel);
      else keep(rel, authorship === "newer" ? "newer" : "foreign");
      return;
    }
    if (!stats.isDirectory() || depth > MAX_DEPTH) {
      // Neither a regular file nor a directory (a socket, a fifo, a device), or
      // a tree deeper than the cap: never deleted.
      keep(rel, "foreign");
      return;
    }
    let entries;
    try {
      entries = readdirSync(join(cwd, rel), { withFileTypes: true });
    } catch {
      keep(rel, "foreign");
      return;
    }
    // No dirent-level symlink check: `visit` lstats whatever it is handed, so
    // a child link is classified by the same line that classifies a root one.
    // Two places deciding "is this a symlink?" is how the roots got missed.
    for (const entry of entries) visit(`${rel}/${entry.name}`, depth + 1);
  };

  for (const path of paths) visit(path, 0);
  return plan;
}

/**
 * Drop the directories a prune emptied, deepest first, under each root it
 * touched (the root itself included). Without this an all-navori `.codex/`
 * survives as an empty shell, `existsSync` keeps it in the orphan scan, and
 * `doctor` reports the same orphan on every run with nothing left to delete.
 * A directory that still holds the user's files is left exactly where it is —
 * `rmdirSync` refuses a non-empty directory, which is the whole guarantee.
 *
 * A symlinked directory is not swept: `readdirSync` follows it, so sweeping one
 * would run `rmdirSync` inside the link's target, outside the repository.
 */
export function removeEmptyDirs(cwd: string, roots: readonly string[]): void {
  const sweep = (rel: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    const abs = join(cwd, rel);
    let stats;
    try {
      stats = lstatSync(abs, { throwIfNoEntry: false });
    } catch {
      return;
    }
    // A link, a file, or already gone. The check is here — not on the dirents —
    // so it covers the roots, which are handed in from outside and never had it.
    if (!stats?.isDirectory()) return;
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return; // vanished under us, or unreadable
    }
    for (const entry of entries) {
      if (entry.isDirectory()) sweep(`${rel}/${entry.name}`, depth + 1);
    }
    try {
      rmdirSync(abs); // throws ENOTEMPTY when anything survived — exactly right
    } catch {
      // Not empty, or not ours to remove.
    }
  };
  for (const root of roots) sweep(root, 0);
}
