/**
 * What counts as a non-trivial source file — ONE definition, several consumers.
 *
 * WHY THIS EXISTS. The term decided two things at once and was written as prose
 * in five places that drifted: the routing ladder's threshold, the
 * `commit-pr-pilot`'s ceiling on unreviewed logic, the `routing-watch` hook, the
 * activation miner and the report. The ladder was withdrawn in #691 precisely
 * because "is this inline?" had no single answer; this module is the condition
 * its own retirement note sets for bringing it back — the term existing ONCE, as
 * code, instead of as prose restated per consumer.
 *
 * WHAT THE DEFINITION SAYS (from the pilot's withdrawn section, preserved here
 * because it was the only place it was ever written down properly). A file in a
 * change is **non-trivial** when all three hold:
 *
 *   (a) it carries behavior — executable source, or the harness prose an agent
 *       obeys — as opposed to config, fixtures, data, lockfiles, copy, docs or
 *       generated output;
 *   (b) the change alters that behavior, rather than propagating an edit that
 *       settles on its own (a rename across call sites, a moved import, a pure
 *       move, a formatting pass);
 *   (c) it is not a test riding along with a source file the same change already
 *       counted.
 *
 * WHAT THIS MODULE CAN AND CANNOT DECIDE, stated up front because the gap is the
 * whole reason the old prose could be read three ways:
 *
 *   · (a) is decidable from the PATH. That is `classifyPath`.
 *   · (c) is decidable over the SET of paths in one change. That is
 *     `countNonTrivial`.
 *   · (b) needs the diff's CONTENT and this module does not see it. A consumer
 *     with only paths — the hook, the miner — is computing a CEILING, never an
 *     exact count, and `countNonTrivial` says so in its return type rather than
 *     letting a caller mistake one for the other.
 *
 * MEASURED, which is why the rules are what they are. Over 506 writes in the
 * park's audited sessions, the activation miner's previous definition — a bare
 * extension regex — admitted 43% that do not belong: 28.7% tests riding along
 * (clause c), 13.4% files outside the repo entirely (a scratch script under
 * `/tmp` reaches no diff), and a stray `node_modules` write. The bias runs one
 * way: it inflates the denominator of "opportunities", which is why the measured
 * activation rate reads low. And it is NOT uniform between repos — tests ride
 * along with feature work, so the repos that delegate most are penalized most.
 */

/** How a path relates to the change, most specific first. */
export type PathKind =
  | "outside-repo"
  | "ephemeral"
  | "dependency"
  | "generated"
  | "lockfile"
  | "fixture"
  | "test"
  | "config"
  | "docs"
  | "source";

/**
 * The rules, in order — FIRST MATCH WINS, so order is part of the definition.
 *
 * They are LITERALS, and their `.source` is what gets handed to the consumer that
 * is not TypeScript: `scripts/mine-activation.py` reads the generated JSON and
 * applies them with Python's `re`. Both engines agree on this subset — character
 * classes, alternation, anchors, and the `\/` escape a JS literal produces — but
 * NOT on lookbehind, named groups or backreferences. A rule that needs one of
 * those belongs in the consumer, not here, so the shared list stays portable;
 * the suite fails on any that slip in.
 */
export interface ClassifyRule {
  kind: Exclude<PathKind, "outside-repo" | "source">;
  /**
   * Matched against the repo-relative POSIX path.
   *
   * A LITERAL, deliberately — not a string compiled with `new RegExp`. Two
   * reasons, and the second is why the first is not enough: a non-literal
   * `RegExp` is a ReDoS surface the security gate blocks on sight, and a literal
   * is also checked by the TypeScript parser, so a malformed pattern fails the
   * build instead of at the first path that reaches it.
   *
   * `.source` is what travels to the other consumer. Python's `re` accepts the
   * escapes a JS literal produces (`\/` among them), so the same string works in
   * both without a translation step that could drift.
   */
  re: RegExp;
  /** Why this rule exists — shipped in the JSON so the other consumer sees it. */
  why: string;
}

