/**
 * Word ceilings for the always-on prose navori ships (#815, #908, #917).
 *
 * Every file listed here renders into a session's resident context, so an
 * unbounded one grows by accretion: a session that learns something appends,
 * and none of them prune. `packages/cli/scripts/check-doc-budgets.mjs` fails
 * the gate when one exceeds its ceiling, when a budgeted file disappears, or
 * when a managed asset ships with no ceiling at all.
 *
 * WHY THIS LIVES IN `src/lib/` AND NOT IN A JSON UNDER `scripts/` (#917):
 * `packages/cli/package.json` publishes `["dist", "README.md"]`, so anything
 * under `scripts/` is invisible to an installed navori. `doctor` (phase 2 of
 * #917) has to compare a CONSUMER's rendered `CLAUDE.md` against these same
 * ceilings at runtime, which it can only do if they are bundled. One source of
 * truth, two readers: the repo gate (plain Node, type-stripped import — same
 * pattern as `scripts/gen-schemas.mjs`) and the shipped CLI.
 *
 * Being under `src/lib/` is what MAKES that possible, not what achieves it:
 * tsup bundles from `src/index.ts` and tree-shakes, so these ceilings land in
 * `dist/index.js` the moment phase 2's `doctor` imports them. Adding a second
 * tsup entry now would publish an artifact with no reader.
 */

export { countWords } from "./skill-meta.ts";

/**
 * Ceiling per repo-relative path, in words (`countWords` semantics: whitespace
 * separated, whole file including its marker lines).
 *
 * Policy (#815, enforced as a warning since #908): a ceiling carries **≥5%
 * headroom** over the file's real word count, and the raise is justified in
 * the change that makes it. Setting the exact number that passes is what let
 * `CLAUDE.md` erode to 2548/2550. The 18 static assets added in #917 were
 * measured, not estimated, and sit at ~10-14% headroom.
 */
export const DOC_BUDGETS: Readonly<Record<string, number>> = {
  "CLAUDE.md": 2423,

  // Core managed blocks — auto-discovered from `core-assets/managed/`.
  "packages/core/core-assets/managed/arranque-sesion.md": 200,
  "packages/core/core-assets/managed/cierre-sesion.md": 472,
  "packages/core/core-assets/managed/code-discovery-routing.md": 160,
  "packages/core/core-assets/managed/codex-cross-review.md": 180,
  "packages/core/core-assets/managed/formato-respuesta.md": 150,
  "packages/core/core-assets/managed/idioma-rol.md": 140,
  "packages/core/core-assets/managed/intake-tickets.md": 240,
  "packages/core/core-assets/managed/operaciones-seguras.md": 310,
  "packages/core/core-assets/managed/orquestacion.md": 1012,
  "packages/core/core-assets/managed/sdd.md": 199,
  "packages/core/core-assets/managed/tipado-fuerte.md": 50,

  // Plugin managed blocks (#917). Measured / ceiling → headroom.
  "packages/plugins/acli/managed/acli-protocol.md": 80, // 70 → 14.3%
  "packages/plugins/codegraph/managed/codegraph-search-v2.md": 105, // 93 → 12.9%
  "packages/plugins/gh/managed/gh-protocol.md": 120, // 107 → 12.1%
  "packages/plugins/jscpd/managed/jscpd-protocol.md": 90, // 80 → 12.5%
  "packages/plugins/semgrep/managed/semgrep-protocol.md": 105, // 93 → 12.9%
  "packages/plugins/tgrep/managed/tgrep-search-v2.md": 110, // 100 → 10.0%

  // Preset `stack.md` blocks (#917). One renders per consumer, picked by preset.
  "packages/core/core-assets/presets/astro/managed/stack.md": 60, // 53 → 13.2%
  "packages/core/core-assets/presets/background-worker/managed/stack.md": 285, // 256 → 11.3%
  "packages/core/core-assets/presets/bun-keystone/managed/stack.md": 255, // 229 → 11.4%
  "packages/core/core-assets/presets/express/managed/stack.md": 160, // 145 → 10.3%
  "packages/core/core-assets/presets/express-mongoose/managed/stack.md": 175, // 155 → 12.9%
  "packages/core/core-assets/presets/medusa/managed/stack.md": 70, // 63 → 11.1%
  "packages/core/core-assets/presets/monorepo-turbopnpm/managed/stack.md": 220, // 200 → 10.0%
  "packages/core/core-assets/presets/nestjs/managed/stack.md": 72, // 64 → 12.5%
  "packages/core/core-assets/presets/nextjs/managed/stack.md": 78, // 69 → 13.0%
  "packages/core/core-assets/presets/react-native-expo/managed/stack.md": 88, // 78 → 12.8%
  "packages/core/core-assets/presets/vite-react-ts/managed/stack.md": 232, // 210 → 10.5%
  "packages/core/core-assets/presets/vite-react-ts-mantine/managed/stack.md": 126, // 114 → 10.5%
};

/**
 * Managed blocks navori COMPUTES at render time — they have no source `.md` to
 * budget, so they are absent from `DOC_BUDGETS` on purpose, not by oversight.
 *
 * Their size is `base + k · rows`, and the rows come from the consumer's own
 * config: `contexto-proyecto` measured 54 words in this repo and 335 in
 * `bonum-dashboard` (6.2x) purely because that repo declares more
 * `criticalAreas` — legitimate use of the tool, which a constant ceiling would
 * punish. Phase 2 of #917 derives the formula and REPORTS against it; nothing
 * here fails a build over them.
 */
export const COMPUTED_BLOCKS_WITHOUT_BUDGET = [
  "skills-index",
  "contexto-proyecto",
  "agentes-disponibles",
] as const;

/**
 * Where the gate auto-discovers managed assets that must carry a ceiling, as
 * git pathspecs relative to the repo root. A NEW block under any of these
 * ships budgeted from day one or fails the gate.
 */
export const MANAGED_ASSET_PATHSPECS: readonly string[] = [
  "packages/core/core-assets/managed/*.md",
  "packages/core/core-assets/presets/*/managed/*.md",
  "packages/plugins/*/managed/*.md",
];
