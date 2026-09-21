import type { NavoriConfig } from "../../lib/config.ts";

/**
 * Canonical description of one core agent: its filename id, the
 * `config.harness` boolean key that enables/disables it, and its sandbox
 * posture (spec 0026 T8, R38/R42).
 *
 * THE single source of truth for the roster. Before this, the same id list
 * was hand-copied into `CORE_AGENTS` (`harness-assets.ts`), `AGENT_ROLE_KEYS`
 * (`lib/config.ts`), `AGENT_ROLES` (`lib/plugins.ts`),
 * `CANONICAL_HARNESS_KEY`/`LEGACY_AGENT_ALIASES` targets (`lib/legacy-agents.ts`),
 * `RECOMMENDED_MODELS`/`RECOMMENDED_EFFORT` keys (`lib/recommended.ts`) and
 * `agentsIndex.when` keys (`lib/i18n.ts`) — six places to remember on every
 * rename, none of them tied together by a test. `roster-parity.test.ts` fails
 * the moment any of those derived lists drifts from `ROSTER_AGENTS` (R42).
 *
 * Renaming the roster itself (spec 0026 lote 2, T11+) is NOT this file's job:
 * today it still lists the pre-rename eight ids, unchanged. It only stops the
 * duplication; the rename lands as its own batch so `CORE_AGENTS`, the six
 * derived catalogs above and every asset that names an id move together.
 */
export interface RosterAgent {
  readonly id: string;
  readonly harnessKey: keyof NonNullable<NavoriConfig["harness"]>;
  readonly sandbox?: "read-only" | "workspace-write";
}

export const ROSTER_AGENTS: ReadonlyArray<RosterAgent> = [
  { id: "orchestrator", harnessKey: "orchestrator" },
  { id: "implementer", harnessKey: "implementer" },
  { id: "reviewer", harnessKey: "reviewer", sandbox: "workspace-write" },
  { id: "scout", harnessKey: "scout", sandbox: "workspace-write" },
  { id: "auditor", harnessKey: "auditor", sandbox: "workspace-write" },
  { id: "publisher", harnessKey: "publisher" },
  // Scribe serializes verified producer payloads into transient handoff
  // artifacts, so it needs workspace-write without production-code authority.
  { id: "scribe", harnessKey: "scribe", sandbox: "workspace-write" },
  // Spec 0026 F (T19, R47/R48): design-only, writes solution_<scope>.md to
  // `.claude/progress/`, so it needs the same workspace-write posture as
  // scout/auditor/reviewer, not the read-only default.
  { id: "architect", harnessKey: "architect", sandbox: "workspace-write" },
];

/**
 * Agent ids that appear in `agentsIndex.when` (the i18n "when to reach for
 * each agent" table) — every roster agent except `orchestrator`, whose casing
 * is described by the embodied "## Role: orchestrator" prose instead of a
 * subagent entry a session would `Agent(...)` launch.
 */
export const ROSTER_INDEXED_AGENT_IDS: ReadonlyArray<string> = ROSTER_AGENTS.map(
  (agent) => agent.id,
).filter((id) => id !== "orchestrator");

/**
 * spec 0026 T14 (R29): `debug-error` + `loop-back-debug` merged into
 * `debug-failure`, `structural-search` → `locate-code`, `security-guidance` →
 * `security-invariants`. `RETIRED_SKILLS` below carries the old ids so an
 * already-onboarded repo gets them pruned (R38/R39).
 */
export const ROSTER_CORE_SKILLS: ReadonlyArray<string> = [
  "verify-before-done",
  "debug-failure",
  "review-diff",
  "security-invariants",
  "secure-by-design",
  "locate-code",
];

/**
 * spec 0026 T14 (R29): `ticket-intake` → `resolve-ticket`, `babysit-prs` →
 * `follow-up-prs`. Same rename contract as `ROSTER_CORE_SKILLS` above.
 */
