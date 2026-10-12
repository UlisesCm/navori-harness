## Spec Driven Development (SDD)

**When to PROPOSE a spec**: real scope — a complete new feature, changes to auth/security/permissions, adapters or models with sensitive data, or scope > ~2 days. UI bugfixes, a new field in a form, isolated refactors, or copy tweaks go straight in. Crossing it makes SDD a **recommendation you put to the user**: the route is opt-in, so the spec starts only on their explicit request or accepted proposal.

<!-- navori:if-not onClaude -->**Structure:** `{{sdd.specsDir}}/<feature>/{requirements.md, design.md, tasks.md}` — EARS requirements with id `R<n>`, a design with decisions and trade-offs, and `tasks.md` in deliveries `E<n>` (one PR each), milestones `M<n>` (each verified and committed) and tasks `T<n>` that declare the `R<n>` they cover. Each `R<n>` is covered by ≥1 test that references it (`// Covers: R<n>`); without full traceability the feature is not done.

**Tracking in the spec, not in the harness:** with `tasks.md`, that's the board — <!-- navori:if-not onCodex -->do NOT use `TaskCreate` for those tasks (duplicating it produces drift between the spec and the TaskList); ignoring its reminder in SDD sessions is expected<!-- /navori:if-not --><!-- navori:if onCodex -->do not mirror those tasks in a separate task list<!-- /navori:if -->.

<!-- /navori:if-not --><!-- navori:if onClaude -->**Spec tasks live in `tasks.md`:** do NOT use `TaskCreate` for them (ignore its reminder).

<!-- /navori:if -->Spec scaffolding — EARS templates, `R<n>↔test` traceability rules, and the agent flow (`orchestrator`→`implementer`→`reviewer`) — lives in `spec-bootstrap`: propose SDD; it scaffolds once accepted, via prose or `/spec-bootstrap`.
