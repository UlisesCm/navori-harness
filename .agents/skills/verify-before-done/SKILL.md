---
name: verify-before-done
description: Use when about to declare a task done — the Iron Law of task closure: no success claim without fresh evidence from the command that backs it. Applies to implementer, reviewer, commit-pr-pilot and any response that declares "done".
metadata:
  type: behavior
  # 1050 y no 1000 (spec 0020, R4): entró la fila de `sed -i`, que sale 0 sin haber
  # matcheado nada — el caso en que el exit code no es evidencia. Salió de
  # `operaciones-seguras`, donde se pagaba en cada sesión.
  maxWords: 1050
---

<!-- navori:managed id="verify-before-done-base" hash="e7c86e0c" version="0.8.7" source="@navori/core" -->
# Verify Before Done

## The Iron Law

```
NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE
```

If you didn't run the verification command THIS TURN, you can't make the claim. "Should work", "previous run was green", "looks fine" are NOT evidence.

## Why this skill exists

The recurring bug is declaring "done" based on inference:

- "I ran the check 2 changes ago, it should still be green"
- "the code compiles, the UI should work"
- "the adapter is fine, the render must work"

Inference ≠ evidence. This skill forces rigor.

## Gate function

BEFORE claiming any "done / ready / completed / approved":

1. **IDENTIFY**: what command proves this claim?
2. **RUN**: run the FULL command this turn (not partial, not cached).
3. **READ**: full output, exit code, count failures.
4. **VERIFY**: does the output confirm the claim?
   - NO → declare the real state with evidence.
   - YES → make the claim WITH the evidence visible.
5. **ONLY THEN**: make the claim.

Skipping any step = a lie, not verification.

## Table: claim → required output → not sufficient

| Claim | Required output | Not sufficient |
|---|---|---|
| `cd packages/cli && pnpm lint` green | Full command run this turn with exit 0 | "ran it before", "should be green", "lint passed yesterday" |
| `pnpm format:check && pnpm check:links && pnpm check:render && pnpm check:assets && pnpm check:doc-budgets && pnpm jscpd:check && pnpm semgrep:check && cd packages/cli && pnpm check:size && pnpm test:coverage && pnpm lint && pnpm typecheck` green | Same — fresh exit 0 this turn | "the dev server runs", "build passed a while ago" |
| Zero new errors vs baseline | `git diff --name-only main` — a failure outside that file list predates you | "lint said OK" without comparing baseline |
| UI validated in the browser (only if the user asked) | Observed state via the repo's browser tool (e.g. `playwright-cli`) this turn | "looks fine in code" |
| Bug fixed | Reproduce the original symptom and see it NOT happen | "code changed, assumed fixed", "the diff covers the case" |
| Filter / feature works | Real click + description of the result | "the handler is well written" |
| Structural migration complete | Read AND write go to the same destination in the affected flow, validated in browser or test | "I changed the service, it should work" |
| PR creatable | Pre-flight THIS TURN: not on `main`, `gh auth status` ok, fresh gate evidence over the shipping diff (reviewer's Pass-2 run with a no-drift receipt; on a declared-inline change, your own run). No clean working tree required — the uncommitted diff IS the trigger | "the branch has commits, we can create it" |
| Tests pass | Suite run fresh with exit 0 this turn + test count | "we didn't touch tests", "they should still be green" |
| Type-check clean | `tsc --noEmit` (or the runtime's equivalent) exit 0 this turn | "TS didn't complain when I saved it" |
| A shell edit landed (`sed -i`, a `>` redirect) | Re-read the span you changed, this turn | The exit code. `sed -i` exits 0 when its pattern matches nothing, and a misdirected `>` truncates the file — both look like success |
| Gate outlives Bash timeout, **main session** | Background (`run_in_background`), wait on its completion notification or `Monitor`; `TaskStop` unneeded tasks first | Polling (`pgrep`, `ps \| grep`) — matches other sessions' waits too |
| Gate outlives Bash timeout, **subagent** | Run its `&&` steps one by one, foreground, each under the timeout | Backgrounding — a subagent that ends its turn is never re-woken, so the run orphans |

## Red flags (STOP)

- You're about to write "done" / "ready" / "perfect" / "should work".
- You're about to `git commit` without having run `cd packages/cli && pnpm lint` this turn.
- You're about to mark a review `APPROVED` without having read the full diff.
- You're tired and want to close it out.
- "Just this once" — NO. Zero exceptions.
- You trust a subagent's report without verifying its **load-bearing claims** (the cited `file:line`s your decision rests on, plus the diff it touched).

## Rationalization prevention

| Excuse | Reality |
|---|---|
| "I'm confident" | Confidence ≠ evidence. |
| "If it compiles, it runs" | TS with `strict: false` doesn't catch runtime undefined. Verify UI / runtime. |
| "The check passed 10 min ago" | Re-run. Fresh. |
| "It's trivial, no need" | Triviality doesn't exempt you from verification. |
| "The subagent said done" | Look at the diff yourself. Trust but verify. |
| "The user is in a hurry" | Hurry ≠ excuse. A quick verification is faster than a rollback. |
| "Different wording = the rule doesn't apply" | Spirit > letter. |

## When this skill is invoked

- **`implementer`**: before returning `done -> .codex/progress/impl_<feature>.md` (its "Evidence-based completion").
- **`reviewer`**: before marking `APPROVED`.
- **`commit-pr-pilot`**: in its pre-flight, before touching `gh`.
- **Any agent**: before telling the user "done" in any code-task response.

`AGENTS.md` § Session closeout mentions `pnpm format:check && pnpm check:links && pnpm check:render && pnpm check:assets && pnpm check:doc-budgets && pnpm jscpd:check && pnpm semgrep:check && cd packages/cli && pnpm check:size && pnpm test:coverage && pnpm lint && pnpm typecheck` green; this skill adds the "fresh evidence" rigor plus the UI / bug-fixed dimensions the quality gate doesn't touch.

## Anti-patterns

- ❌ Showing cached output from 5 messages ago and saying "it's already green" — fresh, not cached.
- ❌ Claiming a *requested* visual check passed by reading code — it needs a real browser repro.
- ❌ "Trust me, runs locally" — not a valid claim without evidence in the chat.
- ❌ Making the claim BEFORE the command ("I'll run X and it should be green").
- ❌ Marking a step of the atomic plan `[x]` without having run the verification that backs that step.
- ❌ Accepting a subagent's report without verifying its load-bearing claims — scope defined ONCE in `AGENTS.md` § Anti-broken-telephone: cited `file:line`s plus the diff it touched, never a full re-read of an already-validated diff.

## Closing

Skill **always active** during any implementation flow. It doesn't require explicit invocation — it's a principle that applies to every "done" claim.

When applying it, the output to the user must include:

1. The explicit claim (what was accomplished).
2. The full output (or a reference to the run command) that backs it.
3. If any sub-claim COULD NOT be verified (e.g. UI with no browser available), say it EXPLICITLY — don't infer.
<!-- /navori:managed id="verify-before-done-base" -->

## Project-specific checks

<!-- user: add here claims specific to your repo and their required evidence. Suggestions:
     - DB migrations: command to validate the state (e.g. your ORM's migration status).
     - Critical areas: render/sync/backup writes and deletes in the user's repo, settings.json permissions, deny/ask rules and hooks, managed-block markers and the anti-rollback guard → specific checks per area.
     - Repo scripts that count as "valid evidence" (e.g. `pnpm e2e:smoke`).
     - Commands forbidden as evidence (e.g. "the Vercel preview" if it's not a real repro).
     - Recurring bug patterns of the repo where inference has historically failed.
-->
