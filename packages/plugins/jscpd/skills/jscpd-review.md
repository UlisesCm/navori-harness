---
name: jscpd-duplication-gate
description: Use when reviewing a diff and the repo renders the jscpd plugin — scan the changed files for duplication before approving, and treat clones over the threshold as a blocker.
metadata:
  type: behavior
---

## Code duplication (jscpd)

Before approving a change, run the repository's canonical gate command:

```
bun run jscpd:check
```

The script diffs `{{branchBase}}...HEAD` for changed TS/TSX files and scans
only those — do not recreate that scoping (nor the pinned binary or the
configured threshold) with a hand-written `xargs` command. A literal
`$BRANCH_BASE` here would be a silent no-op scan (#273): the script resolves
it from the repo's own config, not from this doc.
- If it reports clones >0 with the project's threshold: **do not approve** the change without justification (reviewers must ask for a refactor or extraction).
- Silent skip if `jscpd` is not in `PATH` (don't block if the dev doesn't have the tool installed).

The commit gate runs this for you (`PreToolUse` on `git commit`), so this text is
the reasoning and the canonical command — not a second mechanism.
