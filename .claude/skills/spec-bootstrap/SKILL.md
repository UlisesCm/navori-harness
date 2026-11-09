---
name: spec-bootstrap
description: Use when starting a real-scope feature before writing code — scaffolds a one-page spec.md (outcome, acceptance script, states, tasks) for one vertical slice.
metadata:
  type: reference
  # One-page spec: the cap tracks the rewrite (ceil(actual × 1.10)), not the old three-file doctrine.
  maxWords: 568
  maxWordsComposed: 668
---

<!-- navori:managed id="spec-bootstrap" hash="88e35f7f" version="0.12.3" source="@navori/core" fmkeys="name,description,metadata" -->
# spec-bootstrap — kickoff of a one-page spec

## Before scaffolding — blocking precondition

Do not write anything under `specs` unless the user has explicitly accepted starting a spec in THIS thread — either by running `/spec-bootstrap` directly, or by accepting a proposal you made. No acceptance yet? Propose it and wait for the answer; never scaffold speculatively.

## When to use this skill

When SDD work meets its threshold; **the threshold and its opt-in gate live in ONE place**: the **Spec Driven Development** block in `CLAUDE.md`. Before asking acceptance, give the compact `resumen de decisión` in chat per `formato-respuesta.md`; a proposal or summary is not authorization to scaffold.

Produces `specs/<feature>/spec.md` — one file, one vertical slice, one delivery (one PR or a short series).

**Challenge on critical areas.** WHEN the spec touches `render/sync/backup writes and deletes in the user's repo, settings.json permissions, deny/ask rules and hooks, managed-block markers and the anti-rollback guard`, a fresh-context `auditor` challenges it with `solution-design`'s falsification brief before handoff. One round, no verdict — `orchestrator` decides.

## Rules

- **Vertical.** One actor reaches an observable outcome end to end, crossing every layer it needs: data and migrations, API, screens, environment, test data. No model-only, API-only or UI-only spec.
- **Done = accepted.** A human runs the acceptance script on the real surface where the outcome is observable (the deployed app, the built binary — whatever the project ships) and approves it, AND the happy-path E2E passes against that same surface, without mocks. Unit and integration tests are quality, not acceptance.
- **Behavior, not implementation.** No library versions, file paths or function signatures; the implementer decides. At most 1,200 words.
- **Cross-cutting ships inside.** Seed data, empty and error states, error reporting, new env vars or native modules are declared in the spec and delivered with the slice.

## Template

```md
# <Feature>

## Outcome
<Actor → observable result, one paragraph.>

## Acceptance script
<Environment and device.>

1. <Action>. **Expected:** <what the human sees>.
(≤10 steps, at least one error or empty state)

## Applicable rules
- <rule ID> — <one line>

## States
| State | What the user sees |
|---|---|
| Empty | ... |
| Error | ... |
| Offline | ... |
| No permission | ... |
(n/a — <why> when one cannot happen)

## Environment and data
- <env vars, external accounts, native modules, seed data the script uses>

## Out of scope
- <item> — <where it goes>

## Tasks
1. <Outcome, not a file>. (≤8)
```

Headings may use the project's language (Resultado, Guion de aceptación, Reglas aplicables, Estados, Entorno y datos, Fuera de alcance, Tareas); `navori spec check <feature>` validates sections, caps and the word limit.

## Dispatch

A level-3 workplan named `<feature>`; encargos open with `workplan: <feature>`.

## Hard rules

- **Zero unresolved placeholders.** Don't leave `<...>`; an unknown value is a question for the user, not a hole.
- **Tracking lives in `spec.md`'s Tasks, not in `TaskCreate`.** Duplicating it makes the board drift from the spec; ignore the TaskList reminder in SDD sessions.
- **Self-review before closing:** can a human run every step without reading code? does every state appear? does every task end in something the script observes?
<!-- /navori:managed id="spec-bootstrap" -->
