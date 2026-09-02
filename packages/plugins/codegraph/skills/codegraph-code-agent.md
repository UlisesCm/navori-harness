---
name: codegraph-code-agent
description: Use when an agent that writes or reviews code needs to locate a span or size a change's blast-radius and the repo has the codegraph MCP tool — query the AST graph, then confirm the span before acting on it.
type: behavior
---

## Locate before you touch

You act on code someone else wrote, so the first question is always *where*.
When the `codegraph` MCP tool is available, ask the graph instead of crawling:
`codegraph_explore` takes a symbol or a plain question and returns the span, the
call paths and a blast-radius summary in one call. It also follows dynamic hops
(callbacks, re-render, JSX children) that a string search misses — which is how
a "small" edit turns out to have thirteen call sites.

It is also the cheapest route in auto mode: `mcp__codegraph__*` carries an
`allow` rule, so it skips the classifier round-trip every shell command pays.

Then confirm. The graph forms the hypothesis; it never closes it:

- On a stale index or an ambiguous name it returns the WRONG symbol while
  reporting it as exact. Open the span with `Grep`/`Read` before you edit it or
  cite it in a review.
- Its "impact / tests found" is a hint, not a coverage gate.

Not installed, or the index looks stale? Skip it and work as usual — an
accelerator, never a dependency.
