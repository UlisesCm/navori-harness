import { RETIRED_AGENTS, RETIRED_SKILLS, type Retired } from "../engines/shared/roster.ts";

/**
 * One retired-with-a-successor id's classification for
 * `scripts/mine-activation.py`'s continuity accounting (#869): does the
 * miner's `canon_role`/`canon_skill` need to fold the old id into the new one,
 * or is there a documented reason it must not?
 *
 * `include: false` is not a gap — the R38 registries (`RETIRED_AGENTS`,
 * `RETIRED_SKILLS`) exist to name every rename FOREVER regardless of whether a
 * downstream consumer cares about it, and the miner's `mark()` only tracks
 * opportunities under a fixed set of keys (`agent="implementer"`,
 * `agent="publisher"`, `agent="reviewer"`, a handful of `skill=...`). A
 * retired id whose successor is never checked under one of those keys cannot
 * cause a miscount either way, so forcing it into the alias map would just be
 * dead weight — but the decision has to be explicit and reasoned, not a
 * silent omission, or the next rename could go either way by accident.
 */
export interface AliasDecision {
  readonly id: string;
  readonly successor: string;
  readonly include: boolean;
  readonly reason: string;
}

/**
 * Require every retired-with-a-successor id in `retired` to have exactly one
 * matching entry in `decisions` (no more, no less), and return `decisions`
 * unchanged when it holds.
 *
 * This is the mechanism #869 asks for: a NEW retiree that gains a successor
 * (`RETIRED_AGENTS`/`RETIRED_SKILLS` grow — they are append-only) throws here
 * until someone adds a decision for it, `include: true` or `include: false`
 * WITH a reason either way. Naive derivation (alias = every successor) would
 * silently re-add the four excluded role ids on the next unrelated change;
 * this instead makes silence impossible.
 */
export function requireDecisions(
  catalogName: string,
  retired: ReadonlyArray<Retired>,
  decisions: ReadonlyArray<AliasDecision>,
): ReadonlyArray<AliasDecision> {
  const renamed = retired.filter((r) => r.successor !== null);
  const decisionIds = new Set(decisions.map((d) => d.id));
  const missing = renamed.filter((r) => !decisionIds.has(r.id)).map((r) => r.id);
  if (missing.length > 0) {
    throw new Error(
      `${catalogName} gained a renamed retiree with no activation-alias decision: [${missing.join(", ")}]. ` +
        "Add an entry to the matching decisions list in activation-aliases.ts: include:true if " +
        "mine-activation.py should fold the old id into the new one, include:false with a documented " +
        "reason if not.",
    );
  }
  const renamedIds = new Set(renamed.map((r) => r.id));
  const stale = decisions.filter((d) => !renamedIds.has(d.id)).map((d) => d.id);
  if (stale.length > 0) {
    throw new Error(
      `${catalogName} activation-alias decisions reference ids no longer retired-with-a-successor: ` +
        `[${stale.join(", ")}]. Remove the stale entry from activation-aliases.ts.`,
    );
  }
  return decisions;
}

/**
 * `commit-pr-pilot` → `publisher` is the only rename mine-activation.py's raw
 * `subagent_type` strings can observe: O4/O5's `mark()` calls check
 * `agent="publisher"`/`agent="reviewer"` under those fixed keys. `leader`,
 * `explorer`, `researcher` and `ticket-audit` are excluded on purpose — no
 * `mark()` call in that script checks `agent="orchestrator"`, `"scout"` or
 * `"auditor"`, so folding those old ids in would be dead weight, not a fix.
 * If a future opportunity starts tracking one of those roles, this list is
 * exactly where that decision has to be flipped to `include: true`.
 */
const ROLE_ALIAS_DECISIONS: ReadonlyArray<AliasDecision> = [
  {
    id: "commit-pr-pilot",
    successor: "publisher",
    include: true,
    reason:
      'the only rename mine-activation.py observes: O4/O5 mark() calls check agent="publisher"/"reviewer"',
  },
  {
    id: "leader",
    successor: "orchestrator",
    include: false,
    reason: 'no mark() call in mine-activation.py checks agent="orchestrator" under a fixed key',
  },
  {
    id: "explorer",
    successor: "scout",
    include: false,
    reason: 'no mark() call in mine-activation.py checks agent="scout" under a fixed key',
  },
  {
    id: "researcher",
    successor: "scout",
    include: false,
    reason: 'no mark() call in mine-activation.py checks agent="scout" under a fixed key',
  },
  {
    id: "ticket-audit",
    successor: "auditor",
    include: false,
    reason: 'no mark() call in mine-activation.py checks agent="auditor" under a fixed key',
  },
];

/**
 * All six current skill renames feed a `mark(..., skill=...)` check
 * (`debug-failure`, `locate-code`, `security-invariants`, `resolve-ticket`,
 * `follow-up-prs`), so every one of them is included today. `pr-create` is
 * absent from `RETIRED_SKILLS` decisions entirely — its `successor` is
 * `null`, so `requireDecisions` never asks for a classification of it.
 */
const SKILL_ALIAS_DECISIONS: ReadonlyArray<AliasDecision> = [
  {
    id: "debug-error",
    successor: "debug-failure",
    include: true,
    reason: 'O3 mark() checks skill="debug-failure"',
  },
  {
    id: "loop-back-debug",
    successor: "debug-failure",
    include: true,
    reason: 'O6 mark() checks skill="debug-failure"',
  },
  {
    id: "structural-search",
    successor: "locate-code",
    include: true,
    reason: "continuity accounting for the merged skill id",
  },
  {
    id: "security-guidance",
    successor: "security-invariants",
    include: true,
    reason: "continuity accounting for the renamed skill id",
  },
  {
    id: "ticket-intake",
    successor: "resolve-ticket",
    include: true,
    reason: "continuity accounting for the renamed skill id",
  },
  {
    id: "babysit-prs",
    successor: "follow-up-prs",
    include: true,
    reason: "continuity accounting for the renamed skill id",
  },
];

/** Decisions the generator and the drift test both read, grouped by catalog. */
export function roleAliasDecisions(): ReadonlyArray<AliasDecision> {
  return requireDecisions("RETIRED_AGENTS", RETIRED_AGENTS, ROLE_ALIAS_DECISIONS);
}

export function skillAliasDecisions(): ReadonlyArray<AliasDecision> {
  return requireDecisions("RETIRED_SKILLS", RETIRED_SKILLS, SKILL_ALIAS_DECISIONS);
}

/** `{ oldId: newId }` for the `include: true` role decisions. */
export function roleAliases(): Record<string, string> {
  return Object.fromEntries(
    roleAliasDecisions()
      .filter((d) => d.include)
      .map((d) => [d.id, d.successor]),
  );
}

/** `{ oldId: newId }` for the `include: true` skill decisions. */
export function skillAliases(): Record<string, string> {
  return Object.fromEntries(
    skillAliasDecisions()
      .filter((d) => d.include)
      .map((d) => [d.id, d.successor]),
  );
}