export const ROSTER_WORKFLOW_SKILLS: ReadonlyArray<string> = [
  "resolve-ticket",
  "solution-design",
  "spec-bootstrap",
  "dominio",
  "follow-up-prs",
  "quality-attributes",
];

/** The two adapters that place a managed marker, and so can retire one. */
export type RetiredAdapter = "claude" | "codex";

/**
 * One retired id, kept forever (append-only, #702/#774): the id itself, the
 * successor it was folded into (or `null`), and the REAL managed-marker id
 * navori stamped into the file it once rendered, per adapter.
 *
 * `markerIdByAdapter` matters because the marker is not always the bare id:
 * Claude core agents and core skills carry `<id>-base`, Codex agents carry
 * `<id>-codex-base` (`engines/codex/index.ts` stamps a separate namespace to
 * avoid colliding with Claude's own `<id>-base` on a shared filesystem),
 * while workflow skills and hooks keep one explicit marker shared by both
 * adapters (`engines/shared/harness-plan.ts` stamps the same `managedId` for
 * both). Reconciliation (spec 0026 T10) reads this field instead of
 * re-deriving a marker from the bare id — passing the bare id straight to
 * `isRemovableNavoriFile` is exactly the bug this registry exists to close:
 * a retired CORE skill (marker `<id>-base`) would look "foreign" under its
 * bare id and never get pruned.
 */
export interface Retired {
  readonly id: string;
  readonly successor: string | null;
  readonly markerIdByAdapter: Readonly<Partial<Record<RetiredAdapter, string>>>;
}

/**
 * Agents navori USED to ship and no longer does (spec 0026 T11, R38/R39):
 * `leader` → `orchestrator`, `explorer`/`researcher` → `scout`, `ticket-audit`
 * → `auditor`, `commit-pr-pilot` → `publisher`. Seeded in the SAME commit that
 * stops `ROSTER_AGENTS` from rendering these five ids — the invariant
 * `RETIRED_AGENTS` documented while it shipped empty (spec 0026 T8): an entry
 * never appears here while `ROSTER_AGENTS` still renders it, or `render
 * --apply` would delete the file it had just written.
 */
export const RETIRED_AGENTS: ReadonlyArray<Retired & { readonly harnessKey: string }> = [
  {
    id: "leader",
    successor: "orchestrator",
    harnessKey: "orchestrator",
    markerIdByAdapter: { claude: "leader-base", codex: "leader-codex-base" },
  },
  {
    id: "explorer",
    successor: "scout",
    harnessKey: "scout",
    markerIdByAdapter: { claude: "explorer-base", codex: "explorer-codex-base" },
  },
  {
    id: "researcher",
    successor: "scout",
    harnessKey: "scout",
    markerIdByAdapter: { claude: "researcher-base", codex: "researcher-codex-base" },
  },
  {
    id: "ticket-audit",
    successor: "auditor",
    harnessKey: "auditor",
    markerIdByAdapter: { claude: "ticket-audit-base", codex: "ticket-audit-codex-base" },
  },
  {
    id: "commit-pr-pilot",
    successor: "publisher",
    harnessKey: "publisher",
    markerIdByAdapter: { claude: "commit-pr-pilot-base", codex: "commit-pr-pilot-codex-base" },
  },
];

/**
 * Skills navori USED to ship and no longer does. Append-only (#702): an entry
 * is a historical fact, so it is never removed once added.
 *
 * `pr-create` — folded into `commit-pr-pilot` (#703), no successor recorded
 * beyond that merge — was a WORKFLOW skill, whose managed marker is the bare
 * id itself (`engines/shared/harness-plan.ts` stamps `managedId: id` for
 * workflow skills, not `<id>-base`).
 *
 * spec 0026 T14 (R29/R30/R38): `debug-error` and `loop-back-debug` merged
 * into `debug-failure`; `structural-search` → `locate-code`; `security-guidance`
 * → `security-invariants` — all three were CORE skills, so their real marker
 * is `<id>-base` (both adapters, `harness-plan.ts` stamps `managedId: \`${id}-base\``
 * for `CORE_SKILLS`). `ticket-intake` → `resolve-ticket` and `babysit-prs` →
 * `follow-up-prs` were WORKFLOW skills, whose marker is the bare id, same as
 * `pr-create` above. Seeded in the SAME commit that stops `ROSTER_CORE_SKILLS`
 * / `ROSTER_WORKFLOW_SKILLS` from rendering these six ids.
 */
