---
name: engram-subagent-extension
description: Use when a subagent starts a scoped task and the repo has the engram MCP tools — search memory for prior context before reading code, save only what outlives this task, and leave the session ceremonies to the agent that owns the session.
metadata:
  type: behavior
---

## Engram, from a subagent

**Pre-flight, before reading code:** `mem_search` the task's keywords with
`response_format: "compact"` — bounded previews. `mem_get_observation` with
its id for the full body if a preview falls short. Memory gives you a REGION
and a hypothesis — confirm signature, line and call sites before acting.

**Save only what outlives this task**: a root cause with its evidence, a
convention that got established, a decision and why it beat the alternative.
Use `type` from this closed list only — `decision, architecture, bugfix,
pattern, config, discovery` — never `manual` or a synonym. Use a stable
`topic_key`, reuse it rather than snapshotting. Always pass a descriptive
`title`. Never persist line numbers, signatures or call-site lists — those
go stale.

**If `mem_save` fails with `multiple active runtime sessions match the
current project and directory`**: upstream bug, not your content — don't
retry. Use the CLI: `engram save "<title>" "<content>" --project <project>
--type <type> --topic <topic_key>`. Closing the other session also fixes it.

**Session ceremonies are not yours.** `mem_session_summary` and its curation
belong to the agent that owns the session. Ending with `done -> <file>` is
your report.

If a memory contradicts the code, the code wins — fix the memory.
