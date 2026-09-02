---
name: structural-search
description: Use when locating something in code before reading it (a symbol, syntactic shape, structural relation, refactor site) — find the right region and open only the confirmed span instead of reading whole files; escalate from engram to Grep to ast-grep per the trigger.
type: reference
---

<!-- navori:managed id="structural-search-base" hash="151d7d2b" version="0.7.0" source="@navori/core" -->
# structural-search — read the minimum correct amount

Find the right region first and open only the confirmed span. Precision tools verify a hypothesis; they don't form it.

## Ladder Rung 0–2

### Rung 0 — orientation (only if the repo has persistent memory)

If this repo has persistent memory (the engram plugin is enabled), consult it first for durable questions: where a module lives, entry points, layers, conventions and decisions. Use the result as a **scope hypothesis**, never as a source of truth for lines, signatures or call sites.

Confirm every pointer with a cheap search. If the code contradicts memory, correct the observation immediately. Save structural pointers, not volatile snapshots. Without persistent memory, skip this rung and start at Rung 1.

### Rung 1 — text with Grep/ripgrep (default)

Use it when you know a literal token: name, import, config key, error string.

1. Start narrow: file, directory or type obtained in Rung 0.
2. Ask first for files (`rg -l`) or `file:line` with at most two lines of context.
3. Dedup before reading.
4. Open only the span that confirms the hit.

Escalate to Rung 2 only if one of these happens:

- zero results after two reasonable patterns;
- the results are pure noise;
- you're writing regex to approximate syntax;
- you need a multi-site structural refactor.

### Rung 2 — structure with ast-grep

`ast-grep` is the canonical binary for AST shapes — spell it out in full:

```bash
ast-grep -p 'async function $N($$$) { $$$ }' -l ts src/
ast-grep -p 'useAuth($$$)' -l tsx apps/
```

Homebrew also installs it as `sg`, and that alias is deliberately NOT pre-approved: on Linux `sg` is shadow-utils — `sg <group> -c "<command>"` runs an arbitrary command, so allowlisting it would bypass the whole permission layer. Type `ast-grep`.

To rewrite, first test the pattern without `--rewrite`, limit paths/language and review the diff before applying. A literal name is still Rung 1; a conceptual question goes back to Rung 0.

If it isn't installed, fall back to Grep and targeted reading: **don't block the task** nor invent ast-grep syntax.

## Quick map

| Need | Rung |
|---|---:|
| Where an adapter or convention lives | 0 |
| Known import, symbol or message | 1 |
| Hooks/components with a concrete shape | 2 |
| Multi-site codemod | 2 |
| Cross-file semantics with types | manual read of the confirmed span |

## Limits

- Don't read whole files by reflex.
- Don't run wide grep without scope.
- Don't use regex as AST.
- If the search consumes ~15% of the context, stop: reduce scope or act on the available evidence.
- Don't set up LSP/Serena; this harness ends at Rung 2.
<!-- /navori:managed id="structural-search-base" -->

<!-- navori:managed id="codegraph-search-extension" hash="dd662711" version="0.7.0" source="@navori/plugin-codegraph" -->
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
<!-- /navori:managed id="codegraph-search-extension" -->

## The project's structural patterns

<!-- user: document here proven sg/ast-grep patterns, frequent languages and paths. Save reusable patterns; don't paste results nor current lines. -->
