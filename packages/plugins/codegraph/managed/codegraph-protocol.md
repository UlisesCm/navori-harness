## CodeGraph (surgical code context)

This repo has a pre-built AST code graph exposed over MCP (`codegraph`). Use it to locate code and reason about impact in **one call** instead of a grep/read crawl.

**Query the graph first.** For "where does `X` live? what calls `Y`? what breaks if I change `Z`?", call `codegraph_explore` (a natural-language query or a bag of symbols) **before** grep/read. One call returns the source span, call paths and blast-radius.

**It's Rung -1 of `structural-search`, not a replacement.** The graph *forms* the hypothesis (which files/symbols matter); the grep/ast-grep ladder in `structural-search` still *verifies* it. Query the graph, then confirm the concrete span before opening files.

**⚠️ Do NOT blindly trust "verbatim — do not Read".** codegraph is beta with known correctness gaps: on a stale index or ambiguous names it can return the **wrong** symbol while claiming it's exact, and `callers`/`callees`/`impact` may answer for a different fuzzy match without warning. For any change you're about to write — especially in a critical area — **verify the real span with `Read`/`Grep`** first. The graph is a fast hypothesis, never the final word.

**Don't use blast-radius as a coverage gate.** codegraph's "impact / tests found" is unreliable (false "no tests found"). The repo's real test suite still decides coverage.

**Monorepo:** `codegraph_explore` takes a `projectPath`, but that mode opens the sub-project **without the file watcher** → higher stale risk. Run `codegraph init` (and `codegraph sync` before critical work) per sub-repo.

**Don't commit the index.** It lives in a local `.codegraph/` SQLite directory that churns on every sync — add `.codegraph/` to `.gitignore`. `codegraph init` (run in the plugin's post-install) builds it and the native file watcher keeps it fresh; the repo shares the *instruction* to use codegraph (this block), not the index.

If `codegraph` isn't installed or the index is stale, fall back to `structural-search` as usual — the graph is an accelerator, not a dependency.
