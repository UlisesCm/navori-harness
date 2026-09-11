---
name: structural-search
description: Use when locating something in code before reading it (a symbol, syntactic shape, structural relation, refactor site) — find the right region and open only the confirmed span instead of reading whole files; escalate from engram to Grep to ast-grep per the trigger.
type: reference
maxWords: 600
---

<!-- navori:managed id="structural-search-base" hash="ec61be0a" version="0.8.4" source="@navori/core" -->
# structural-search — read the minimum correct amount

Find the right region first and open only the confirmed span. Precision tools verify a hypothesis; they don't form it.

## Ladder Rung 0–2

### Rung 0 — orientation (only if the repo has persistent memory)

If this repo has persistent memory (the engram plugin is enabled), consult it first for durable questions: where a module lives, entry points, layers, conventions and decisions. Use the result as a **scope hypothesis**, never as a source of truth for lines, signatures or call sites.

Confirm every pointer with a cheap search. If the code contradicts memory, correct the observation immediately. Save structural pointers, not volatile snapshots. Without persistent memory, skip this rung and start at Rung 1.

### Rung 1 — text with Grep/ripgrep (default)

Use it when you know a literal token: name, import, config key, error string.

Native `Grep` first — it IS ripgrep, pre-approved, ~0.08s vs ~0.20s (p75 1.83s) by shell, which in auto mode also pays a classifier round-trip. Shell `rg` is the fallback (git history, context flags), not the default.

1. Start narrow: file, directory or type obtained in Rung 0.
2. Ask first for files (`Grep` files mode; `rg -l` via shell) or `file:line` with at most two lines of context.
3. Dedup before reading.
4. Open only the span that confirms the hit.

**The shell is for what those tools don't cover** — FS metadata (`-size`, `-mtime`, permissions). `find` isn't pre-approved on purpose: with `-exec`/`-delete` it isn't purely read-only, so the prompt there is the right safety net rather than a nuisance. And when a command genuinely must be shell, the shape that costs is MANY small ones — a measured session spent 835 classifier round-trips, so `cmd1 && cmd2` in a single call beats two calls.

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

<!-- navori:managed id="codegraph-search-extension" hash="dd662711" version="0.8.4" source="@navori/plugin-codegraph" -->
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

<!-- navori:managed id="tgrep-search-extension" hash="e0b59402" version="0.8.4" source="@navori/plugin-tgrep" -->
## Rung 1 — the executor is the wrapper

The executor is `bash .claude/scripts/tgrep-search.sh <args…>`, never a bare
`grep`/`rg`. The CLAUDE.md protocol block carries that rule and its `allow`; this is
the depth it points here for.

- **Checking WHICH engine ran.** Empty stderr means tgrep itself ran — the fallback
  line is the only thing the wrapper prints there. Redirect to SEPARATE files
  (`> out 2> err`): `2>&1 1>/dev/null | head` hands you stdout under zsh's MULTIOS, so
  a search with results reads as "stderr empty" — a false "tgrep ran" from the command
  meant to prove it.
- **It resolves the engine for you.** With `tgrep` the search uses a trigram index, rebuilt right before the query: a stale index answers exit 1 with no warning, a false negative indistinguishable from "no match", so the rebuild is a correctness requirement and not a preference (it measured 0.07s on the largest repo in the fleet). Without `tgrep` the wrapper falls back to `rg`, then to `grep -rn`, prints ONE line on stderr naming the engine and the install command, and keeps the exit-code contract (0 = match, 1 = no match) on all three paths — with one exception that matters: on the `grep -rn` path, if no pattern survives the flag dropping, it **exits 2** (`nothing was searched`). Read as "no match" that IS the silent false negative this design exists to prevent. 2 is not 1.

That decision lives in the script rather than in the doctrine on purpose: `SessionStart` hooks don't run for subagents, so a subagent cannot know what the machine has — but the same command is right for all of them.

### Routing: the graph or the wrapper

| The question | First call |
|---|---|
| where is this symbol, who calls it, what breaks if I change it | `codegraph_explore` |
| which files contain this literal / regex / copy string | the wrapper |
| confirming the span the graph just handed you | the wrapper or `Read` — never a second graph query |

Layers, not competitors: the graph forms the hypothesis about structure and impact; the wrapper is one of the two ways to close it.

**Searching is not extracting.** The index answers *which file holds X*. Once you already know the file and want its lines, `grep -n "x" that-file` or `Read` is the right call and the cheaper one — the wrapper would reindex the whole tree to read a single file. Measured on real sessions, this is a third of the shell `grep` calls, and all of them are correct.

### Flags

Portable across the engines the wrapper may pick: `-i -l -c -n -F -w -e -g -A/-B/-C -m`.

Avoid through the wrapper: `--hidden`, `--no-ignore*` and `-a/--text` each turn the search into a brute-force scan (verified with `--stats`), which is the cost the index exists to avoid; `-t/--type` doesn't name the same type sets in both engines. On the `grep -rn` path only the pattern and the paths survive the translation — the wrapper says on stderr when it drops flags.

**Dot-directories** (the block states the rule): the full scan is the price of `--hidden`, and `git grep` is the other way to reach tracked files there.
<!-- /navori:managed id="tgrep-search-extension" -->

## The project's structural patterns

<!-- user: document here proven sg/ast-grep patterns, frequent languages and paths. Save reusable patterns; don't paste results nor current lines. -->
