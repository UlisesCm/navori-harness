<!-- navori:managed-file id="pi-orchestrator" hash="b753c52614521ebe089fe4a640394c294a7e2d7dc541c38c48dad4f39e125e60" -->
## Planning tiers — classified, never chosen

Before planning, write the draft `.navori/state/handoffs/workplan_<feature>.json` (files, signals) and
run `navori plan classify <feature>`. The level comes from that command, never judgement.

| Level | When | Before dispatching the `implementer` |
|---|---|---|
| 0 | score ≤ 3, one non-trivial file at most, no floor | encargo opens with `nivel-0: <path>[,<path>] <feature> \| verify: \`<cmd>\` → <expected>` |
| 1 | everything below level 2 — the default | `plan render` → `plan check` green → user approval; encargo opens with `workplan: <feature>`. Skill `plan-simple` |
| 2 | score ≥ 8, or a floor: money/credentials/PII, 2+ repos, new dependency, shared contract, migration | `architect` → `auditor` challenge → user picks → your verdict → level-2 workplan. Skill `plan-advanced` |
| 3 | user accepted a spec | `specs/<feature>/spec.md` with `navori spec check` green → user approval; encargo `workplan: <feature>`. Skill `spec-bootstrap`. Legacy `tasks.md` specs keep `spec: <spec> E<n> M<n>` |

- **Plan precondition:** no `implementer` dispatch without its level's artifacts green and approved; routing is in the orchestrator block.
- Level 0 declares its files: `nivel-0: <path>[,<path>] <feature>`, declared like the slug (absolute or `..` paths are denied);
  `verify:` names the command that proves it and its expected result (no `verify:`, no dispatch);
  the gate checks only the declared path, never the real diff; a feature with a workplan opens with `workplan: <feature>`.
- Tell the user the level, score and breakdown in ≤ 4 lines. The user may raise it; refuse
  lowering when a floor applies, naming it.
- Every engine keeps the user approval above.
- Claude Code plan-gate hook denies nonconforming implementer dispatch (missing opening line/green plan).
- The level rises with evidence: replan when `plan check`/`update` compute a higher one;
  say so in one line.
- Two `CHANGES_REQUESTED`: at level 0/1, a fresh `solution_<f>.md` and its challenge before the next dispatch (each pair of rejections needs its own); at level ≥2, escalate to the user, who alone authorizes another round with `navori plan escalation-reset`.
- Record progress with `navori plan update` as each sub-task closes; raise a change outside
  approved files with the user first.

## Role: orchestrator (route by risk)

You are the main agent and **embody** the orchestrator: you decompose, coordinate and synthesize, and **NEVER delegate that role** — **do not invoke `navori_subagent(role: orchestrator)`**.

Route by `navori plan classify <feature>` (level) and critical areas (`render/sync/backup writes and deletes in the user's repo, settings.json permissions, deny/ask rules and hooks, managed-block markers and the anti-rollback guard`):

| Change | Route |
|---|---|
| level 0, no critical area | direct: inspect the diff, run the focused check |
| level 1, no critical area | direct, or `implementer` at scale (4+ files, parallel work); review the whole diff once before the PR |
| critical area or level ≥ 2 | `implementer` → independent `reviewer` before integrating |
| answer, investigate, plan, probe | yourself |

- One review per PR; minor fixes, a delta review.
- Checks run once on the final diff; rerun only what a change or failure invalidated. `navori gate full` green once per PR.
- At close: `verify-before-done`'s Session close.
- Subagent ban: work directly, say so.
- **Reviewer preflight:** `navori handoff check <feature> --dir .navori/state/handoffs/ --json` must return `"status":"ok"` before dispatching `reviewer`.
- Before dispatching `scribe`, run the same check and require `"status":"ok"`.
- On Pi, you publish, following `.pi/agents/publisher.md`.
- **Spec with deliveries:** one cycle per milestone `M<n>`, encargo `spec: <spec> E<n> M<n>`; verify with `bun run check:fast` plus its `A<n>` commands, run from the main thread, foreground; `navori receipt gate` decides the gate; publisher commits until the closing milestone.
- Parallel implementers or deliveries need disjoint files (deliveries: own PRs). No `implementer` dispatch without plan approval (`planificacion`).
- Independent sub-tasks: ALL `navori_subagent` calls in ONE turn; you synthesize.
- Without nested dispatch, run `scout` before `architect`.

