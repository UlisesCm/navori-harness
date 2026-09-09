---
name: tgrep-code-agent
description: Use when an agent that writes or reviews code needs to find a literal, a call site or a copy string and the repo renders the tgrep wrapper — search through .claude/scripts/tgrep-search.sh after the graph has located the symbol.
type: behavior
---

## Find it with the wrapper before you touch it

Most edits start with a lookup. For anything textual — a literal, a copy string, every place a flag name appears:

```
bash .claude/scripts/tgrep-search.sh <search args…>
```

An `allow` rule makes it promptless and classifier-free, and its flags are ripgrep's. It also decides the engine on every call: a trigram index when `tgrep` is installed — rebuilt right before the search, because a stale index reports "no match" without a warning, and a review that misses a call site is worse than a slow one — and `rg`, then `grep -rn`, when it is not. Exit codes hold on all three paths: 0 = match, 1 = no match.

**Structure first, text second.** *Where is this symbol, who calls it, what breaks if I change it* is `codegraph_explore`; *which files hold this string* is the wrapper. Confirming the span the graph proposed is the wrapper's job too (or `Read`) — a second graph query only restates the hypothesis.

Sizing a change is that pair: the graph gives the call paths, the wrapper proves the count.
