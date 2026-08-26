---
name: ticket-intake
description: Use when a ticket arrives (ID, URL or pasted text) and the task isn't trivial — the canonical 8-phase pipeline to process it with objective gates.
type: reference
maxWords: 600
---

<!-- navori:managed id="ticket-intake" hash="5158a230" version="0.6.1" source="@navori/core" -->
# ticket-intake — 8-phase pipeline

## Pipeline

navori agents and skills chained by objective gates: what one phase pays for in tokens is written down for the next. Each phase writes to `.claude/progress/`; the gate is blocking.

| Phase | Who covers it | Artifact / Gate |
|---|---|---|
| 0 · Triage | you: `mem_search`, `cat progress/current.md`, `git status/log` | Trivial → resolve it **inline (R1)**, without `implementer`. If `progress/current.md` is not idle and holds ANOTHER ticket, ask; never two in parallel. |
| 1 · Context (opt.) | you: the tracker CLI (`acli` / `jira` / `gh issue view`) | If there's only pasted text, jump to 2 with it. |
| 2 · AUDIT | `ticket-audit` — ONE, or one per area (fan-out below) | `audit_ticket_<ID>.md`: **verdict** (proceed / proceed-differently / split / doesn't apply / blocked), verified problem + size, assessment of the ticket's proposed fix. **Gate: only `proceed` and `proceed-differently` wait for the user's approval.** Any other verdict opens no work → it closes the cycle here, unattended, with its evidence. |
| 3 · EXPLORE (opt.) | 2-3 `explorer` agents in a single message | One `explore_<dim>.md` per dimension (handler, schema, side-effects, caller). **Gate: the audit's approach is still alive.** |
| 4 · SOLUTION (opt.) | `solution-design` skill + ONE `researcher` as fresh-context challenge | Fires on a `proceed-differently` verdict or an architectural signal (orchestration table). Produces `solution_<scope>.md` + `solution_review_<scope>.md`. **Gate: your verdict READY / CONCERNS / BLOCKED** — `CONCERNS` records the risk and moves on, only `BLOCKED` stops. No signal → straight to 5. |
| 5 · IMPLEMENT | ONE `implementer` agent | Reads `audit_ticket_<ID>.md` → `solution_<scope>.md` (if phase 4 ran) → `explore_*.md` → applicable skill. Produces `impl_<feature>.md`. **Gate: `cd packages/cli && pnpm lint` green in the turn.** |
| 6 · VERIFY | `verify-before-done` skill (run by the implementer) | `impl_<feature>.md` with "Verify run in this turn" at exit 0 + endpoint smoke. No evidence → to 5. |
| 7 · REVIEW | `reviewer` agent + `review-diff` skill | `review_<feature>.md`. Two-pass; Pass 1 fails → `CHANGES_REQUESTED`, back to 5. `APPROVED` → continue. |
| 8 · PR + CLOSE | `commit-pr-pilot` agent | PR created and URL to the user; then close the session per the closeout block. |

## Phase 2 fan-out

Only when the orchestration table's fan-out row fires, never on "it feels separable": three auditors on a one-file ticket cost more than the serial run they replace. Then one `ticket-audit` per area, **all the `Agent` calls in the SAME turn**, each writing `audit_ticket_<ID-area>.md` (e.g. `audit_ticket_BTBS-138-webapp.md`) so none overwrites another. **You synthesize** the N reports — contradictions and gaps included — into the single `audit_ticket_<ID>.md` every later phase reads. Never delegated.

## Hard rules

- **Phase 2 is not skipped on a non-trivial task** because you "already understood the ticket": the audit is for the implementer, and for you in 3 days.
- **No PR without `APPROVED`.**
- **A verdict that opens no work doesn't wait for approval:** report it with its evidence, leave `progress/current.md` at `idle`, stop — asking permission to do nothing turns a finished pipeline into a stalled one. Only `proceed` / `proceed-differently` hold for the user, right before code gets written.
- **Trivial** = an R1 inline change (orchestration block).

## Before declaring done

- A cycle that proceeded ends with a PR via `commit-pr-pilot` and its URL to the user.
- A cycle closed at phase 2 ends with its verdict + evidence and no PR.
- Either way, `progress/current.md` at `idle`.
<!-- /navori:managed id="ticket-intake" -->
