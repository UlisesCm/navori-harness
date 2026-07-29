## Stack — Express (TypeScript)

HTTP backend on Express in TypeScript, database-agnostic (Socket.IO, PeerJS, native DB driver, no DB, etc.). Requests flow through layers: `route → validate(schema) → asyncHandler → controller → data layer → ApiResponse`. Errors propagate via `ApiError` and responses are wrapped in `ApiResponse`. Logging goes through winston's `Logger`, never `console.log`.

Golden rule: no raw `res.json` / `res.status(500)`; no `console.log`; no `process.env` outside the config module. Validation ALWAYS happens at the boundary (with the repo's validator — Zod or Joi). Apply the preset's `express-routes` and `winston-logging` skills according to the layer you touch. The data-layer skills (mongoose, socketio, etc.) and validation skills are injected based on the dependencies navori detects in the repo — if they're in `.claude/skills/`, apply them.

A ticket's work follows the pipeline documented in the `ticket-intake` skill (the orchestrator). It's not a spec generator: it's a protocol the orchestrator runs by invoking agents and skills in order, with objective gates and artifacts in `.claude/progress/`. Phase-to-navori-infrastructure mapping:

| Phase | Who covers it | Artifact |
|---|---|---|
| Audit | `ticket-audit` agent | `audit_<id>.md` |
| Explore | `explorer` agent (2-3 in parallel) | `explore_<dim>.md` |
| Design | `new-endpoint` skill by scope | (in the plan) |
| Implement | `implementer` agent (applies the stack skills) | `impl_<feature>.md` |
| Verify | core skill `verify-before-done` (Iron Law) | (evidence in-turn) |
| Review | `reviewer` agent + core skill `review-diff` | `review_<feature>.md` |
| Debug | core skill `loop-back-debug` | — |
| PR | `pr-create` skill | PR URL |

navori bootstraps `current.md` and `history.md`; the rest of the artifacts are created by the flow at runtime.
