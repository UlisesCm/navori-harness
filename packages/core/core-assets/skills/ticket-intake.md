---
name: ticket-intake
description: Use when a ticket arrives (ID, URL or pasted text) and the task isn't trivial — the canonical 8-phase pipeline to process it with objective gates.
type: reference
---

# ticket-intake — 8-phase pipeline

## When to use this skill

When a ticket arrives (ID, URL or pasted text) and the task isn't trivial. It orchestrates the cycle by chaining navori agents and skills with objective gates: the context you pay for with tokens in one phase is written down for the next, without relying on the model's memory.

## Pipeline

Each phase writes to `.claude/progress/`; the gate is blocking.

| Phase | Who covers it | Artifact / Gate |
|---|---|---|
| 0 · Triage | you: `mem_search`, `cat current.md`, `git status/log` | Trivial → resolve it **inline (R1)**, without `implementer`. If `current.md` is not idle and holds ANOTHER ticket, ask; never two in parallel. |
| 1 · Context (opt.) | you: the tracker CLI (`acli` / `jira` / `gh issue view`) | If there's only pasted text, jump to 2 with it. |
| 2 · AUDIT | `ticket-audit` agent | `audit_<ID>.md`: root cause/approach, files, alternatives, questions, tasks. **Gate: the user approves it.** |
| 3 · EXPLORE (opt.) | 2-3 `explorer` agents in a single message | One `explore_<dim>.md` per dimension (handler, schema, side-effects, caller, memory). **Gate: you validate the audit's approach is still alive.** |
| 4 · DESIGN (opt.) | your preset's scaffolding skill (backend: `new-endpoint`/`new-resource`; frontend: `new-feature`) | Only if there's a new pattern or lib: you present 2-3 approaches with tradeoffs and wait for OK. Otherwise, to 5. |
| 5 · IMPLEMENT | ONE `implementer` agent | Reads CLAUDE.md → `audit_<ID>.md` → `explore_*.md` → applicable skill. Produces `impl_<feature>.md`. **Gate: `{{qualityGate.fast}}` green in the turn.** |
| 6 · VERIFY | `verify-before-done` skill (run by the implementer) | `impl_<feature>.md` with "Verify run in this turn" at exit 0 + endpoint smoke. No evidence → to 5. |
| 7 · REVIEW | `reviewer` agent + `review-diff` skill | `review_<feature>.md`. Two-stage; Stage 1 fails → `CHANGES_REQUESTED`, back to 5. `APPROVED` → continue. |
| 8 · PR + CLOSE | `pr-create` skill | PR created and URL to the user; then `mem_save`, an entry in `history.md`, `current.md` to `idle` and `mem_session_summary`. |

## Hard rules

- **Phase 2 is not skipped on a non-trivial task** "because you already understood the ticket". The audit is for the implementer (and for you in 3 days); delegate it to `ticket-audit`.
- **The implementer starts by reading `audit_<ID>.md`** or you lose context already paid for with tokens.
- **The reviewer doesn't approve without Stage 1;** the approval does NOT depend on the implementer.
- **No PR without `APPROVED`** nor two tickets in parallel on the same `current.md`.
- **Trivial** = ≤1 file, ≤5 lines, no logic.

## Before declaring done

- The cycle closed with a PR via `pr-create` and its URL to the user; `current.md` at `idle`.
- There was a `mem_save` of every non-obvious decision and a `mem_session_summary`.
- If it was non-trivial: an approved `audit_<ID>.md`, an `impl_<feature>.md` with verify at exit 0, and a `review_<feature>.md` at `APPROVED` all exist.
