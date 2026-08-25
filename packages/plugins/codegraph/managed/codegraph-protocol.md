## CodeGraph (surgical code context)

This repo has a pre-built AST code graph exposed over MCP (`codegraph`). To locate code or size a change's blast-radius, call `codegraph_explore` **before** a grep/read crawl: one call returns the source span, call paths and impact.

It forms the hypothesis; it does not settle it. codegraph is beta and can return the wrong symbol while claiming it's exact, so **confirm the span with `Grep`/`Read` before writing** — and never treat its "tests found" as a coverage gate.

How to use it in practice — the full ladder, the monorepo caveat and the index rules — is Rung -1 of the `structural-search` skill, loaded when you actually go looking for code.
