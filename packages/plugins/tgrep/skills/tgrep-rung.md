---
name: tgrep-rung
description: Use when the ladder reaches a content search (literal or regex) and the repo renders the tgrep wrapper — run the search through .claude/scripts/tgrep-search.sh instead of a bare shell grep.
type: behavior
# 550 y no 200 (spec 0020, R4): esta skill absorbió la tabla de ruteo grafo/wrapper,
# los flags portables y la razón del rebuild del índice, que antes vivían en el bloque
# `tgrep-protocol` del CLAUDE.md. El cap acota el costo POR CARGA de una skill; el
# bloque se pagaba en CADA sesión. Mover 300 palabras de always-on a on-demand es la
# ganancia, aunque la skill engorde.
maxWords: 550
---

## Rung 1 — the executor is the wrapper

When this rung searches by content, the command is:

```
bash .claude/scripts/tgrep-search.sh <search args…>
```

Not a bare `grep`/`rg`. Two mechanical reasons:

- **It is the pre-approved path.** An `allow` rule covers this exact invocation: no permission prompt in any mode, no classifier round-trip in auto. A hand-written `rg …` gets neither — `rg --pre` runs an arbitrary command per file.
- **It resolves the engine for you.** With `tgrep` the search uses a trigram index, rebuilt right before the query: a stale index answers exit 1 with no warning, a false negative indistinguishable from "no match", so the rebuild is a correctness requirement and not a preference (it measured 0.07s on the largest repo in the fleet). Without `tgrep` the wrapper falls back to `rg`, then to `grep -rn`, prints ONE line on stderr naming the engine and the install command, and keeps the exit-code contract (0 = match, 1 = no match) on all three paths.

That decision lives in the script rather than in the doctrine on purpose: `SessionStart` hooks don't run for subagents, so a subagent cannot know what the machine has — but the same command is right for all of them.

### Routing: the graph or the wrapper

| The question | First call |
|---|---|
| where is this symbol, who calls it, what breaks if I change it | `codegraph_explore` |
| which files contain this literal / regex / copy string | the wrapper |
| confirming the span the graph just handed you | the wrapper or `Read` — never a second graph query |

They are layers, not competitors: the graph answers about structure and impact, the wrapper about text. The graph forms the hypothesis; the wrapper is one of the two ways to close it.

**Searching is not extracting.** The index answers *which file holds X*. Once you already know the file and want its lines, `grep -n "x" that-file` or `Read` is the right call and the cheaper one — the wrapper would reindex the whole tree to read a single file. Measured on real sessions, this is a third of the shell `grep` calls, and all of them are correct.

### Flags

Portable across the engines the wrapper may pick: `-i -l -c -n -F -w -e -g -A/-B/-C -m`.

Avoid through the wrapper: `--hidden`, `--no-ignore*` and `-a/--text` each turn the search into a brute-force scan (verified with `--stats`), which is the cost the index exists to avoid; `-t/--type` doesn't name the same type sets in both engines. On the `grep -rn` path only the pattern and the paths survive the translation — the wrapper says on stderr when it drops flags.

**Dot-directories are the exception.** `.claude/`, `.github/` and the like sit outside every default search, here and in the native `Grep`. Searching the harness itself needs `--hidden` and the full scan is the price; an empty result without it proves nothing. `git grep` is the other way to reach tracked files in those directories.
