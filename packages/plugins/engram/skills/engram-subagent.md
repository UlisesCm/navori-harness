---
name: engram-subagent-extension
description: Use when a subagent starts a scoped task and the repo has the engram MCP tools — search memory for prior context before reading code, and leave the session ceremonies to the agent that owns the session.
metadata:
  type: behavior
---

## Engram, from a subagent

**Pre-flight, before you read code:** `mem_search` with the task's keywords. A
previous decision, an audit of the same area or a root cause someone already
found is context you would otherwise rediscover file by file. What memory gives
you is a REGION and a hypothesis — confirm the signature, the line and the call
sites in the code before acting on either.

**Save only what outlives this task**: a root cause with its evidence, a
convention that got established, a decision and why it beat the alternative. Use
a stable `topic_key` so the topic evolves instead of piling up snapshots. Always
pass a `title` — search results lead with it, so an untitled memory forces the
next reader to open it just to learn what it's about. Never persist line
numbers, signatures or call-site lists — those go stale and mislead.

**The session ceremonies are not yours.** `mem_session_summary` and the curation
that follows belong to the agent that owns the session; you are closing a task,
not a session. Ending with `done -> <file>` is your report.

If a memory contradicts what the code says, the code wins — fix the memory.
