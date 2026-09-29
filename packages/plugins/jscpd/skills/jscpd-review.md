---
name: jscpd-duplication-gate
description: Use when reviewing a diff and the repo renders the jscpd plugin — scan the changed files for duplication before approving, and treat any clone that is new vs the base branch as a blocker.
metadata:
  type: behavior
---

## Code duplication (jscpd)

Before approving a change, run `jscpd` over the changed `.ts`/`.tsx` files vs
the base branch, failing on any clone that is new vs that base:

```
git diff --name-only --diff-filter=ACMRT {{branchBase}} -- '*.ts' '*.tsx' | xargs -r jscpd --min-tokens 100 --min-lines 10 --mode strict --baseline-from-ref {{shq:branchBase}} --fail-on-new-clones 0
```

A literal `{{branchBase}}` left unsubstituted here would be a silent no-op
scan (#273) — the values above come from the repo's own config at render
time, never typed by hand.
- Fingerprint sensitivity: editing inside an existing clone (even a single line) changes its fingerprint, so jscpd reports it as new — it counts as a new clone even though the duplication itself predates the change.
- If it reports a new clone vs the base branch: **do not approve** the change without justification (reviewers must ask for a refactor or extraction).
- Silent skip if `jscpd` is not in `PATH` (don't block if the dev doesn't have the tool installed).

In repos with the Claude Code hooks, the commit gate already runs this scan
for you (`PreToolUse` on `git commit`) — the command above is for running it
yourself before that point.