export const RETIRED_SKILLS: ReadonlyArray<Retired> = [
  {
    id: "pr-create",
    successor: null,
    markerIdByAdapter: { claude: "pr-create", codex: "pr-create" },
  },
  {
    id: "debug-error",
    successor: "debug-failure",
    markerIdByAdapter: { claude: "debug-error-base", codex: "debug-error-base" },
  },
  {
    id: "loop-back-debug",
    successor: "debug-failure",
    markerIdByAdapter: { claude: "loop-back-debug-base", codex: "loop-back-debug-base" },
  },
  {
    id: "structural-search",
    successor: "locate-code",
    markerIdByAdapter: { claude: "structural-search-base", codex: "structural-search-base" },
  },
  {
    id: "security-guidance",
    successor: "security-invariants",
    markerIdByAdapter: { claude: "security-guidance-base", codex: "security-guidance-base" },
  },
  {
    id: "ticket-intake",
    successor: "resolve-ticket",
    markerIdByAdapter: { claude: "ticket-intake", codex: "ticket-intake" },
  },
  {
    id: "babysit-prs",
    successor: "follow-up-prs",
    markerIdByAdapter: { claude: "babysit-prs", codex: "babysit-prs" },
  },
];

/**
 * Hooks navori USED to ship and no longer does. Append-only, same contract as
 * `RETIRED_SKILLS`.
 *
 * `precompact-session-summary` (#774) — no channel to the model, folded into
 * `session-start-context.sh`'s `SessionStart(compact)` branch, no distinct
 * successor id — carries the `<id>-base` marker every hook gets
 * (`planRetiredHookRemoval` stamps `${id}-base`, shared by both adapters:
 * Codex's `placeHook` reuses the same `managedId` the shared plan computed).
 */
export const RETIRED_HOOKS: ReadonlyArray<Retired> = [
  {
    id: "precompact-session-summary",
    successor: null,
    markerIdByAdapter: {
      claude: "precompact-session-summary-base",
      codex: "precompact-session-summary-base",
    },
  },
  {
    id: "pr-pilot-confirm",
    successor: "pr-publisher-confirm",
    markerIdByAdapter: {
      claude: "pr-pilot-confirm-base",
      codex: "pr-pilot-confirm-base",
    },
  },
];

/**
 * Assert that `actual` (some other catalog's id list) has exactly the members
 * of `expected` (the canonical roster list), order-independent. Throws with
 * both sides on mismatch, naming `catalogName` so the failure points straight
 * at the drifted file (R42).
 *
 * A test helper, not a runtime guard fired on every render: the catalogs it
 * checks are static TypeScript source, so their drift is a compile-time-shaped
 * mistake that a single `roster-parity.test.ts` run catches once per CI run —
 * paying the check on every render would buy nothing a test doesn't already.
 */
export function assertRosterIds(
  catalogName: string,
  expected: readonly string[],
  actual: readonly string[],
): void {
  const expectedSorted = [...expected].sort();
  const actualSorted = [...actual].sort();
  const missing = expectedSorted.filter((id) => !actualSorted.includes(id));
  const extra = actualSorted.filter((id) => !expectedSorted.includes(id));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `${catalogName} diverges from the canonical roster — missing: [${missing.join(", ")}], extra: [${extra.join(", ")}]`,
    );
  }
}
