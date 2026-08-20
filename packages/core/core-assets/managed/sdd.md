## Spec Driven Development (SDD)

**When to PROPOSE a spec**: real scope — a complete new feature, changes to auth/security/permissions, adapters or models with sensitive data, or scope > ~2 days. UI bugfixes, a new field in a form, isolated refactors, or copy tweaks go straight in. Crossing it makes SDD a **recommendation you put to the user**: the route is opt-in, so the spec starts only on their explicit request or accepted proposal.

**Structure:** `{{sdd.specsDir}}/<feature>/{requirements.md, design.md, tasks.md}` — EARS requirements with id `R<n>`, a design with decisions and trade-offs, and tasks in batches of 1-3 that declare the `R<n>` they cover. Each `R<n>` is covered by ≥1 test that references it (`// Covers: R<n>`); without full traceability the feature is not done.

**Tracking in the spec, not in the harness:** with `tasks.md`, that's the board — do NOT use `TaskCreate` for those tasks (duplicating it produces drift between the spec and the TaskList); ignoring its reminder in SDD sessions is expected.

Spec scaffolding — EARS templates, `R<n>↔test` traceability rules, and the agent flow (`leader`→`implementer`→`reviewer`) — with the `spec-bootstrap` skill.
