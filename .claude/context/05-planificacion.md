<!-- navori:managed id="planificacion" hash="40327f64" version="0.12.1" source="@navori/core" -->
## Planning tiers — classified, never chosen

Before planning, write the draft `.navori/state/handoffs/workplan_<feature>.json` (files, signals) and
run `navori plan classify <feature>`. The level comes from that command, never judgement.

| Level | When | Before dispatching the `implementer` |
|---|---|---|
| 0 | score ≤ 3, one non-trivial file at most, no floor | encargo opens with `nivel-0: <path>[,<path>] <feature> \| verify: \`<cmd>\` → <expected>` |
| 1 | everything below level 2 — the default | `plan render` → `plan check` green → user approval; encargo opens with `workplan: <feature>`. Skill `plan-simple` |
| 2 | score ≥ 8, or a floor: money/credentials/PII, 2+ repos, new dependency, shared contract, migration | `architect` → `auditor` challenge → user picks → your verdict → level-2 workplan. Skill `plan-advanced` |
| 3 | user accepted a spec | `specs/<feature>/tasks.md`. Skill `spec-bootstrap`. One workplan per delivery (`<spec>-e<n>`, phases = milestones); encargo `spec: <spec> E<n> M<n>` |

- **Plan precondition:** no `implementer` dispatch without its level's artifacts green and approved;
  every code write goes through `implementer` → `reviewer`, with no inline route.
- Level 0 declares its files: `nivel-0: <path>[,<path>] <feature>`, declared like the slug (absolute or `..` paths are denied);
  `verify:` names the command that proves it and its expected result (no `verify:`, no dispatch);
  the gate checks only the declared path, never the real diff; a feature with a workplan opens with `workplan: <feature>`.
- Tell the user the level, score and breakdown in ≤ 4 lines. The user may raise the level; refuse
  to lower it when a floor applies, naming it.
- Both engines retain the applicable user approval in the tier flow above.
- Claude Code plan-gate hook denies nonconforming implementer dispatch (missing opening line/green plan).
- Codex: the plan-gate denies; one implementer at a time per session (two or more fresh `dispatch_<f>.json` stamped with the same `sessionId` deny; other sessions' markers are ignored); name a listed role on every analysis spawn.
- The level rises with evidence: replan when `plan check`/`update` compute a higher level, and
  say so in one line.
- Two `CHANGES_REQUESTED`: at level 0/1, a fresh `solution_<f>.md` and its challenge before the next dispatch (each pair of rejections needs its own); at level ≥2, escalate to the user, who alone authorizes another round with `navori plan escalation-reset`.
- Record progress with `navori plan update` as each sub-task closes; raise a change outside
  approved files with the user first.
<!-- /navori:managed id="planificacion" -->
