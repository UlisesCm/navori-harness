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

Not a bare `grep`/`rg` in the shell. Two reasons, both mechanical rather than stylistic:

- **It is the pre-approved path.** An `allow` rule covers this exact invocation, so it costs no permission prompt in any mode and no classifier round-trip in auto mode. A hand-written `rg …` gets neither (`rg --pre` runs an arbitrary command per file, which is why `rg` itself is not pre-approved).
- **It resolves the engine for you.** With `tgrep` installed the search uses a trigram index, rebuilt right before the search because a stale one produces silent false negatives; without it the wrapper falls back to `rg` and then to `grep -rn`, warns once on stderr, and preserves exit codes (0 = match, 1 = no match).

The flags are ripgrep's, so the rung's usual `-l`, `-n`, `-i`, `-F`, `-w`, `-g`, `-C` all carry over. Skip `--hidden`, `--no-ignore*` and `-a`: each one drops the index and turns the call into a full scan.

The native `Grep` tool remains a correct answer for a small, targeted lookup — it is also pre-approved. The wrapper is what scales when the tree is large or the token is common.
