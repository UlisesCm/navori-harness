## Content search (the tgrep wrapper)

Content search — a literal, a regex, a copy string — goes through one command:

```
bash .claude/scripts/tgrep-search.sh <search args…>
```

It carries an `allow` rule, so it runs with no permission prompt in every mode and without the classifier round-trip a plain shell command pays in auto mode. Its flag surface is ripgrep's, so what you would have written for `rg` works unchanged.

**The wrapper picks the engine — never ask which one is installed.** With `tgrep` present it searches a trigram index that is rebuilt immediately before each search: a stale index answers exit 1 with no warning, a false negative indistinguishable from "no match", so the rebuild is a correctness requirement and not a preference (it measured 0.07s on the largest repo in the fleet). Without `tgrep` it falls back to `rg`, then to `grep -rn`, prints ONE line on stderr naming the engine and the install command, and keeps the exit-code contract (0 = match, 1 = no match) on all three paths.

That decision lives in the script rather than in this text on purpose: `SessionStart` hooks don't run for subagents, so a subagent cannot know what the machine has — but the same command is right for all of them.

**Searching is not extracting.** The index answers *which file holds X*. Once you already know the file and want its lines, `grep -n "x" that-file` or `Read` is the right call and the cheaper one — the wrapper would reindex the whole tree to read a single file. Measured on real sessions, this is a third of the shell `grep` calls, and all of them are correct.

### Routing: the graph or the wrapper

| The question | First call |
|---|---|
| where is this symbol, who calls it, what breaks if I change it | `codegraph_explore` |
| which files contain this literal / regex / copy string | the wrapper |
| confirming the span the graph just handed you | the wrapper or `Read` — never a second graph query |

They are layers, not competitors: the graph answers about structure and impact, the wrapper about text. The graph forms the hypothesis; the wrapper is one of the two ways to close it.

### Flags

Portable across the engines the wrapper may pick: `-i -l -c -n -F -w -e -g -A/-B/-C -m`.

Avoid through the wrapper: `--hidden`, `--no-ignore*` and `-a/--text` each turn the search into a brute-force scan (verified with `--stats`), which is the cost the index exists to avoid; `-t/--type` doesn't name the same type sets in both engines. On the `grep -rn` path only the pattern and the paths survive the translation — the wrapper says on stderr when it drops flags.

**What you don't search by default.** Like ripgrep — and like the native `Grep`, which is ripgrep too — the wrapper skips dot-directories, so `.claude/`, `.github/` and friends are OUTSIDE every search unless you pass `--hidden`. It is not a bug and there is no warning: a search for a string that lives only in your own skills or agents comes back empty and looks exactly like "it isn't there". When the harness itself is what you're searching, `--hidden` is required and the full scan is the price; `git grep` is the other way to reach tracked files in those directories.
