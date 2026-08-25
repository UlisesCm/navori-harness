---
name: engram-leader-extension
description: Use when the leader agent is orchestrating work — the Engram protocol: search context before decomposing, save decisions proactively, close the session with a summary.
type: behavior
---

## Engram (persistent memory)

Before decomposing work: **search for context** with `mem_search` using keywords from the ticket. If you find a previous audit of the same area or a related architectural decision, read it before dispatching the `implementer`. Don't re-discover what's already saved.

After each architectural decision, new plugin or convention established in the session: a proactive `mem_save` with the appropriate type (`decision`, `convention`, `pattern`, `bugfix`) and a stable `topic_key`. Reuse the key to evolve the topic without piling up snapshots. Save durable pointers; lines, signatures and call sites are verified in code and not persisted.

Before closing the session: a mandatory `mem_session_summary` — exempt only under **R1 lean close** (see the session closeout block) — with:

- `goal` — what was attempted.
- `discoveries` — gotchas, critical files, intermediate decisions.
- `accomplished` — what got done.
- `next_steps` — what's left (with concrete paths).
- `relevant_files` — paths a future agent should read first.

After the summary, curate the session: consolidate duplicates, fix contradicted memories and delete only clearly volatile or redundant content. Never aggressively prune durable decisions. Under **R1 lean close** the curation is exempt too; `mem_save` never is.
