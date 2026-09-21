---
name: engram-orchestrator-extension
description: Use when the orchestrator is decomposing and coordinating work — the Engram protocol: search context before decomposing, save decisions proactively, close the session with a summary.
metadata:
  type: behavior
  maxWords: 260
---

## Engram (persistent memory)

- **Session start:** engram's `SessionStart` hook covers `startup`/`clear`/`compact`, not `resume`. Where memory is already injected, `mem_context` only re-fetches it. Where it is NOT — a resumed session or a host with no startup hook (e.g. Codex) — that call IS the memory startup and it's the mandatory first step.
- Before decomposing: `mem_search` the ticket's keywords with `response_format: "compact"`; `mem_get_observation` for the full body. Read a prior decision before dispatching the `implementer`.
- After each decision: `mem_save` with a descriptive `title`, a stable `topic_key`, and `type` from `decision, architecture, bugfix, pattern, config, discovery`. If a memory contradicts the code, fix it with `mem_update`.
- **`mem_save` fails with `multiple active runtime sessions match the current project and directory`**: upstream bug, not your content. Use the CLI: `engram save "<title>" "<content>" --project <project> --type <type> --topic <topic_key>`.
- `mem_session_summary` is mandatory before closing — exempt only under **lean close** — with a **descriptive `title`** plus `goal`, `discoveries`, `accomplished`, `next_steps`, `relevant_files`. It is the **same redaction** as the closeout's `history.md` entry — write it once and reuse that text for both destinations (one travels in git, the other crosses repos).
- **Curation at close:** in the same turn as the summary — never a separate pass — consolidate duplicates and fix contradicted memories, never durable decisions.
- **Lean close**: the summary and the curation step are exempt; `mem_save` is not.
- **Auto Memory vs. engram**: Auto Memory holds personal preferences; engram holds durable knowledge. Never write the same fact to both.
