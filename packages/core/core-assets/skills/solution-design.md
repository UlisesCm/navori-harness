---
name: solution-design
description: Use when a task shows an architectural signal (new shared abstraction, ownership change, shared contract, migration, concurrency, critical area, hard-to-reverse decision) — decide WHAT to build and challenge it before decomposing into tasks.
type: reference
maxWords: 900
---

# solution-design — decide what to build, then try to break it

## When to use this skill

When a task inside R2 shows any architectural signal (see R2-architectural in the
orchestration block), or a ticket audit came back `proceed-differently`. NOT for a
change following an exact existing pattern with local blast radius and trivial
rollback — that is plain R1/R2 and this skill is pure overhead.

This answers **what to build and why** — not the implementation plan (*what files,
in what order*), not code review (*did the code do what we agreed*). Design before
you decompose: a contract, a state owner or a migration path moves the natural
task boundaries, so tasks written first get rewritten.

## The three failures this exists to prevent

1. **Inheriting the proposed solution.** A ticket that names a library, a pattern
   or a refactor has already decided for you. Its diagnosis can be right and its
   remedy wrong. If your plan's step 0 is "install what the ticket named", you
   skipped the design.
2. **Listing costs without weighing them.** Naming three drawbacks of an approach
   and then proceeding anyway is not analysis — a cost only counts when it is
   compared against a concrete alternative.
3. **Filing scope-breaking findings as notes.** If you discover that part of the
   request is dead code, already fixed, or not solved by what was proposed, that
   is a **verdict about scope**, not an open question at the bottom.

## Process

1. **What already exists — first, with evidence.** Before proposing anything, find
   what in the repo already solves this fully or partially: `file:line`, the
   existing pattern, the layer that owns it today. Ask what the smallest change to
   THAT is. Prefer, unless documented evidence says otherwise:
   `existing pattern > small extension > new abstraction > new subsystem`.
2. **State the real problem** — the behavior that changes and who consumes it, not
   the symptom the ticket describes.
3. **Approaches, only if ≥2 are genuine.** Never invent a straw alternative when
   one answer is obviously right. When the request proposes one, it is approach A
   and gets no privileges: give each option its tradeoffs and its cost of reversal.
4. **Choose**: what, why, and why not the others.
5. **Cover only the dimensions the signal raises** — boundaries and contracts,
   failure modes, migration and compatibility, testing strategy. An empty section
   is noise, not rigor. Every test you name answers a risk named above it.
6. **Challenge it in a fresh context** (below), then record the verdict.

## Ambiguity — three ways, never guess

- Answerable by reading the repo → investigate it.
- Product or human decision → ask it.
- Not blocking → assume the conservative option and **record the assumption**.

## The challenge (one round, fresh context)

Hand the artifact to a `researcher` with a falsification brief — its job is to
break the design, not to polish it:

> What assumption is false? · What existing code contradicts it? · Which
> requirement isn't covered? · What contract breaks? · What happens on partial
> failure, timeout, duplicate delivery? · Who owns this state, and does the design
> respect it? · Are we duplicating an abstraction that already exists? · Can this
> be done with less machinery? · Would the tests catch the main risk?

It classifies findings `BLOCKER | CONCERN | NOTE` and writes
`solution_review_<scope>.md`. **It does not issue the verdict** — you do, when you
synthesize. One round only: once a scope decision is accepted or rejected, execute
it; do not re-argue it in later phases.

## Verdict

| | Meaning | Effect |
|---|---|---|
| `READY` | No known blockers. Notes may exist. | Implement |
| `CONCERNS` | Real risks, recorded, extra attention in review. | **Implement** — never blocks |
| `BLOCKED` | Implementing now means guessing a decision that could change the solution. | Ask and stop |

A `BLOCKED` must state four things: the blocking fact · why you cannot proceed
without guessing · who resolves it · the minimum information needed. **If you
cannot state all four, it is a CONCERN, not a blocker.**

Never blockers: naming preference, a hypothetical future abstraction, a minor
optimization, an optional edge case, stylistic architecture taste.

## Artifact — `.claude/progress/solution_<scope>.md`

```markdown
# Solution — <scope>
**Verdict:** READY | CONCERNS | BLOCKED
**Signals:** <which ones triggered this pass>

## Problem
## What already exists          ← evidence, `file:line`; why extending it does/doesn't suffice
## Constraints
## Approaches                    ← only if ≥2 genuine; each with tradeoffs + cost of reversal
## Chosen solution               ← what · why · why not the others
## Boundaries & contracts        ← conditional
## Failure modes                 ← conditional
## Migration & compatibility     ← conditional
## Testing strategy              ← each test answers a risk named above
## NOT in scope                  ← deferred work + why; stops "improving things along the way"
## Open questions                ← [repo] investigate · [human] ask · [assumed] recorded
```

## Before declaring done

- "What already exists" cites real `file:line` and says why extending it is or
  isn't enough — not merely how the existing code fits the proposed solution.
- Any finding that changes what should be built is in the verdict, not a footnote.
- The challenge ran in a fresh context and its findings are classified.
- No empty conditional sections, and no invented alternatives.
