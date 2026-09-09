---
name: tgrep-code-agent
description: Use when an agent that writes or reviews code needs to find a literal, a call site or a copy string and the repo renders the tgrep wrapper — search through .claude/scripts/tgrep-search.sh after the graph has located the symbol.
type: behavior
---

## Find it with the wrapper before you touch it

You act on code someone else wrote, so most edits start with a lookup. For anything textual — a literal, a copy string, every place a flag name appears — the command is:

```
bash .claude/scripts/tgrep-search.sh <search args…>
```

It is pre-approved by an `allow` rule (no prompt, no classifier round-trip) and its flags are ripgrep's. It also decides the engine on every call: a trigram index when `tgrep` is installed — rebuilt right before the search, because a stale index reports "no match" without a warning and a review that misses a call site is worse than a slow one — and `rg`, then `grep -rn`, when it is not. Exit codes hold on all three paths: 0 = match, 1 = no match.

**Structure first, text second.** *Where is this symbol, who calls it, what breaks if I change it* is `codegraph_explore`; *which files contain this string* is the wrapper. Confirming the span the graph proposed is also the wrapper's job (or `Read`) — a second graph query just restates the hypothesis.

Sizing a change is exactly this pair: the graph gives the call paths, the wrapper proves the count. A "one-line" change with thirteen call sites is found by the second half.
