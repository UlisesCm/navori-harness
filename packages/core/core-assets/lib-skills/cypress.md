---
name: cypress
description: Use when writing or fixing Cypress tests — component vs. e2e, resilient selectors, cy.intercept with aliases instead of waits, and spec independence.
type: reference
---

# Cypress — conventions

## When to use this skill

When adding or fixing a Cypress spec, or when a spec fails intermittently. Cypress runs two different suites — **component** (a component mounted in isolation) and **e2e** (the whole app in a browser) — and mixing their rules is where most of the pain comes from.

## The pattern

Select by what the user perceives, and wait for the request, not for the clock:

```ts
it("shows the sessions of the day", () => {
  cy.intercept("GET", "/api/sessions*", { fixture: "sessions.json" }).as("sessions");
  cy.visit("/agenda");
  cy.wait("@sessions");                       // deterministic: the response arrived

  cy.findByRole("heading", { name: /agenda/i }).should("be.visible");
  cy.findByRole("button", { name: /new session/i }).click();
});
```

## Gotchas that bite

- **`cy.wait(3000)` is the origin of the flake.** A fixed number is slow when it passes and false when the machine is loaded. Wait on an alias (`cy.wait("@alias")`) or on the assertion — Cypress already retries.
- **CSS-class selectors break with every restyle.** Go for role/text/label, and for `data-cy` (or `data-testid`) when there is no accessible handle. A `.btn-primary` says nothing about what the user sees.
- **Specs must be independent.** Cypress clears state between specs, not between `it`s: a test that depends on the previous one passes locally and fails when the order or the parallelism changes. Each test seeds what it needs.
- **Recipes older than Cypress 12 don't apply.** `cy.route`/`cy.server` are gone (use `cy.intercept`), `plugins/index.js` no longer exists (config in `cypress.config.ts`), and the test-isolation default changed.
- **`cy.get()` doesn't return a value.** Everything is a chained command; `const el = cy.get(…)` doesn't give you the element. Use `.then()` when you genuinely need the value.
- **Component and e2e see different worlds.** Component mounts without a router or global providers unless you wrap them; e2e depends on the app being served with real data. A test that needs a route belongs in e2e.
- **A negative assertion passes too easily.** `should("not.exist")` right after a click passes because the element hasn't rendered yet. Assert the intermediate state first, then the absence.

## Hard rules

1. Selection by role/text/label, or `data-cy`; never a styling class.
2. `cy.intercept` + alias instead of a numeric wait.
3. One spec doesn't depend on another's state.
4. Cypress ≥ 12 API (`cy.intercept`, `cypress.config.ts`), not legacy recipes.
5. Which suite blocks the pipeline is documented (see the user-section) — an e2e suite nobody runs is dead weight.

## Before declaring done

- The spec passes on a run in isolation AND in the full suite.
- No `cy.wait(<number>)` was added.
- Selectors survive a class rename.
- `{{qualityGate.fast}}` green.

<!-- navori:user-section -->
## This repo's Cypress suite (your domain)

<!-- user: add here what only applies to THIS repo. Suggestions:
     - Which suite blocks (component, e2e, both) and where each runs: pre-push, CI, or on demand.
     - The base environment: URL, seed data, how the app is served.
     - How authentication is solved (cy.session, a custom command) so specs don't log in one by one.
     - The custom commands in `support/` and what each does.
-->
