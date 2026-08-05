---
name: review-diff
description: Use when reviewing a diff (staged, branch or PR). A code-review checklist across stack-agnostic dimensions — types, data layer, errors, security, hardcode, naming, dead code, quality gate — with CRITICAL/HIGH/MEDIUM severities. Repo-specific rules go in the user-section.
type: behavior
maxWords: 1200
---

<!-- navori:managed id="review-diff-base" hash="378a959a" version="0.5.1" source="@navori/core" -->
# Code review — checklist for a diff

Apply this checklist to a diff (staged, branch vs `main`, or a specific PR). The skeleton is stack-agnostic; the rules specific to your repo live in the user-section at the end.

## How to report

One line per finding, ordered CRITICAL → HIGH → MEDIUM:

```
[CRITICAL] <file>:<line> — <concrete, verifiable description>
[HIGH]     <file>:<line> — <description>
[MEDIUM]   <file>:<line> — <description>
```

- **CRITICAL** — breaks the build, corrupts data, security hole, a contract that won't compile. *Blocks the merge.*
- **HIGH** — likely functional bug, regression, unhandled error visible to the user, hard violation of a repo convention. *Blocks the merge.*
- **MEDIUM** — readability, naming, missing doc, minor hardcode, dead code. *Doesn't block; it's listed.*

If it doesn't reach MEDIUM, don't report it. No "nitpick" or "consider also". (Maps to the `reviewer`: CRITICAL/HIGH = confidence ≥80, blocking; MEDIUM = informational observation 50-79.)

## 0. Pre-pass (before reading line by line)

- Does the diff touch infra/config (`tsconfig*`, lint/build config, `.env*`, CI, `settings.json`)? Flag → validate the change is intentional.
- Does it delete files? Verify no residual imports remain (`grep -rn "<file>"`).
- Does it mix unrelated changes (feature + refactor + format-only)? → MEDIUM, ask to split.

## 1. Types and contracts

- Explicit `any` in new code without justification (`// any justified: <reason>`) → HIGH.
- Cast (`as Foo`) without a documented reason → MEDIUM; a cast that hides a type that actually doesn't fit → CRITICAL.
- Stale type/interface vs what the code consumes (accesses a field the type doesn't declare) → CRITICAL.
- External data (network response, user input, env) consumed without validating or normalizing → HIGH.

## 2. Data layer / logic

- Explicit defaults for nullables the consumer uses directly (`?? …`) → HIGH if missing.
- Functions that should be pure (transformers/adapters) with side-effects (I/O, global state) → CRITICAL.
- Value from an external source (unknown status/enum) assigned raw to a closed type → HIGH.

## 3. Error handling

- `catch` that swallows the error without propagating or reporting → HIGH.
- Operation that can fail (network, parse, IO) without handling, with the failure visible to the user → HIGH.
- Loading/spinner that never turns off on the error path → HIGH.
- Resource opened without cleanup on the error path (connection, lock, stream, listener, subscription, timer): the happy path releases it but a `catch`/early-return leaks it → HIGH.

## 4. Security and authorization

- Secrets/tokens/credentials in code (not in config/env) → CRITICAL.
- Authorization decision only on the client, without backend validation → HIGH.
- Sensitive data in client storage beyond what's necessary → HIGH.

## 5. No hardcode

- API URLs / literal endpoints instead of the repo's config channel → CRITICAL.
- Status/role strings or option lists duplicated instead of deriving them from a single source → MEDIUM.
- Dates/formats assembled by hand instead of the repo's util → MEDIUM.

## 6. Naming and structure

- File in the wrong folder per the repo's convention (shared component in `pages/`, etc.) → HIGH.
- Casing/suffixes that break the repo's convention → MEDIUM.
- Broken migration convention (when new and legacy code coexist and there's an expected suffix/folder) → HIGH.

## 7. Over-engineering / speculative abstraction

Mirror of the `implementer`'s YAGNI ladder: hunt for the code of **excess**.

- Abstraction (interface, layer, generic helper, hook) with **a single caller** and no second consumer in sight → MEDIUM (HIGH if it couples or complicates a critical area).
- A new dependency for what the stdlib, a native platform feature or an already-installed lib solves in a few lines → HIGH.
- Parametrization, config flags or options nobody uses yet ("just in case") → MEDIUM.
- Indirection or pattern (factory, wrapper, event layer) that doesn't eliminate real duplication nor cover a present requirement → MEDIUM.
- A deliberate shortcut without its mark (ceiling + upgrade trigger) → MEDIUM: silent debt is worse than declared debt.

Rule: if removing the abstraction leaves the code **just as correct** and shorter, removing it is the finding.

**Don't confuse it with incompleteness.** Removing the handling of a real edge case, a validation or an error path is NOT simplifying — it's a bug, and it goes to §1-§4 (not here). This dimension attacks *excess structure*, never *missing coverage*. What the YAGNI ladder protects (trust boundaries, errors that prevent data loss, security, accessibility) is never over-engineering.

## 8. Dead code and debug

- `console.log` / debug print without a guard in code that gets merged → MEDIUM (in new code: HIGH).
- Unused imports or variables → MEDIUM.
- Whole commented-out code / `if (false)` / `// TODO: remove` without an issue → MEDIUM.

## 9. Quality gate (run this turn, not assumed)

- `cd packages/cli && pnpm lint` passes → CRITICAL if it fails.
- Zero new errors/warnings vs baseline → HIGH if the diff adds them.

## 10. Commit and PR

- Commits follow the repo's convention → MEDIUM if broken.
- Changes to the manifest/lockfile without a clear reason in the description → HIGH.

## Critical areas

Pay extra attention if the diff touches the critical areas your repo declares (in `navori.config.json` / CLAUDE.md). A finding in those zones goes up one severity level.

## Output

1. Flat list with severities, ordered CRITICAL → HIGH → MEDIUM. Each line with `file:line`.
2. If there are no findings: `No findings.`
3. No summary, "good job", or suggestions outside the checklist.
4. If you find a new bug pattern that isn't here, save it (memory / note) for future reviews.

## Connection with the harness

- `reviewer`: applies this skill in Pass 2 (code quality). CRITICAL/HIGH map to issues with confidence ≥80 (they block APPROVED); MEDIUM to informational observations (50-79).
- `verify-before-done`: the §9 quality gate is run this turn, not assumed from the implementer's report.
<!-- /navori:managed id="review-diff-base" -->

## Repo-specific rules

<!-- user: add here the bespoke rules of your stack/domain (the ones that are NOT generalizable). Suggestions:
     - Patterns of your UI lib / framework (forbidden components, required props, mixing libs).
     - Conventions of your data layer (mandatory headers, specific clients, mixing legacy/new backends).
     - Forms/validation rules of your stack.
     - Repo anti-patterns that are auto-CRITICAL.
     - Critical areas with their own rules: <not configured: project.criticalAreas>.
-->
