---
name: codegraph-search-agent
description: Use when a search agent (researcher/explorer) starts a lookup and the repo has the codegraph MCP tool — query the AST graph before the grep sweep, then verify the span.
type: behavior
---

## Start at the graph, not at the grep

You are the repo's search role, so this applies to nearly every question you get.
When the `codegraph` MCP tool is available, ask the pre-built AST graph FIRST:
`codegraph_explore` takes a symbol name or a natural-language question and returns
the source span, the call paths and a blast-radius summary in ONE call — the work a
grep/read crawl spends a dozen calls rebuilding. It also follows dynamic hops
(callbacks, re-render, JSX children) that a string search cannot.

Then verify. The graph forms the hypothesis; it does not close the question:

- On a stale index or an ambiguous name it can return the WRONG symbol while
  reporting it as exact. Confirm the concrete span with `Grep`/`Read` before you
  cite it as evidence — a finding you report becomes someone's edit.
- Its "impact / tests found" is a hint, never a coverage claim.

If `codegraph` isn't installed or the index looks stale, skip this and search as
usual. Never block on it.
