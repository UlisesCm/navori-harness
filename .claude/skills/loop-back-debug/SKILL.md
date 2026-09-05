---
name: loop-back-debug
description: Use when a fix doesn't work the first time. Forces re-reading the original symptom, validating the hypothesis vs the applied diff, and NOT throwing more patches without understanding what failed.
type: behavior
maxWords: 1000
---

<!-- navori:managed id="loop-back-debug-base" hash="25c7bebc" version="0.7.2" source="@navori/core" -->
# Loop-Back Debug

## The anti-pattern this skill attacks

Recurring pattern when a bug is persistent:

1. Fix attempt #1 → "should work" → doesn't work.
2. Fix attempt #2 → "now it will" → doesn't work.
3. Fix attempt #3 → random change → doesn't work.
4. Eventually the code is worse than at the start and the bug is still there.

The root mistake is **escalating the change without re-validating the hypothesis**. Each attempt assumes the previous one was "almost right", when in reality the mental model of the bug was wrong since #1.

## The Rule

```
IF A FIX DIDN'T CLEAR THE SYMPTOM ON THE FIRST POST-FIX REPRO,
YOU STOP PATCHING AND RE-VALIDATE THE HYPOTHESIS.
```

No more patches on top of the previous one. Go back to the original symptom and current diff, and compare against the hypothesis. If the hypothesis was correct and the symptom persists, the fix is incomplete. If the hypothesis was wrong, no patch on this line will work — change the hypothesis.

## Gate function (post-fix)

AFTER applying a fix and BEFORE claiming "fixed":

1. **REPRO**: run the exact repro that produced the original symptom. In this turn. Not "assuming that".
2. **OBSERVE**: is the symptom still there / changed / gone?
3. **CLASSIFY**:
   - **Gone** → apply `verify-before-done` to confirm and declare the fix complete.
   - **Persists exactly the same** → the hypothesis was wrong. DON'T patch on top. Go to § Reset hypothesis.
   - **Changed shape** → the fix touched something real but it wasn't the root cause. Go to § Reset hypothesis with the new info.

## Reset hypothesis (when the fix didn't work)

DO NOT apply another fix until you complete these steps:

1. **Re-read the original symptom**, literally from the ticket / bug report / initial repro. Not the symptom in your head, the written one.
2. **List the applied diff** (`git diff HEAD~1`) and describe it in one sentence: "I changed X in file:line from Y to Z because the hypothesis was W".
3. **Validate logically**: if hypothesis W were true, should the change Y→Z have fixed the symptom?
   - If the answer is "yes it should", but the symptom persists → your model of the flow is incomplete. There is an intermediate step you're not seeing.
   - If the answer is "not necessarily", the hypothesis was weak from the start.
4. **Generate 2–3 alternative hypotheses** before touching code:
   - Is there caching? (browser, build, CDN, redis).
   - Is the code you changed the one that actually runs? (path resolution, dynamic imports, env-gated branches).
   - Was the change on the server or the client when the bug is on the other side?
   - Is there a middleware / interceptor between what you changed and where the symptom is observed?
   - Was the in-memory / DB state already in an invalid state and your fix only covers the "new" path?
5. **Pick ONE new hypothesis** with evidence-based reasoning. Document it before touching code.
6. **Apply the next attempt** knowing what you're testing.

## When to escalate / ask the user for help

If you've had **2 failed attempts** on the same bug, you stop and report to the user:

- Original symptom.
- Hypothesis #1, applied fix, repro result.
- Hypothesis #2, applied fix, repro result.
- Hypothesis #3 you plan to test, with the evidence backing it.
- Concrete question: "do you know more context that supports / refutes this hypothesis?"

It's not weakness — it's efficiency. 3 blind attempts are worth less than 1 conversation with whoever has the context.

## Red flags (STOP)

- You're about to make a second change on the same line without having re-run the repro.
- You're about to write "now it should work" without fresh evidence.
- You're reverting and re-applying variations of the same change.
- You're adding logs / try-catch / fallbacks to "cover" instead of understanding.
- The diff accumulates >3 commits on the same file trying to fix the same thing.

## Anti-patterns

- ❌ "Let me try this other fix" without having run the repro of the previous fix.
- ❌ Defensive patches: try-catch around the suspicious code so "it won't break". That hides the bug, doesn't fix it.
- ❌ "It's flaky" as an excuse without evidence of real flakiness.
- ❌ Changing lib / framework / approach because "maybe with X it would work" — that's a hot shower, not debugging.
- ❌ Asking the user to "try it again" without having changed anything relevant.

## Connection with the rest of the harness

- `implementer`: invokes this skill when the first fix doesn't resolve the symptom. Does NOT return `done` until it has gone through Reset hypothesis if the initial repro fails.
- `verify-before-done`: this skill applies BEFORE verify-before-done — first validate the fix actually cleared the symptom (this), then that the rest of the quality gate is still green (verify-before-done).
- `ticket-audit`: when a bug enters the ticket-audit agent, the "Root cause hypothesis" is the first candidate of the loop. If that hypothesis's fix doesn't work, ticket-audit can be re-invoked with the new info.

## Closing

When applying this skill, the output to the user includes:

1. Hypothesis that was tested.
2. Change applied (file:line + description).
3. Post-fix repro result (in this turn).
4. If it worked → apply `verify-before-done` to close.
5. If it didn't work → next hypothesis to test OR escalation to the user (per the attempt count).
<!-- /navori:managed id="loop-back-debug-base" -->

## Recurring bug patterns of the project

<!-- user: add here bug patterns specific to your repo where the typical hypothesis fails. Suggestions:
     - Caches the dev forgets to invalidate (CDN, redis, browser SW, build cache).
     - Known race conditions in specific modules.
     - Areas where "the obvious thing" is historically not the root cause.
     - Half-done migrations (e.g. `legacy/, vendor/` → new backend) that create inconsistent states.
     - Standardized repro commands for frequent bugs (e.g. `pnpm dev:e2e:auth-flow`).
-->
