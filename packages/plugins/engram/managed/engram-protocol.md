## Engram

- **Session start (first step, mandatory):** call `mem_context` at the start of EVERY session to recover decisions and prior work — don't wait for the user to ask. On hosts that do NOT load memory with a startup hook (e.g. Codex), this explicit call IS the memory startup; don't skip it.
- **Pre-flight:** `mem_search` with the task's keywords before searching code — it gives a region and a hypothesis; confirm signature, line, and call sites with Grep/structural-search before acting.
- **Save only what's durable:** decisions, architecture, conventions, root causes, and module pointers. Never persist lines, current signatures, call-site lists, or temporary state.
- `mem_save` proactively with a stable `topic_key` per topic. Reuse the same key to evolve an observation via upsert, not to create repeated snapshots.
- **Write-back:** if the code contradicts a memory, fix it with `mem_update`/`mem_save` right away. Treat `needs_review` as stale context.
- `mem_session_summary` is mandatory before "done": Goal · Discoveries · Accomplished · Next Steps · Relevant Files.
- **Curation at close:** after the summary, review what was created in the session. Consolidate duplicates under their `topic_key`, promote what's durable, and delete only volatile observations or ones already covered by the summary. Never aggressive deletion, never delete a durable decision.
- **R1 lean close** (the closeout block's three conditions): the summary and the curation step are exempt. `mem_save` is not — that one is what lets you reconstruct in six months why a commit exists.
