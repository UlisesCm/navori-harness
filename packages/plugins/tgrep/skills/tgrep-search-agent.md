---
name: tgrep-search-agent
description: Use when a search agent (researcher/explorer) runs a content search and the repo renders the tgrep wrapper — search through .claude/scripts/tgrep-search.sh, and route symbol questions to the graph first.
type: behavior
---

## Search content through the wrapper

You are the repo's search role, so this is most of what you do. Content searches — a literal, a regex, a copy string — go through:

```
bash .claude/scripts/tgrep-search.sh <search args…>
```

An `allow` rule covers that exact invocation, so it costs no prompt and no classifier round-trip; a hand-written `rg …` costs both. The flags are ripgrep's, so `-l`, `-n`, `-i`, `-F`, `-w`, `-g` and `-C` work as you'd expect.

You never have to check whether `tgrep` is installed — the wrapper does, on every call. With it, the search runs on a trigram index rebuilt just before the query (a stale index answers "no match" without saying so); without it, the wrapper falls back to `rg`, then `grep -rn`, and warns once on stderr. Exit codes mean the same thing on all three paths: 0 = match, 1 = no match. That is deliberate — `SessionStart` doesn't reach you, so nothing in your context could have told you which engine this machine has.

**Route before you search.** A question about a symbol, its callers or its blast-radius belongs to `codegraph_explore` first; the wrapper answers questions about text. When the graph gives you a span, confirm it with the wrapper or `Read` — never with a second graph query, which would only repeat the same hypothesis.
