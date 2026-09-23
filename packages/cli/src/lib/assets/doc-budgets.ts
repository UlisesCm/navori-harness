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
 * tsdown bundles from `src/index.ts` and tree-shakes, so these ceilings land
 * in `dist/index.js` the moment phase 2's `doctor` imports them — which it
 * now does (`commands/doctor.ts`, `scanDocBudget`).
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
 *
 * WHAT THE ≥5% FLOOR ACTUALLY MEASURES (#955): it is a DRIFT DETECTOR, not a
 * budget. Since a ceiling is set as `words × 1.05`, "headroom < 5%" is
 * arithmetically the same statement as "this file grew since its last
 * recalibration" — it does not measure distance to any external limit,
 * because for `CLAUDE.md` there is none to measure against. The only
 * externally anchored cap in this module is `CODEX_PROJECT_DOC_MAX_BYTES`
 * (below), which is Codex's published `project_doc_max_bytes`, applies to
 * `AGENTS.md`, and is in BYTES. Claude Code publishes no equivalent, so a
 * raise here spends no real budget — which is exactly why raising cannot be
 * the standing answer: the hard ceiling is the only brake on accretion this
 * module has, and a ceiling that always yields stops braking.
 *
 * THEREFORE, THE RECALIBRATION RULE (#955): every recalibration leaves **≥10%**
 * headroom (`ceiling = ceil(words × 1.10)`), and it is paid for by trimming
 * prose in the same change, not by the raise alone. Recalibrating to exactly
 * +5% is what put seven files one single word away from a red gate between
 * #908 and #955; +10% is the margin that makes an ordinary prose PR survive
 * without a budget PR behind it.
 */
export const DOC_BUDGETS: Readonly<Record<string, number>> = {
  // #955 — recalibrated at ×1.10 (2200 → 10.0%). Lower than the previous
  // 2423 because the raise was paid for by trimming this repo's own prose
  // (536 → 427 words); the 12 managed blocks inside it are not editable here.
  "CLAUDE.md": 2420,
  // #930 — the prose surface self-hosted at this repo's root. Like `CLAUDE.md`
  // above, it is a RENDERED file, not a source asset, so it matches no
  // `MANAGED_ASSET_PATHSPECS` glob and is listed here explicitly. Same ceiling
  // as `PROSE_WRAPPER_CEILINGS["navori-agents"]` (this file, below) — that one
  // measures the `navori-agents` BLOCK alone for `doctor`'s per-repo report;
  // this one measures the WHOLE file for navori's own hard gate. They differ
  // by the ~12 words of the seeded user-section outside the marker.
  "AGENTS.md": 4530, // 4128 → 9.7%

  // Core managed blocks — auto-discovered from `core-assets/managed/`.
  // Entries recalibrated in #955 carry `// <measured> → <headroom>` at ×1.10.
  "packages/core/core-assets/managed/arranque-sesion.md": 209, // 190 → 10.0%
  "packages/core/core-assets/managed/cierre-sesion.md": 494, // 449 → 10.0%
  "packages/core/core-assets/managed/code-discovery-routing.md": 160,
  "packages/core/core-assets/managed/codex-cross-review.md": 180,
  "packages/core/core-assets/managed/formato-respuesta.md": 150,
  "packages/core/core-assets/managed/idioma-rol.md": 140,
  "packages/core/core-assets/managed/intake-tickets.md": 251, // 228 → 10.1%
  "packages/core/core-assets/managed/operaciones-seguras.md": 310,
  "packages/core/core-assets/managed/orquestacion.md": 1060, // 963 → 10.1%
  "packages/core/core-assets/managed/sdd.md": 208, // 189 → 10.1%
  "packages/core/core-assets/managed/tipado-fuerte.md": 50,

  // Plugin managed blocks (#917). Measured / ceiling → headroom.
  "packages/plugins/acli/managed/acli-protocol.md": 80, // 70 → 14.3%
  "packages/plugins/codegraph/managed/codegraph-search-v2.md": 105, // 91 → 15.4%
  "packages/plugins/gh/managed/gh-protocol.md": 120, // 107 → 12.1%
  "packages/plugins/jscpd/managed/jscpd-protocol.md": 90, // 80 → 12.5%
  "packages/plugins/semgrep/managed/semgrep-protocol.md": 105, // 93 → 12.9%
  "packages/plugins/tgrep/managed/tgrep-search-v2.md": 115, // 104 → 10.6%

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

/** One `.claude/context/*.md` file, as measured before delivery is decided. */
export interface ContextDeliveryFile {
  /** Repo-relative path, e.g. `.claude/context/10-orquestacion.md`. */
  path: string;
  /** Body length in code points — what the hook's `${#body}` counts under a
   *  UTF-8 locale, not bytes. `content.length` on a JS string matches this for
   *  the accented BMP prose these files carry. */
  chars: number;
}

/** Whether the SessionStart hook delivered a section's body, or replaced it
 *  with a one-line pointer to the file (`add_bounded`). */
export type ContextDeliveryStatus = "inline" | "pointer";

/** A `ContextDeliveryFile` plus the delivery decision `simulateContextDelivery` made for it. */
export interface ContextDeliveryResult extends ContextDeliveryFile {
  delivered: ContextDeliveryStatus;
  /**
   * Characters already queued by everything AHEAD of this file in delivery
   * order (their bodies or pointers, plus one separator char each) at the
   * moment this file's own fit is decided. This is what attributes the
   * degradation correctly (#919): the file that shows as `pointer` is rarely
   * the one whose growth caused it — it is whichever file EARLIER in the
   * order consumed the budget this file needed.
   */
  ctxCharsBefore: number;
}

/**
 * The exact text `add_bounded` emits in place of a section that doesn't fit
 * (`session-start-context.sh`'s pointer branch), needed to keep the running
 * total this function tracks equal to the hook's own `ctx` — a pointer is
 * shorter than most bodies, so a later file's fit can flip back to `inline`
 * once an earlier one degrades, and only the hook's own text length predicts
 * that correctly.
 */
function contextPointerChars(path: string, bodyChars: number): number {
  return `[navori] '${path}' no cabe en el contexto de arranque (${bodyChars} caracteres). LÉELO con Read antes de decidir cómo abordar la tarea: contiene doctrina que ninguna otra vía te entrega.`
    .length;
}

/**
 * Reproduces `add_bounded` (`session-start-context.sh:403-410`) in TypeScript,
 * so the delivery decision it makes once per session (silently, at runtime)
 * can be reported at gate/`doctor` time instead (#919).
 *
 * Two properties this MUST preserve to stay a faithful mirror, not a second,
 * driftable implementation of the same rule:
 *
 * - ACCUMULATIVE, IN ORDER: `files` must already be in delivery order (the
 *   hook's plain alphabetical glob over `.claude/context/*.md`, which the
 *   numeric filename prefix turns into `ORCHESTRATOR_CONTEXT_ORDER`,
 *   `engines/claude/index.ts`). This function does not re-sort or re-derive
 *   that order — sort your input the same way the hook globs it.
 * - THE SEPARATOR COUNTS: the hook calls `add ""` before every `add_bounded`
 *   (a blank line between sections), which appends one character to `ctx`
 *   BEFORE the fit check for that file runs. Skipping it would let a file at
 *   exactly the boundary come out `inline` here while the hook ships it as
 *   `pointer`.
 */
export function simulateContextDelivery(
  files: readonly ContextDeliveryFile[],
  budgetChars: number = SESSION_CONTEXT_DELIVERY_BUDGET_CHARS,
): ContextDeliveryResult[] {
  let ctx = 0;
  const results: ContextDeliveryResult[] = [];
  for (const file of files) {
    ctx += 1; // `add ""` — the blank separator line the hook writes before every section
    const ctxCharsBefore = ctx;
    if (ctx + file.chars <= budgetChars) {
      results.push({ ...file, delivered: "inline", ctxCharsBefore });
      ctx += file.chars + 1; // `add "$body"` appends a trailing newline
    } else {
      const pointerChars = contextPointerChars(file.path, file.chars);
      results.push({ ...file, delivered: "pointer", ctxCharsBefore });
      ctx += pointerChars + 1; // `add "$pointer"`, same trailing newline
    }
  }
  return results;
}

/**
 * Codex's hard cap on the concatenated project instructions, in BYTES
 * (`project_doc_max_bytes`, default 32 KiB). Verified live against
 * `https://learn.chatgpt.com/docs/agent-configuration/agents-md` on 2026-09-22:
 *
 *   "Codex concatenates files from the root down, joining them with blank
 *    lines. […] Codex skips empty files and stops adding files once the
 *    combined size reaches the limit defined by `project_doc_max_bytes`
 *    (32 KiB by default)."
 *
 * Two things make this unlike every other number in this module. It is in
 * BYTES, not words — a word ceiling, however well calibrated, cannot detect
 * this condition. And its failure mode is SILENT TRUNCATION: Codex stops adding
 * files and says nothing, so the guidance that never arrived looks exactly like
 * guidance the model chose to ignore.
 *
 * The chain also includes files navori does not write — the user's
 * `~/.codex/AGENTS.md` and any nested `AGENTS.md` — so a repo's own share is a
 * LOWER bound on what is consumed. That is precisely why this is REPORTED and
 * never capped: navori knows its own contribution, not the total.
 */
export const CODEX_PROJECT_DOC_MAX_BYTES = 32768;

/**
 * Share of `CODEX_PROJECT_DOC_MAX_BYTES` at which the report turns the
 * `AGENTS.md` line yellow. Advisory only — it never reaches the health verdict.
 *
 * 80% is a deliberate choice, not a round number picked for looks: navori's own
 * `AGENTS.md` measures 26927 bytes = 82.2% of the cap today, so this repo is the
 * first one the warning fires in. A threshold that spared the author would be a
 * threshold nobody validated.
 */
export const CODEX_PROJECT_DOC_WARN_RATIO = 0.8;

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
 * Ceiling for the SINGLE wrapper block a prose engine renders everything into
 * (#930). `codex` and `agents-md` both stamp `managedId: "navori-agents"`
 * (`engines/codex/index.ts`, `engines/agents-md/index.ts`) around the whole
 * body `renderProseFile` builds — core rule blocks, the active preset's stack,
 * the skills index, a short workflow summary, and (Codex only) plugin
 * sub-blocks. Unlike every entry in `DOC_BUDGETS`, this id has no source `.md`
 * asset to measure headroom against, and it CANNOT be keyed there: neither
 * `PRESET_STACK_RE` nor `MANAGED_ASSET_RE` below matches a bare `AGENTS.md`.
 *
 * `locateManagedBlocks` treats a managed body as OPAQUE (`marker.ts`'s
 * `proseLines` jumps a block's nested markers), so this wrapper is measured as
 * ONE block — no per-sub-block ceiling exists without migrating the file's
 * marker topology across every `agents-md`/`codex` repo in the registry
 * (`#930`'s "Approach B", deferred to a spec of its own). A FLAT ceiling here
 * is therefore an approximation: it cannot scale with a consumer's own
 * preset/plugin choices the way every other entry in this file does.
 *
 * It exists so the axis stops reading `ceiling 0` / `unbudgeted 100%` by
 * construction — informative for every OTHER repo's `doctor`
 * (`commands/doctor.ts`'s `scanDocBudget` never feeds `computeHealthVerdict`,
 * so it never fails their build). navori's own HARD gate for its self-hosted
 * `AGENTS.md` is a separate, simpler mechanism: the whole-file `"AGENTS.md"`
 * entry in `DOC_BUDGETS` above, checked by `check-doc-budgets.mjs`'s plain
 * per-path loop — same standing as `CLAUDE.md`. Both numbers are calibrated
 * from the SAME measurement and happen to share a value; they are not the
 * same table (see the comment on that entry for why they can drift by a few
 * words).
 *
 * Measured 4116 words for the `navori-agents` block in THIS repo's own
 * `AGENTS.md` (codex engine, plugin sub-blocks included) → ceiling below
 * carries ~10% headroom over that.
 */
export const PROSE_WRAPPER_CEILINGS: Readonly<Record<string, number>> = {
  "navori-agents": 4530,
};

/**
 * Ceiling per RENDERED managed-block id, derived from `DOC_BUDGETS` plus
 * `PROSE_WRAPPER_CEILINGS` — never a third table. The block id is the asset's
 * basename for core and plugin blocks (`operaciones-seguras.md` →
 * `operaciones-seguras`) and `stack-<preset>` for a preset's `stack.md`, which
 * is how every `presets/*.json` declares it.
 *
 * `MARKER_PAIR_WORDS` is added only to the `DOC_BUDGETS` half: those ceilings
 * are measured on source assets that carry no markers. `PROSE_WRAPPER_CEILINGS`
 * is measured directly on the RENDERED file, markers included, so it is merged
 * as-is.
 */
export function managedBlockCeilings(): Record<string, number> {
  const out: Record<string, number> = { ...PROSE_WRAPPER_CEILINGS };
  for (const [path, ceiling] of Object.entries(DOC_BUDGETS)) {
    const preset = PRESET_STACK_RE.exec(path);
    const id = preset ? `stack-${preset[1]}` : MANAGED_ASSET_RE.exec(path)?.[1];
    if (id) out[id] = ceiling + MARKER_PAIR_WORDS;
  }
  return out;
}
