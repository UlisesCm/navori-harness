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
 * `dist/index.js` the moment phase 2's `doctor` imports them — which it now
 * does (`commands/doctor.ts`, `scanDocBudget`).
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
 * punish. `COMPUTED_BLOCK_FORMULAS` below carries the `base + k · rows` version
 * `doctor` reports against; nothing here fails a build over them.
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

/**
 * Words the marker PAIR adds to a block once rendered, on top of its source
 * asset. The ceilings above are measured on the source `.md`, which carries no
 * markers; a rendered block carries both.
 *
 * Measured, not estimated — the overhead is a constant because `openMarker`
 * always writes the same four attributes: this repo's `CLAUDE.md` renders
 * `tipado-fuerte` at 51 words against a 40-word source, `operaciones-seguras`
 * at 297 against 286, `idioma-rol` at 138 against 127 and
 * `code-discovery-routing` at 162 against 151. Four blocks, `+11` every time.
 * Without it every rendered block reads ~11 words over its ceiling and the
 * report is nothing but false positives.
 */
export const MARKER_PAIR_WORDS = 11;

/**
 * Characters the SessionStart hook will deliver before it degrades a section to
 * a one-line pointer (`NAVORI_CTX_BUDGET`,
 * `packages/core/core-assets/hooks/session-start-context.sh`).
 *
 * This is the ceiling `.claude/context/` ACTUALLY has today, and it is not a
 * word budget: past it the host hands the model a preview and writes the rest
 * to a file nobody opens (#623), so the hook emits the pointer instead. `doctor`
 * reports the surface against it; capping `.claude/context/` by words is #919.
 * Mirrored here rather than parsed out of a shell script — a test asserts the
 * hook asset still declares the same number.
 */
export const SESSION_CONTEXT_DELIVERY_BUDGET_CHARS = 8000;

/** A ceiling that cannot be a constant: `base + perRow · rows`. */
export interface ComputedBlockFormula {
  /** Heading, intro and the marker pair — everything that doesn't scale. */
  base: number;
  /** Ceiling per `- …` row of the rendered block. */
  perRow: number;
}

/**
 * Ceilings for the three blocks navori COMPUTES from the consumer's config.
 *
 * The unit is a rendered ROW (`- …` line), which is countable from the file
 * alone — no config resolution, no guessing which knob produced which line.
 *
 * Calibrated GENEROUSLY on purpose (#917): this block reports what each config
 * entry COSTS, it does not punish a repo for using the tool. Every `k` sits
 * above the most expensive row navori can emit for that block, measured today:
 *
 * - `skills-index` — rows measured at 4-5 words (`- \`id\` — tag`, no trigger:
 *   the `claude` engine drops it since #908). Base measured at 68 here (header
 *   + marker pair) for 18 rows / 150 words; `bonum-webapp` renders 32 rows /
 *   208 words, i.e. 4.4 per row. `80 + 7·rows` clears both by ~40%.
 * - `contexto-proyecto` — the priciest row is `migrationRow`, 42 (es) / 43 (en)
 *   words with one-word arguments (`i18n.ts`, `blocks.projectContext`), so `k`
 *   is that worst case plus room for the user's own words. Base is heading (4)
 *   + intro (12) + marker pair (11). `bonum-dashboard` renders 9 rows / 335
 *   words against a 435 ceiling — the case the user ruled LEGITIMATE, so the
 *   formula must not flag it.
 * - `agentes-disponibles` — 6 rows / 210 words in this repo, priciest row 37
 *   words. Renders to `.claude/context/`, which `doctor` REPORTS and does not
 *   cap (#919 owns that ceiling); the formula exists so the report can price an
 *   agent row there too.
 */
export const COMPUTED_BLOCK_FORMULAS: Readonly<Record<string, ComputedBlockFormula>> = {
  "skills-index": { base: 80, perRow: 7 },
  "contexto-proyecto": { base: 30, perRow: 45 },
  "agentes-disponibles": { base: 60, perRow: 40 },
};

/** Ceiling for a computed block at `rows` rows, or null when it isn't one. */
export function computedBlockCeiling(id: string, rows: number): number | null {
  const formula = COMPUTED_BLOCK_FORMULAS[id];
  return formula ? formula.base + formula.perRow * rows : null;
}

/** `packages/core/core-assets/presets/<preset>/managed/stack.md`. */
const PRESET_STACK_RE = /^packages\/core\/core-assets\/presets\/([^/]+)\/managed\/stack\.md$/;
/** Any other budgeted managed asset — its basename IS the block id. */
const MANAGED_ASSET_RE = /\/managed\/([^/]+)\.md$/;

/**
 * Ceiling per RENDERED managed-block id, derived from `DOC_BUDGETS` — never a
 * second table. The block id is the asset's basename for core and plugin
 * blocks (`operaciones-seguras.md` → `operaciones-seguras`) and `stack-<preset>`
 * for a preset's `stack.md`, which is how every `presets/*.json` declares it.
 *
 * `MARKER_PAIR_WORDS` is added here, once, so callers compare like with like.
 */
export function managedBlockCeilings(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [path, ceiling] of Object.entries(DOC_BUDGETS)) {
    const preset = PRESET_STACK_RE.exec(path);
    const id = preset ? `stack-${preset[1]}` : MANAGED_ASSET_RE.exec(path)?.[1];
    if (id) out[id] = ceiling + MARKER_PAIR_WORDS;
  }
  return out;
}
