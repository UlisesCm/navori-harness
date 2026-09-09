---
name: tgrep-rung
description: Use when the ladder reaches a content search (literal or regex) and the repo renders the tgrep wrapper — run the search through .claude/scripts/tgrep-search.sh instead of a bare shell grep.
type: behavior
---

## Rung 1 — the executor is the wrapper

When this rung searches by content, the command is:

```
bash .claude/scripts/tgrep-search.sh <search args…>
```

Not a bare `grep`/`rg`. Two mechanical reasons:

- **It is the pre-approved path.** An `allow` rule covers this exact invocation, so it costs no permission prompt in any mode and no classifier round-trip in auto mode. A hand-written `rg …` gets neither: `rg --pre` runs an arbitrary command per file, which is why `rg` is not pre-approved.
- **It resolves the engine for you.** With `tgrep` installed the search uses a trigram index, rebuilt right before the query because a stale one produces silent false negatives; without it the wrapper falls back to `rg`, then `grep -rn`, warns once on stderr, and preserves exit codes (0 = match, 1 = no match).

Flags are ripgrep's, so `-l`, `-n`, `-i`, `-F`, `-w`, `-g` and `-C` carry over. Skip `--hidden`, `--no-ignore*` and `-a`: each drops the index and turns the call into a full scan.

The native `Grep` stays correct for a small, targeted lookup. The wrapper is what scales.
