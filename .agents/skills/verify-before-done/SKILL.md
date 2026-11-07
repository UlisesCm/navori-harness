---
name: verify-before-done
description: 'Use when about to declare a task done — the Iron Law of task closure: no success claim without fresh evidence from the command that backs it. Applies to implementer, reviewer, publisher and any response that declares "done".'
metadata:
  type: behavior
  maxWords: 663
---

<!-- navori:managed id="verify-before-done-base" hash="72f9d98f" version="0.12.3" source="@navori/core" fmkeys="name,description,metadata" -->
# Verify Before Done

## The Iron Law

```
NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE
```

No run THIS TURN, no claim. "Should work", "previous run was green", "trivial" and "the subagent said done" are inference.

## Gate function

BEFORE claiming "done / ready / approved" (`implementer`: `done -> impl_<feature>.json`): IDENTIFY the proving command → RUN it this turn → READ output, exit code, failures → VERIFY it confirms the claim (NO → declare the real state; YES → claim it WITH evidence, naming any sub-claim you COULD NOT verify).

## Table: claim → required output → not sufficient

| Claim | Required output | Not sufficient |
|---|---|---|
| `bun run check:fast` / `bun run check:deps && bun run format:check && bun run lint && bun run typecheck && bun run check:dup && bun run check:ast && bun run check:links && bun run check:render && bun run check:assets && bun run check:doc-budgets && bun run check:blame-ignore && bun run check:tests-preserved && cd packages/cli && bun run check:size && bun run test:coverage` green | Full command run this turn, exit 0; at session close, `navori receipt check --feature <feature> --include-consumed --json` with `"status":"ok"` and `"fresh":true` | "ran it before" |
| Gate answered `PASS (cached <date> … sha256 <hash>)` | Report it as cached, with date and log hash: a time shortcut, never review evidence | Claiming it as a fresh run |
| Bug fixed | Reproduce the original symptom and see it NOT happen | "code changed, assumed fixed" |
| PR creatable | Pre-flight THIS TURN: not on the protected base branch, `gh auth status`, receipt `"status":"ok"` (`navori receipt check …`; if the installed CLI lacks it, use the repository-built CLI); direct change, your own run. No clean working tree required | "the branch has commits" |
| A shell edit landed (`sed -i`, `>`) | Re-read the changed span | The exit code |
| Suites, builds or coverage in the same checkout | One at a time: parallel runs fight over `dist` and shared artifacts. Worktrees with their own `dist` may run together | Parallel runs |
| Active `dist` lock | Identify the owner, wait. Only a verified-dead owner's lock may be reclaimed | Deleting the lock, killing another session's process |
| Full gate red | Fix with focal tests; rerun the full gate once the fix set is stable. Mandatory before sign/ship | Rerunning after every edit |
| Gate outlives Bash timeout, main session | run the chained steps one by one in the foreground | Polling (`pgrep`, `ps \| grep`) |
| Gate outlives Bash timeout, subagent | Its `&&` steps one by one, foreground | Backgrounding |

## Failure attribution

A failure is **introduced (demonstrated)**, **pre-existing (demonstrated)**, or **origin not determined**. Diff location only orients; it never proves origin. Only the **same command** over the comparable base and the change demonstrates it: runs disagree → introduced; agree → pre-existing; no comparable run → origin not determined. Never `git stash` to measure — it empties the shared tree.
## Red flags (STOP)

- Trusting a subagent's report without verifying its **load-bearing claims** (cited `file:line`s plus the diff it touched).

## Session close (session owner only)

A subagent's `done -> <file>` closes no session. Owner, before closing:

1. **Gate**: cite a fresh receipt, else rerun the full gate or record the debt.
2. **Summary**: session summary in memory: changes + gate status.
3. **Clear**: drop scratch files and commented-out code.
4. **Commit** inside the work PR before it opens.
5. **Park on base** once pushed: `git switch dev`, `git pull --ff-only`. Never delete the feature branch. Skip, saying so, with an unclean working tree, unpushed commits, or another session that may be alive.

**Lean close**: one user task AND no critical area → skip step 2 when nothing was committed. It never exempts the quality gate, nor the summary whenever there WAS a commit.
<!-- /navori:managed id="verify-before-done-base" -->

## Project-specific checks

<!-- user: add here claims specific to your repo and their required evidence. Suggestions:
     - DB migrations: command to validate the state (e.g. your ORM's migration status).
     - Critical areas: render/sync/backup writes and deletes in the user's repo, settings.json permissions, deny/ask rules and hooks, managed-block markers and the anti-rollback guard → specific checks per area.
     - Repo scripts that count as "valid evidence" (e.g. `pnpm e2e:smoke`).
     - Commands forbidden as evidence (e.g. "the Vercel preview" if it's not a real repro).
     - Recurring bug patterns of the repo where inference has historically failed.
-->
