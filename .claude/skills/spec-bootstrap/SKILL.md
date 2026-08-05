---
name: spec-bootstrap
description: Use when starting a real-scope feature before writing code — scaffolds a complete SDD spec (requirements/design/tasks) with EARS and R<n>↔test traceability.
type: reference
---

<!-- navori:managed id="spec-bootstrap" hash="c4e8ab36" version="0.5.1" source="@navori/core" -->
# spec-bootstrap — kickoff of an SDD spec

## When to use this skill

When starting SDD-scope work (a whole new feature, changes to auth/security/sensitive data, scope > ~2 days — see the **Spec Driven Development** block in `CLAUDE.md`). Don't use it for bugfixes, UI tweaks or isolated refactors: those go straight in.

Produces `specs/<feature>/{requirements.md, design.md, tasks.md}` ready for the `leader` to decompose. The scaffolding is done by the main agent (or the `researcher`), not a nested subagent.

## Order

1. **requirements.md first.** No clear requirements, no design. Derive from the ticket/request; each requirement is EARS with id `R<n>`.
2. **design.md** — how to meet those `R<n>`: affected components, contracts, decisions and trade-offs. Reference the `R<n>` each decision satisfies.
3. **tasks.md** — batches of 1-3 tasks; each task lists the `R<n>` it covers and its test(s).

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

`design.md`:
```md
# <Feature> — Design

## Approach
<Chosen architecture and why. Discarded trade-offs.>

## Components
- <file/module> — <responsibility> — covers R<n>.

## Decisions
- <non-obvious decision> — <reason>.
```

`tasks.md`:
```md
# <Feature> — Tasks

- [ ] **T1** (R1, R2) — <what gets implemented> · test: <file>::<case> with `// Covers: R1, R2`
- [ ] **T2** (R3) — <what gets implemented> · test: <file>::<case> with `// Covers: R3`
```

## Hard rules

- **Zero unresolved placeholders.** Don't leave `<...>` in the final spec; if you don't know a value, it's a question for the user, not a hole.
- **Every `R<n>` ends in ≥1 task and ≥1 test.** A requirement with no task or test isn't traceable → it doesn't enter the spec.
- **Tracking lives in `tasks.md`, not in `TaskCreate`.** See the SDD block.
- **Self-review before closing the scaffolding:** is each `R<n>` a single testable action? does each task point to real `R<n>`? does the design cover all the `R<n>`? If something fails, fix it before handing the spec to the `leader`.
<!-- /navori:managed id="spec-bootstrap" -->
