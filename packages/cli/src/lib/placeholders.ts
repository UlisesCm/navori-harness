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
 * spotting a typo'd placeholder in a template.
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
const SOFT_FALLBACKS: ReadonlyMap<string, string> = new Map([
  ["qualityGate.fast", "(quality gate sin configurar — corre 'navori configure quality-gate')"],
  ["qualityGate.full", "(quality gate sin configurar — corre 'navori configure quality-gate')"],
  // Generic defaults, not a diagnostic: these read as the sensible baseline
  // list every repo has whether or not it declared one.
  ["project.criticalAreas", "auth, permissions, payments, data integrity"],
  ["project.legacyPaths", "legacy/, vendor/"],
]);

export function placeholderFallback(path: string): string {
  return SOFT_FALLBACKS.get(path) ?? `<not configured: ${path}>`;
}
