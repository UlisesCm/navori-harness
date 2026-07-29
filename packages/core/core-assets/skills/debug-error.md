---
name: debug-error
description: Use when a command (tsc, lint, build, test) or the runtime spews a wall of errors. Before touching code: filter the noise, classify the error type, and fix the ROOT CAUSE, not the cascading symptoms. Your stack's error patterns go in the user-section.
type: behavior
maxWords: 600
---

# Debug error — triage before fixing

When a command fails with many lines, the mistake is to react to the first (or the loudest) one and throw a fix at it. This skill forces the triage step first.

## The protocol (in order)

1. **Filter the noise.** Isolate the real errors from the tool's chatter: progress/success lines (`compiled`, `generating…`), warnings (not errors) and logs with no stack. Keep only the lines that are an actual error.
2. **Classify the type.** Before fixing, identify the category — each one has a distinct cause shape:
   - **Types / compiler** (tsc): expected vs received type; often a stale type or a pending regeneration (codegen / schema).
   - **Lint**: mechanical, almost always auto-fixable; don't treat it as a logic bug.
   - **Build**: config, env, or boundary (server/client, dynamic) — not the business code.
   - **Runtime**: unhandled `undefined` / `null`, network, or auth / session.
3. **Find the ROOT cause.** A single root error usually cascades into 10-20 downstream ones (a missing import or type breaks everything that uses it). **Fix the root, re-run and RE-CLASSIFY** — don't fire several fixes at once against the symptoms.
4. **Report / fix** using the `formato-respuesta` format (`CAUSA` + `file:line` + minimal `FIX`). No preamble.

## Rules

- **One fix at a time** against the root, then re-run. If the same error persists after the fix → switch to `loop-back-debug` (re-validate the hypothesis, don't keep patching).
- **Don't fix symptoms** that will disappear on their own once the root is fixed.
- **Warning ≠ error** — a warning doesn't block; don't spend the turn on it unless asked.

<!-- navori:user-section -->
## Your stack's error patterns

<!-- user: document here the recurring errors of YOUR toolchain and their fix, for instant triage. Suggestions:
     - Specific noise filters (build/runner lines that are NOT errors).
     - Typical errors with their cause + fix (e.g. codegen not run, server/client boundary, import path/alias, missing env).
     - Regeneration/validation commands (codegen, migrations) that resolve entire categories of errors.
-->
