---
name: debug-error
description: Use when a command fails or the runtime misbehaves and you don't have a root cause yet. Before touching code: make sure you actually SAW the error, classify what kind it is, and fix the ROOT CAUSE, not the symptom. Your stack's error patterns go in the user-section.
type: behavior
maxWords: 600
---

<!-- navori:managed id="debug-error-base" hash="dba8bb0d" version="0.8.6" source="@navori/core" -->
# Debug error — diagnose before fixing

A failure is not a mandate to change code. This skill forces the diagnosis step first.

The trigger is **"I don't know why it failed yet"**, not the size of the output. Measured across 57 audited sessions and 281 failed commands, the median failure is **7 lines long** and a wall of 40 compiler errors never appeared once — the gate blocks at the boundary long before a build gets that broken. A three-line failure you can't explain earns the same protocol as a long one.

## The protocol (in order)

0. **Did you actually see the error?** The exit code is not evidence. Check the command you just ran: `2>/dev/null` **discards** the error stream, `| tail -5` may have cut the line that matters, and a wrapper can swallow a child's stderr. **Re-run it unfiltered before diagnosing.** Diagnosing from a truncated stream is how a fix gets aimed at the wrong error.
1. **Separate error from chatter.** Progress lines (`compiled`, `generating…`), warnings, and logs with no stack are not the failure. Keep the lines that are.
2. **Classify the type** — each category has a distinct cause shape:
   - **Types / compiler** (tsc): expected vs received; often a stale type or a pending regeneration (codegen / schema).
   - **Lint**: mechanical, almost always auto-fixable; not a logic bug.
   - **Build**: config, env, or a boundary (server/client, dynamic) — not the business code.
   - **Runtime**: unhandled `undefined` / `null`, network, or auth / session.
   - **Blocked by a hook or a permission rule**: the harness stopping you on purpose. Read the reason and change the approach — never work around the guard.
3. **Find the ROOT cause.** One root error cascades into the rest (a missing import or type breaks everything downstream). **Fix the root, re-run and RE-CLASSIFY** — don't fire several fixes at once against the symptoms.
4. **Report / fix** using the `formato-respuesta` format (`CAUSA` + `file:line` + minimal `FIX`). No preamble.

## Rules

- **One fix at a time** against the root, then re-run. If the same error persists after the fix → switch to `loop-back-debug` (re-validate the hypothesis, don't keep patching).
- **No fix without a root cause.** "It probably is X" is not a diagnosis; `file:line` plus why it fails is.
- **Don't fix symptoms** that disappear on their own once the root is fixed.
- **Warning ≠ error** — a warning doesn't block; don't spend the turn on it unless asked.
<!-- /navori:managed id="debug-error-base" -->

## Your stack's error patterns

<!-- user: document here the recurring errors of YOUR toolchain and their fix, for instant triage. Suggestions:
     - Specific noise filters (build/runner lines that are NOT errors).
     - Typical errors with their cause + fix (e.g. codegen not run, server/client boundary, import path/alias, missing env).
     - Regeneration/validation commands (codegen, migrations) that resolve entire categories of errors.
-->