export const CLASSIFY_RULES: readonly ClassifyRule[] = [
  {
    kind: "ephemeral",
    re: /(^|\/)\.claude\/(progress|worktrees)\//,
    why: "agent handoffs and reclaimed worktrees: never versioned, never in a diff",
  },
  {
    kind: "ephemeral",
    re: /(^|\/)(scratchpad|\.scratch)\//,
    why: "throwaway scaffolding; 13.4% of the miner's old 'source' writes were this",
  },
  {
    kind: "dependency",
    re: /(^|\/)node_modules\//,
    why: "a vendored dependency is not ours to change, and a write there is an accident",
  },
  {
    kind: "dependency",
    re: /(^|\/)(dist|build|out|coverage|\.next|\.astro)\//,
    why: "build output: regenerated from the source this same change may edit",
  },
  {
    kind: "generated",
    re: /(^|\/)\.claude\//,
    why: "the rendered harness mirror — the change lives in the source asset, not here",
  },
  {
    kind: "generated",
    re: /(^|\/)(CLAUDE|AGENTS)\.md$/,
    why: "rendered from managed blocks; editing it directly is what the drift guard blocks",
  },
  {
    kind: "generated",
    re: /(^|\/)\.mcp\.json$/,
    why: "rendered from the plugin manifests; editing it here is overwritten next render",
  },
  {
    kind: "generated",
    re: /(^|\/)__golden__\/|\.snap$/,
    why: "regenerated from the tree it pins; never hand-authored",
  },
  {
    kind: "lockfile",
    re: /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|Gemfile\.lock|go\.sum)$/,
    why: "resolved by a tool, reviewed as a diff of intent elsewhere",
  },
  {
    kind: "fixture",
    re: /(^|\/)(__fixtures__|__mocks__|fixtures)\//,
    why: "data the tests read, not behavior the program runs",
  },
  {
    kind: "test",
    re: /\.(test|spec)\.[mc]?[jt]sx?$/,
    why: "clause (c): a test pinning a change counted elsewhere is evidence, not a second file",
  },
  {
    kind: "test",
    re: /(^|\/)(__tests__|tests?)\//,
    why: "same clause, for repos that group tests by directory instead of by suffix",
  },
  {
    kind: "test",
    re: /(^|\/)(test|tests)_[^/]+\.py$|(^|\/)[^/]+_test\.(py|go)$/,
    why: "same clause, Python and Go naming",
  },
  {
    kind: "config",
    re: /(^|\/)(package\.json|tsconfig[^/]*\.json|jsconfig\.json|biome\.jsonc?|\.eslintrc[^/]*|\.prettierrc[^/]*|\.editorconfig|\.gitignore|\.npmrc|\.nvmrc)$/,
    why: "clause (a) excludes config explicitly",
  },
  {
    kind: "config",
    re: /(^|\/)navori\.config\.json$/,
    why: "declares what the harness renders; the behavior it changes is navori's, not the repo's",
  },
  {
    kind: "docs",
    re: /(^|\/)(docs|specs)\/|(^|\/)(README|CONTRIBUTING|CHANGELOG|LICENSE)[^/]*$/,
    why: "read by humans; no agent obeys it as instruction",
  },
  {
    kind: "docs",
    re: /(^|\/)progress\//,
    why: "the session log, versioned but not behavior",
  },
];

/** Extensions that carry behavior when nothing above claimed the path. */
const SOURCE_EXT =
  /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|swift|sh|bash|zsh|sql|vue|svelte|astro)$/;

/**
 * Harness prose an agent OBEYS — behavior by clause (a), even though it is `.md`.
 *
 * This is the one place the definition is not intuitive, so it is spelled out:
 * a skill or an agent definition IS executable in the only sense that matters
 * here — an agent reads it and acts on it. The rendered copy under `.claude/` is
 * already excluded above as generated output; what this admits is the SOURCE
 * asset it is rendered from.
 */
const HARNESS_PROSE = /(^|\/)(core-assets|plugins)\/(.*\/)?(agents|skills|managed)\/[^/]+\.md$/;

/** Normalizes to a repo-relative POSIX path, or null when it is outside the repo. */
export function toRepoRelative(filePath: string, repoRoot: string): string | null {
  if (!filePath) return null;
  const p = filePath.replace(/\\/g, "/");
  const root = repoRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!root) return p.replace(/^\.\//, "");
  // A path that merely SHARES A PREFIX is not inside: `/repo-2/x` starts with
  // `/repo` and belongs to another project entirely.
  if (p === root) return "";
  if (p.startsWith(`${root}/`)) return p.slice(root.length + 1);
  // Already relative — the caller's own repo is the only frame it can mean.
  return p.startsWith("/") ? null : p.replace(/^\.\//, "");
}

/** Clause (a), decided from the path alone. */
export function classifyPath(filePath: string, repoRoot = ""): PathKind {
  const rel = toRepoRelative(filePath, repoRoot);
  if (rel === null) return "outside-repo";
  for (const { kind, re } of CLASSIFY_RULES) if (re.test(rel)) return kind;
  if (HARNESS_PROSE.test(rel)) return "source";
  return SOURCE_EXT.test(rel) ? "source" : "docs";
}

export interface NonTrivialCount {
  /**
   * The count, and a CEILING rather than an exact number: clause (b) needs the
   * diff's content, which a path-only caller does not have. Named so a consumer
   * cannot quietly treat it as exact — the mistake that let one number mean
   * three things.
   */
  ceiling: number;
  /** The paths that counted, for a report that has to show its work. */
  counted: string[];
  /** Every path that did not count, by the reason it was excluded. */
  excluded: Record<string, string[]>;
}

/**
 * Clauses (a) + (c) over the set of paths in ONE change.
 *
 * Clause (c) is why this takes a set and not a path: a test counts only when it
 * IS the change. With any non-test source present, the tests ride along and add
 * nothing; with none, a test suite is the change and counts as one file each.
 * Without that arm the rule would be dead on arrival in this repo, which asks
 * for a test with every fix — every bugfix would count two.
 */
export function countNonTrivial(paths: readonly string[], repoRoot = ""): NonTrivialCount {
  const counted: string[] = [];
  const tests: string[] = [];
  const excluded: Record<string, string[]> = {};
  for (const p of paths) {
    const kind = classifyPath(p, repoRoot);
    if (kind === "source") counted.push(p);
    else if (kind === "test") tests.push(p);
    else (excluded[kind] ??= []).push(p);
  }
  if (counted.length === 0) counted.push(...tests);
  else if (tests.length > 0) excluded["test-riding-along"] = tests;
  return { ceiling: counted.length, counted, excluded };
}
