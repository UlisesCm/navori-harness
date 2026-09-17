## Stack — Express + Mongoose

HTTP backend on Express + Mongoose/MongoDB in TypeScript. Requests flow through layers: `route → validate(schema) → asyncHandler → controller → Model (Mongoose) → ApiResponse`. Controllers touch the Models directly (no repository wrappers); errors propagate via `ApiError` and responses are wrapped in `ApiResponse`. Logging goes through winston's `Logger`, never `console.log`.

Golden rule: no raw `res.json` / `res.status(500)`; no `console.log`; no `process.env` outside the config module. Validation ALWAYS happens at the boundary (with the repo's validator — Zod or Joi), and every `ObjectId` is built with `new Types.ObjectId(...)`. Apply the preset's `express-routes`, `mongo-aggregations` and `winston-logging` skills according to the layer you touch. The `mongoose` and validation skills (`zod-validation` or `joi-validation`) are injected based on the dependencies navori detects in the repo — if they're in `.claude/skills/`, apply them.

A ticket's work follows the phase table in the `resolve-ticket` skill, run by the orchestrator; this stack adds no phase of its own.
