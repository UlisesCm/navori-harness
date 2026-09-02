## CodeGraph (surgical code context)

This repo has a pre-built AST code graph exposed over MCP (`codegraph`). To locate code or size a change's blast-radius, call `codegraph_explore` **before** a grep/read crawl: one call returns the source span, call paths and impact.

**In auto mode this is the cheapest move available, not a luxury the shell preference overrides.** The host asks you to work through Bash instead of `Read`/`Edit`/`Write`; an MCP call is neither, and `mcp__codegraph__*` carries an `allow` rule, so it resolves without the classifier round-trip every shell command pays. One `codegraph_explore` costs less than the grep crawl it replaces — measured sessions in this harness ran hundreds of shell searches and zero graph queries, which is the expensive way round.

It forms the hypothesis; it does not settle it. codegraph is beta and can return the wrong symbol while claiming it's exact, so **confirm the span with `Grep`/`Read` before writing** — and never treat its "tests found" as a coverage gate.

How to use it in practice — the full ladder, the monorepo caveat and the index rules — is Rung -1 of the `structural-search` skill, loaded when you actually go looking for code.
