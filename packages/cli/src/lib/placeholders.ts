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
 * @param path - The config path the template referenced, verbatim from the asset.
 * @param lang - Locale for the prose fallbacks, normally
 * `resolveLang(config.language)`. Required on purpose: a default would let a
 * future call site publish the wrong language into a rendered file with nothing
 * failing — which is the bug #445 fixed. The one call site with no config to
 * read (doctor's artifact scan, which probes for the fallback's SHAPE) passes
 * `DEFAULT_LANG` explicitly, so the choice is visible where it is made.
 */
export function placeholderFallback(path: string, lang: Lang): string {
  return SOFT_FALLBACKS.get(path)?.(lang) ?? `<not configured: ${path}>`;
}
