---
name: jscpd-duplication-gate
description: Use when reviewing a diff and the repo renders the jscpd plugin — scan the changed files for duplication before approving, and treat clones over the threshold as a blocker.
type: behavior
---

## Code duplication (jscpd)

Before approving a change, run jscpd over the diff vs the base branch.

- Only over modified files:
  ```
  git diff --name-only {{branchBase}}...HEAD | grep -E '\.(ts|tsx|js|jsx)$' | xargs jscpd --silent
  ```
- If it reports clones >0 with the project's threshold: **do not approve** the change without justification (reviewers must ask for a refactor or extraction).
- Silent skip if `jscpd` is not in `PATH` (don't block if the dev doesn't have the tool installed).

The commit gate runs this for you (`PreToolUse` on `git commit`), so this text is
the reasoning and the manual command — not the mechanism.
