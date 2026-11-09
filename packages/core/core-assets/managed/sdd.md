## Spec Driven Development (SDD)

**When to PROPOSE a spec**: real scope — a complete new feature, changes to auth/security/permissions, adapters or models with sensitive data, or scope > ~2 days. UI bugfixes, a form field, isolated refactors or copy tweaks go straight in. SDD is a **recommendation you put to the user**: the route is opt-in, so the spec starts only on their explicit request or accepted proposal.

**One page, one vertical slice:** `{{sdd.specsDir}}/<feature>/spec.md` — one actor reaches an observable outcome across every layer it needs; behavior, not implementation. `navori spec check` validates it.

**Done = accepted:** a human runs the spec's acceptance script on the real surface where the outcome is observable (the deployed app, the built binary — whatever the project ships) and approves it, AND the happy-path E2E passes against that same surface, without mocks. Unit and integration tests are quality, not acceptance; `prCount` ≠ proof.

**The spec's task list is the board:** do NOT mirror it in a separate task list.

Templates and rules live in `spec-bootstrap`; the work is routed like any other change, by `navori plan classify` (`planificacion`) and `orquestacion`, not by a fixed agent chain.
