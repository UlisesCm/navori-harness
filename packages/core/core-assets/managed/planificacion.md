## Planning tiers — classified, never chosen

Before planning, write the draft `.navori/state/handoffs/workplan_<feature>.json` (files, signals) and
run `navori plan classify <feature>`. The level comes from that command, never judgement.

| Level | When | Before dispatching the `implementer` |
|---|---|---|
| 0 | score ≤ 3, one non-trivial file at most, no floor | encargo opens with `nivel-0: <path>` |
| 1 | everything below level 2 — the default | `plan render` → `plan check` green → user approval; encargo opens with `workplan: <feature>`. Skill `plan-simple` |
| 2 | score ≥ 8, or a floor: money/credentials/PII, 2+ repos, new dependency, shared contract, migration | `architect` → `auditor` challenge → user picks → your verdict → level-2 workplan. Skill `plan-advanced` |
| 3 | user accepted a spec | `specs/<feature>/tasks.md`. Skill `spec-bootstrap` |

- Tell the user the level, score and breakdown in ≤ 4 lines. The user may raise the level; refuse
  to lower it when a floor applies, naming it.
- Both engines retain the applicable user approval in the tier flow above.
- Claude Code plan-gate hook denies nonconforming implementer dispatch (missing opening line/green plan).
- Codex plan-gate is advisory (no selective deny); reopen per #1082's versioned criteria.
- The level rises with evidence: replan when `plan check`/`update` compute a higher level, and
  say so in one line. Two `CHANGES_REQUESTED` require the next level's artifacts; at level 2 or
  3, escalate to the user.
- Record progress with `navori plan update` as each sub-task closes; raise a change outside
  approved files with the user first.
