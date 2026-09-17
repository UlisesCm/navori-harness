## Stack — Express (TypeScript)

HTTP backend on Express in TypeScript, database-agnostic (Socket.IO, PeerJS, native DB driver, no DB, etc.). Requests flow through layers: `route → validate(schema) → asyncHandler → controller → data layer → ApiResponse`. Errors propagate via `ApiError` and responses are wrapped in `ApiResponse`. Logging goes through winston's `Logger`, never `console.log`.

Golden rule: no raw `res.json` / `res.status(500)`; no `console.log`; no `process.env` outside the config module. Validation ALWAYS happens at the boundary (with the repo's validator — Zod or Joi). Apply the preset's `express-routes` and `winston-logging` skills according to the layer you touch. The data-layer skills (mongoose, socketio, etc.) and validation skills are injected based on the dependencies navori detects in the repo — if they're in `.claude/skills/`, apply them.

A ticket's work follows the phase table in the `resolve-ticket` skill, run by the orchestrator; this stack adds no phase of its own.
