import { type Lang, tc } from "./i18n.ts";

/**
 * Fallback text for an unresolved `{{path}}` placeholder, shared by both
 * interpolators (lib/render-plan for CLAUDE.md managed blocks, and
 * engines/claude/interpolate for agents/skills files).
 *
 * Known-optional paths render prose that points at the fix (or a sane generic
 * value): templates reference them INLINE, mid-sentence, so a raw
 * `<not configured: qualityGate.fast>` reads like a command to run and a raw
 * `<not configured: project.criticalAreas>` reads like a broken template.
 * Everything else keeps the `<not configured: path>` hint — still useful for
 * spotting a typo'd placeholder in a template. That hard fallback names a config
 * path, so it stays language-neutral; the soft ones are prose a human reads
 * inline and take `lang` (#445 — the `qualityGate.*` diagnostic was hardcoded in
 * Spanish and published into ~82 asset sites of every `language:"en"` repo).
 *
 * Every path here is one that resolves to nothing in a default config —
 * `qualityGate` is optional, and `project.criticalAreas`/`project.legacyPaths`
 * default to `[]`, which the interpolator now reports as unresolved instead of
 * emitting "" into the middle of a sentence (#375). Adding a `{{path}}` to an
 * asset for a config field that is optional or array-defaulted means adding it
 * here too, and checking the sentence still reads with the fallback in place.
 */
// A Map, not an object literal: `path` comes from an asset, and indexing an
// object resolves inherited members — `SOFT_FALLBACKS["constructor"]` returned
// `Object.prototype.constructor`, a truthy value the `??` below could not catch,
// so `{{constructor}}` in any asset rendered `function Object() { [native code] }`
// into the prose. A Map has no prototype chain to walk, and `.get` is honestly
// typed. (#447 — same class as the `.claude/constructor` leak fixed in #428.)
//
// Values are resolvers, not strings, so a locale-dependent entry reads its copy
// from the catalog at call time instead of freezing one locale at module load.
const SOFT_FALLBACKS: ReadonlyMap<string, (lang: Lang) => string> = new Map([
  ["qualityGate.fast", (lang: Lang) => tc(lang).common.qualityGateNotConfigured],
  ["qualityGate.full", (lang: Lang) => tc(lang).common.qualityGateNotConfigured],
  // Generic defaults, not a diagnostic: these read as the sensible baseline
  // list every repo has whether or not it declared one. Identifiers a config
  // would otherwise supply verbatim, so they are the same in every locale.
  ["project.criticalAreas", () => "auth, permissions, payments, data integrity"],
  ["project.legacyPaths", () => "legacy/, vendor/"],
]);

/**
 * The `global` scope's overrides (Spec 0010 FB, issue #546). The machine-wide
 * harness renders the SAME agents and skills into `~/.claude/skills/navori/`,
 * where three of their placeholders describe something that genuinely does not
 * exist: the quality gate, the base branch and the PR target belong to a repo,
 * and a file under `~/.claude` is static while the repo is whatever `cwd` the
 * session happens to start in.
 *
 * Neither of the two obvious outs works. Detecting at render time freezes one
 * repo's answer into every session; injecting through the SessionStart gate
 * never reaches a subagent, which starts with its own context and never sees
 * the main session's `additionalContext`.
 *
 * So the global agent DERIVES instead of carrying a baked value, and these
 * strings are the instruction to do so. The asymmetry is what justifies it: the
 * global harness only ever runs in a project with NO navori config, where by
 * definition there is no declared gate to bake in.
 *
 * A path missing here falls through to `SOFT_FALLBACKS` and then to the hard
 * `<not configured: …>` hint, which is what `global-asset-inventory.test.ts`
 * fails on — the net that stops a new placeholder from shipping globally
 * without an answer (#375 and #445 were this bug on the repo path).
 */
const GLOBAL_FALLBACKS: ReadonlyMap<string, (lang: Lang) => string> = new Map([
  ["qualityGate.fast", (lang: Lang) => tc(lang).common.globalQualityGate],
  ["qualityGate.full", (lang: Lang) => tc(lang).common.globalQualityGate],
  ["branchBase", (lang: Lang) => tc(lang).common.globalBranchBase],
  ["prTarget", (lang: Lang) => tc(lang).common.globalPrTarget],
]);

/** Which scope's fallbacks apply. `repo` is the default everywhere else. */
export type FallbackScope = "repo" | "global";

/**
 * @param path - The config path the template referenced, verbatim from the asset.
 * @param lang - Locale for the prose fallbacks, normally
 * `resolveLang(config.language)`. Required on purpose: a default would let a
 * future call site publish the wrong language into a rendered file with nothing
 * failing — which is the bug #445 fixed. The one call site with no config to
 * read (doctor's artifact scan, which probes for the fallback's SHAPE) passes
 * `DEFAULT_LANG` explicitly, so the choice is visible where it is made.
 * @param scope - `global` consults `GLOBAL_FALLBACKS` first. Defaults to `repo`,
 * so every existing call site renders byte-identically (Spec 0010 §2.4).
 */
export function placeholderFallback(
  path: string,
  lang: Lang,
  scope: FallbackScope = "repo",
): string {
  const global = scope === "global" ? GLOBAL_FALLBACKS.get(path) : undefined;
  return (global ?? SOFT_FALLBACKS.get(path))?.(lang) ?? `<not configured: ${path}>`;
}
