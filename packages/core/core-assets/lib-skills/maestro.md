---
name: maestro
description: Use when writing or fixing Maestro E2E flows for a mobile app — YAML flows, testID selectors over localized text, clearState between flows, runFlow for shared steps, CI vs. local runs.
type: reference
---

# Maestro — conventions

## When to use this skill

When adding or fixing a flow under `.maestro/`, or when a flow passes locally and fails in CI. Maestro drives the real app (iOS/Android) from declarative YAML — no npm dependency, no page objects: a flow is a file, the suite is a directory.

## The pattern

Declare the `appId`, launch from a clean slate, select by id, reuse shared steps:

```yaml
appId: com.example.app
tags:
  - smoke
---
- launchApp:
    clearState: true
- runFlow: ../shared/login.yaml
- tapOn:
    id: "session-card"
- assertVisible:
    id: "session-detail-title"
```

## Gotchas that bite

- **Selecting by text breaks on the first translation.** `tapOn: "Iniciar sesión"` binds the test to copy and locale, so a wording tweak turns green into red. Select by `id:` — the React Native `testID` / native accessibility identifier. Text is the fallback for what has no id, never the default.
- **`testID` has to land on a real native view.** Wrapper components often swallow it, and the flow then fails with "element not found" while the screen looks right. Confirm the tree with `maestro studio` or `maestro hierarchy` instead of guessing which node got it.
- **State leaks between flows.** Maestro does not reset the app for you: the second flow inherits the first one's session, cache and navigation stack. Start every flow with `launchApp: clearState: true` (add `clearKeychain` when auth is stored there). A flow that only passes after another one ran is not a test.
- **Shared steps belong in `runFlow`, not copy-paste.** Login, onboarding dismissal, seeding: one subflow called by everyone, parameterized with `env:`. Keep subflows out of the auto-run set (`.maestro/config.yaml`) so they never run standalone.
- **Don't sleep.** Maestro already retries commands until they resolve; a fixed wait hides a race and taxes every run. Use `extendedWaitUntil` with an explicit timeout, or `waitForAnimationToEnd`.
- **Local and CI don't run the same set.** A full suite on every push is slow and flaky; tag flows (`tags: [smoke]`) and let CI run `--include-tags smoke` against a build artifact, leaving the long tail for a nightly or on-demand run.
- **The failure artifact is the debugging tool.** Maestro writes screenshots and a view-hierarchy dump per step to `~/.maestro/tests/<run>`. Read that before touching the flow — most "flaky" failures are a wrong selector visible in the dump.

## Hard rules

1. Select by `id` (`testID`); localized text is a fallback, never the primary selector.
2. Every flow is independent and starts with `launchApp: clearState: true`.
3. Shared steps live in a `runFlow` subflow excluded from the auto-run set.
4. No fixed sleeps — `extendedWaitUntil` / `waitForAnimationToEnd` with an explicit timeout.
5. Which flows block CI (and which are on-demand) is documented and driven by tags.

## Before declaring done

- The flow passes run in isolation AND as part of the suite.
- No selector depends on translated copy; no fixed sleep was added.
- New shared steps were extracted into a subflow instead of duplicated.
- `{{qualityGate.fast}}` green.

<!-- navori:user-section -->
## This repo's Maestro suite (your domain)

<!-- user: add here what only applies to THIS repo. Suggestions:
     - The `appId`(s) and how the build under test is produced (simulator, emulator, device).
     - How login is solved (which subflow, which `env:` credentials) so flows don't log in one by one.
     - The tags in use and which ones block CI vs. run nightly / on demand.
     - Seed data or backend environment the flows assume.
-->
