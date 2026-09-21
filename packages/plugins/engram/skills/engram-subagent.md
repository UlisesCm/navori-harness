---
name: engram-subagent-extension
description: Use when a subagent starts a scoped task and the repo has the engram MCP tools — search memory for prior context before reading code, save only what outlives this task, and leave the session ceremonies to the agent that owns the session.
metadata:
  type: behavior
---

## Engram, from a subagent

**Pre-flight, before reading code:** `mem_search` the task's keywords. A prior
decision, audit or root cause is context you'd otherwise rediscover file by
file. Memory gives you a REGION and a hypothesis — confirm signature, line and
call sites in the code before acting on either.

**Save only what outlives this task**: a root cause with its evidence, a
convention that got established, a decision and why it beat the alternative.
Use `type` from this closed list only — `decision, architecture, bugfix,
pattern, config, discovery` — never `manual` or a synonym: an off-list type
fragments search. Use a stable `topic_key` so the topic evolves instead of
piling up snapshots. Always pass a descriptive `title` — a generic or missing
one forces the next reader to open the entry just to learn what it's about.
Never persist line numbers, signatures or call-site lists — those go stale.

**Session ceremonies are not yours.** `mem_session_summary` and its curation
belong to the agent that owns the session; you are closing a task, not a
session. Ending with `done -> <file>` is your report.

If a memory contradicts the code, the code wins — fix the memory.
