---
name: engram-leader-extension
description: Use when the leader agent is orchestrating work — the Engram protocol: search context before decomposing, save decisions proactively, close the session with a summary.
metadata:
  type: behavior
  maxWords: 260
---

## Engram (persistent memory)

- **Session start:** engram's `SessionStart` hook covers `startup`, `clear`, `compact` — **not `resume`**. Where memory is already injected, work with it — `mem_context` only re-fetches it. Where it is NOT — a resumed session or a host with no startup hook (e.g. Codex) — that call IS the memory startup and it's the mandatory first step.
- Before decomposing: `mem_search` with the ticket's keywords. Read a prior decision before dispatching the `implementer`.
- After each decision: `mem_save` with a `title`, a type and a stable `topic_key` — reuse it, don't snapshot. If a memory contradicts the code, fix it with `mem_update`.
- `mem_session_summary` is mandatory before closing — exempt only under **lean close** — with `goal`, `discoveries`, `accomplished`, `next_steps`, `relevant_files`. It is the **same redaction** as the closeout's `history.md` entry — write it once and reuse that text for both destinations (one travels in git, the other crosses repos); never write the same session up twice.
- **Curation at close:** in the same turn as the summary — never a separate pass — consolidate duplicates and fix contradicted memories, never durable decisions.
- **Lean close**: the summary and the curation step are exempt; `mem_save` is not.
- **Auto Memory vs. engram**: Claude Code's native Auto Memory (on by default, machine-local — https://code.claude.com/docs/en/memory) is for this user's personal preferences and working-style feedback; engram is for durable engineering knowledge (decisions, bugfixes, architecture, discoveries) shared across engines. Route "remember X" accordingly — never write the same fact to both.
