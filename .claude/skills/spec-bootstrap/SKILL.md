---
name: spec-bootstrap
description: Use when starting a real-scope feature before writing code — scaffolds a complete SDD spec (requirements/design/tasks) with EARS and R<n>↔test traceability.
type: reference
maxWords: 650
---

<!-- navori:managed id="spec-bootstrap" hash="f4da05fc" version="0.6.2" source="@navori/core" -->
# spec-bootstrap — kickoff of an SDD spec

## When to use this skill

When SDD-scope work has been agreed with the user. The threshold and its opt-in gate live in ONE place — the **Spec Driven Development** block in `CLAUDE.md`; don't re-decide them here, and don't scaffold a spec nobody accepted.

Produces `specs/<feature>/{requirements.md, design.md, tasks.md}` ready for the `leader` to decompose. The scaffolding is done by the main agent (or the `researcher`), not a nested subagent.

## Order

1. **requirements.md first.** No clear requirements, no design. Derive from the ticket/request; each requirement is EARS with id `R<n>`.
2. **design.md** — how to meet those `R<n>`: affected components, contracts, decisions and trade-offs. Reference the `R<n>` each decision satisfies. Design BEFORE decomposing: an architecture decision (a contract, who owns a piece of state, a migration path) moves the natural task boundaries, so tasks written first get rewritten.
3. **tasks.md** — batches of 1-3 tasks; each task lists the `R<n>` it covers and its test(s).
4. **`evals.md` — optional, and rare.** Only when the feature ships a new **always-on layer** (context every session pays for), where prose can't prove behavior moved: `specs/<feature>/evals.md` tabulates RED (the scenario without the layer) / GREEN (the same scenario with it) over ONE isolated variable — same ticket, same repo, same model — with named scenarios, each failure against its evidence, and inverted results kept exactly as they came out. The raw transcript dies with the session; the distilled table survives in git, which is why the artifact lives with the spec.

The reasoning that fills `design.md` is the `solution-design` skill — same dimensions, and it's also the lighter home for an R2-architectural change that doesn't earn a full spec.

## Templates

`requirements.md`:
```md
# <Feature> — Requirements

## Context
<1-2 lines: what problem it solves and for whom.>

## Requirements (EARS)
- **R1** — The system SHALL <observable action>.
- **R2** — WHEN <event>, the system SHALL <action>.
- **R3** — IF <undesired condition> THEN the system SHALL <containment action>.
```

`design.md` — the first three sections always; the rest ONLY when the feature
actually raises them (an empty section is noise, not rigor):
```md
# <Feature> — Design

## Approach
<Chosen architecture and why. Discarded trade-offs.>

## Components
- <file/module> — <responsibility> — covers R<n>.

## Decisions
- <non-obvious decision> — <reason>.

## Contracts            ← if it touches an API/DTO/schema/event
## Failure modes        ← if it has partial failure, retries, concurrency
## Migration            ← if data or an existing contract changes shape
## Testing strategy     ← each test answers a risk named above, not a coverage quota
## NOT in scope         ← deferred work + why, so nobody "improves things along the way"
```

`tasks.md`:
```md
# <Feature> — Tasks

- [ ] **T1** (R1, R2) — <what gets implemented> · test: <file>::<case> with `// Covers: R1, R2`
- [ ] **T2** (R3) — <what gets implemented> · test: <file>::<case> with `// Covers: R3`
```

## Hard rules

- **Zero unresolved placeholders.** Don't leave `<...>` in the final spec; if you don't know a value, it's a question for the user, not a hole. Same rule inside a task: "TBD", "implement later", "add appropriate error handling" or "similar to T<n>" describe nothing — name the observable behavior and the evidence expected. That is NOT a licence to dictate the code line by line; the implementer keeps its judgment.
- **Every `R<n>` ends in ≥1 task and ≥1 test.** A requirement with no task or test isn't traceable → it doesn't enter the spec.
- **Tracking lives in `tasks.md`, not in `TaskCreate`.** See the SDD block.
- **Self-review before closing the scaffolding:** is each `R<n>` a single testable action? does each task point to real `R<n>`? does the design cover all the `R<n>`? If something fails, fix it before handing the spec to the `leader`.
<!-- /navori:managed id="spec-bootstrap" -->