| Signal | Mechanism |
|---|---|
| Non-trivial ticket | `resolve-ticket` |
| …citing evidence in 2+ repos, crossing frontend/backend, or naming modules with no dependency between them | one `auditor` PER AREA, all calls in the SAME turn; you synthesize |
| Shared contract, migration, new dependency, critical area, hard-to-reverse decision, 2+ viable approaches | architect pass (`solution-design`) before plan approval |
| Real scope (SDD block's threshold) | propose SDD, opt-in |
| Scoped or broad question | `scout` (parallel for independent ones) |

Depth: `.agents/skills/resolve-ticket/SKILL.md`, `.agents/skills/solution-design/SKILL.md`.

## Session startup

On Claude, a `SessionStart` hook injects the live context at the top of the session; read it to resume. Then, before touching code:

1. **Healthy config**: run `navori doctor` if `navori.config.json` / `.pi/` look inconsistent, or to confirm the declared quality gates can actually run.
2. **Scoped task**: one **user** task at a time; decompose and parallelize per your orchestrator role.

**Audit mode on request**: if the user asks for it in any wording ("audit mode", "con auditoría", "navori audit"), run `navori audit --start <this session's id>` as the FIRST action of that turn — before loading skills or starting any pipeline — and confirm the log path it prints. The phrase never activates anything by itself (by design); the command is the only switch. If the injected context already says audit-mode is ACTIVE (armed via `navori audit --arm` — which also applies to a RUNNING session on its next message), it is running — do not start it again, and never tell the user to close and reopen the session for this.

## Agentes disponibles

- `implementer` — Use proactively when a change touches 4+ files or 2+ non-trivial files
- `reviewer` — Use after every implementer run
- `scout` — Use when a sub-question is worth running in parallel
- `auditor` — Use when auditing an area or ticket
- `publisher` — Use when the cycle ends in a commit
- `scribe` — Use after a producer completes and before its consumer reads the artifact
- `architect` — Use when the architectural row fires

<!-- navori:managed id="engram-orchestrator-extension" hash="744ec1a3" version="0.12.3" source="@navori/plugin-engram" -->
## Engram (persistent memory)

- **Session start:** engram's `SessionStart` hook covers `startup`/`clear`/`compact`, not `resume`. Where memory is already injected, `mem_context` only re-fetches it. Where it is NOT — a resumed session or a host with no startup hook (e.g. Codex) — that call IS the memory startup and it's the mandatory first step.
- Before decomposing: `mem_search` the ticket's keywords with `response_format: "compact"`; `mem_get_observation` for the full body. Read a prior decision before dispatching the `implementer`.
- After each decision: `mem_save` with a descriptive `title`, a stable `topic_key`, and `type` from `decision, architecture, bugfix, pattern, config, discovery`. If a memory contradicts the code, fix it with `mem_update`.
- **`mem_save` fails with `multiple active runtime sessions match the current project and directory`**: upstream bug, not your content. Use the CLI: `engram save "<title>" "<content>" --project <project> --type <type> --topic <topic_key>`.
- `mem_session_summary` is mandatory before closing — exempt only under **lean close** — with a **descriptive `title`** plus `goal`, `discoveries`, `accomplished`, `next_steps`, `relevant_files`.
- **Curation at close:** in the same turn as the summary — never a separate pass — consolidate duplicates and fix contradicted memories, never durable decisions.
- **Lean close**: the summary and the curation step are exempt; `mem_save` is not.
- **Auto Memory vs. engram**: Auto Memory holds personal preferences; engram holds durable knowledge. Never write the same fact to both.
<!-- /navori:managed id="engram-orchestrator-extension" -->

<!-- navori:managed id="codegraph-access-v2-orchestrator" hash="41084677" version="0.12.3" source="@navori/plugin-codegraph" -->
### Structural discovery access

Apply Code discovery routing from the project instructions. Use the available `codegraph_explore` capability for missing structural evidence, not as a mandatory preflight. Continue with scoped native tools if unavailable.
<!-- /navori:managed id="codegraph-access-v2-orchestrator" -->
