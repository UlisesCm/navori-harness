---
name: master-plan
description: Use when the user explicitly asks to start or resume the project master plan, or invokes `/skill:master-plan`. Guides PLAN.md, slice-by-slice delivery and the user's QA rounds. Not for a standalone feature spec (`spec-bootstrap`) or manual context conversion (`context-intake`).
metadata:
  type: reference
  maxWords: 600
---

<!-- navori:managed id="master-plan" hash="c49ef1e2" version="0.12.3" source="@navori/core" fmkeys="name,description,metadata" -->
# Master plan — slices the user accepts

## Lock: explicit request only

Continue only if the user, in this thread, asks to start or resume the plan, invokes `/skill:master-plan`, or accepts your offer with a clear yes. A SessionStart line, a mention of the plan or your own initiative is never a request, consent or authorization. Without the lock, stop before reading state or writing.

## Rules

- State is git: read it with `navori master status` (`status S2` for one slice, `status --qa` for a QA round). Never keep a status file.
- Only the user accepts or rejects. You never run `navori master accept` or `reject`, and never pass `--approved-by user` yourself.
- WIP is 1: while a slice waits for acceptance, do not integrate another one. `check` and CI enforce it.

## Flow

1. **Init.** No `specs/_plan/PLAN.md`: run `navori master init <slug>`. It creates the one-page plan and turns the flag on. If it cannot edit the config without reformatting it, it prints the exact line to add and the render command: relay that to the user.
2. **Interview.** Fill the Slices index with the user: each row is "actor → outcome", one vertical slice reachable in ≤3 days. Too big? Split it with SPIDR (spike, paths, interfaces, data, rules) until each piece delivers an observable outcome. Also fill the goal, the acceptance environment and URL, both branches, and decisions as proposals.
3. **Check.** Run `navori master check`. Fix every error it names: empty index, horizontal slice, missing environment.
4. **Spec.** The next pending slice gets `specs/<feature>/spec.md` (see `spec-bootstrap`), linked in its row, and `navori spec check` green. The spec needs an acceptance script the tester can run.
5. **Build.** Work in `slice/S<n>-<slug>`. Mark every commit of the slice with the trailer `Slice: S<n>` or `[S<n>]` in the subject, and title the PR `[S<n>] …`. Fixes, chores and hotfixes carry no mark. Integrate into the acceptance branch only if WIP allows: `navori master check --incoming <ref>`.
6. **QA round.** When slices are integrated, run `navori master status --qa` and give the user the environment and scripts. Warn about any slice without a script.
7. **Verdict.** The user runs `navori master accept S1 S3 [--evidence <url>] --approved-by user`, or `reject S2 --notes "…"` (repeat `--notes`). Each note becomes an open task of that slice, shown by `status S2` and at session start, until it is accepted. Fix the tasks, integrate again and ask for a new round.
8. **Decisions.** A `D<n>` stays a proposal until the user accepts it by itself with `accept D<n>`.

## After acceptance

An accepted slice's spec stops being maintained and stops being a source of truth; do not delete it. Marked commits that land later are only warned about, never reopen the slice.

## Failures

- No remote branch or a shallow clone: the command fails closed and names the fix (`git fetch origin <branch>`, `fetch-depth: 0`). Apply it, do not bypass it.
- `sdd.enabled` is false: explain that the plan needs SDD and ask the user before enabling it.
- A v1 stage is active: `init` resumes it and warns that `migrate` is coming; do not mix it with `PLAN.md`.
<!-- /navori:managed id="master-plan" -->

<!-- user: añade aquí convenciones locales para planes maestros de este repositorio. -->
