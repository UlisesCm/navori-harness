## Stack — Express + Mongoose

HTTP backend on Express + Mongoose/MongoDB in TypeScript. Requests flow through layers: `route → validate(schema) → asyncHandler → controller → Model (Mongoose) → ApiResponse`. Controllers touch the Models directly (no repository wrappers); errors propagate via `ApiError` and responses are wrapped in `ApiResponse`. Logging goes through winston's `Logger`, never `console.log`.

Golden rule: no raw `res.json` / `res.status(500)`; no `console.log`; no `process.env` outside the config module. Validation ALWAYS happens at the boundary (with the repo's validator — Zod or Joi), and every `ObjectId` is built with `new Types.ObjectId(...)`. Apply the preset's `express-routes`, `mongo-aggregations` and `winston-logging` skills according to the layer you touch. The `mongoose` and validation skills (`zod-validation` or `joi-validation`) are injected based on the dependencies navori detects in the repo — if they're in `.claude/skills/`, apply them.

A ticket's work follows the pipeline documented in the `ticket-intake` skill (the orchestrator). It's not a spec generator: it's a protocol the `leader` runs by invoking agents and skills in order, with objective gates and artifacts in `.claude/progress/`. Phase-to-navori-infrastructure mapping:

| Phase | Who covers it | Artifact |
|---|---|---|
| Audit | `ticket-audit` agent | `audit_ticket_<id>.md` |
| Explore | `explorer` agent (2-3 in parallel) | `explore_<dim>.md` |
| Design | `new-endpoint` / `new-resource` skills by scope | (in the plan) |
| Implement | `implementer` agent (applies the stack skills) | `impl_<feature>.md` |
| Verify | core skill `verify-before-done` (Iron Law) | (evidence in-turn) |
| Review | `reviewer` agent + core skill `review-diff` | `review_<feature>.md` |
| Debug | core skill `loop-back-debug` | — |
| PR | `pr-create` skill | PR URL |

navori bootstraps `current.md` and `history.md`; the rest of the artifacts are created by the flow at runtime.
