---
name: codegraph-rung
description: Use when locating code to change and the repo has the codegraph MCP tool — query the AST graph as Rung -1 before the grep/ast-grep ladder, then verify the span.
type: behavior
---

## Rung -1 — query the code graph first (codegraph)

Before the grep/ast-grep ladder above, if the `codegraph` MCP tool is available, ask the pre-built AST graph where the code lives:

- **Locate a symbol / definition:** `codegraph_explore` with the symbol name or a natural-language question ("where is the auth token refreshed?"). One call returns the source span + call paths, instead of a `grep` sweep.
- **Trace impact:** ask what calls a function or what a change touches, to size the blast-radius before reading files.

The graph **forms the hypothesis** (which files/symbols matter). The rungs above still **verify** it — never edit off the graph alone:

- On a stale index or ambiguous name, codegraph can return the wrong symbol while claiming it's exact. Confirm the concrete span with `Grep`/`Read` before writing, especially in critical areas.
- Treat its blast-radius / "tests found" as a hint, not a coverage gate — the repo's real tests decide.

If `codegraph` isn't installed or the index looks stale, skip this rung and start at the grep/ast-grep ladder as usual.
