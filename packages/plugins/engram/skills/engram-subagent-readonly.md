---
name: engram-subagent-readonly-extension
description: Use when a subagent starts a scoped task and the repo has the engram MCP tools — search memory for prior context before reading code. This role has no write access; report anything durable in the handoff instead.
metadata:
  type: behavior
---

## Engram, from a subagent (read-only)

**Pre-flight, before you read code:** `mem_search` with the task's keywords
and `response_format: "compact"` — bounded previews; search is nearly the
only thing this read-only role does against engram. A previous decision, an
audit of the same area or a root cause someone found is context you'd
otherwise rediscover file by file. Memory gives you a REGION and a
hypothesis — confirm the signature, line and call sites before acting.
`mem_get_observation` with its id for the full body if a preview falls
short.

**You cannot write to memory** — this role has no `mem_save`, on purpose:
saving is reserved for the agent that owns the session or the audit. If you
surface something durable (a root cause, a convention, a decision), put it in
your handoff report instead of persisting it yourself; the agent that reads
your report saves it.

The session ceremonies are not yours either — `mem_session_summary` and the
curation that follows belong to the agent that owns the session. Ending with
`done -> <file>` is your report.

If a memory contradicts what the code says, the code wins — say so in your
report; don't try to fix it yourself.
