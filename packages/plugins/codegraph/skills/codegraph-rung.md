---
name: codegraph-rung
description: Use when locating code to change and the repo has the codegraph MCP tool — query the AST graph as Rung -1 before the grep/ast-grep ladder, then verify the span.
type: behavior
---

## Rung -1 — query the code graph first (codegraph)

Before the grep/ast-grep ladder above, if `codegraph` is available, ask the AST graph where the code lives. Its `allow` rule skips the classifier check every shell command pays in auto mode:

- **Locate a symbol:** `codegraph_explore` with the name or a plain question ("where is the auth token refreshed?"). One call returns the span and call paths.
- **Trace impact:** ask what calls a function, to size the blast-radius before reading.

The graph **forms the hypothesis**; the rungs above still **verify** it:

- On a stale index or an ambiguous name it can return the **wrong** symbol while claiming it's exact. Confirm the span with `Grep`/`Read` before writing, especially in critical areas.
- Its blast-radius and "tests found" are hints, not a coverage gate — the repo's real tests decide.
- Not installed, or the index looks stale? Skip this rung: an accelerator, never a dependency.

**Monorepo:** `projectPath` opens a sub-project **without the file watcher**, so that index goes stale faster. Run `codegraph init` per sub-repo, `codegraph sync` before critical work.

**Never commit the index:** `.codegraph/` is local SQLite that churns on every sync — it belongs in `.gitignore`.
