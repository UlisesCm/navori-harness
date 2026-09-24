---
name: semgrep-security-gate
description: Use when auditing security or closing a change that touches auth, RBAC, secrets or input validation and the repo renders the semgrep plugin — run the static scan over the diff before closing.
metadata:
  type: behavior
---

## Local security gate (semgrep)

Before closing a relevant change (auth, RBAC, secrets, input validation),
run semgrep over the diff, scoped to the changed `.ts`/`.tsx` files vs the
base branch:

```
git diff --name-only --diff-filter=ACMRT {{branchBase}} -- '*.ts' '*.tsx' | xargs -r semgrep scan --config=p/default --error --metrics=off --baseline-commit {{branchBase}}
```

`--config=p/default` (not `auto`) keeps the ruleset static and telemetry off
(`--metrics=off` is incompatible with `auto` on semgrep >=1.x); the
`--baseline-commit` flag makes the scan fail only on findings this branch
introduces, not on debt already on `{{branchBase}}`.
- Custom rules: see `.semgrep.yml` at the repo root if it exists.
- Silent skip if `semgrep` is not installed (don't block if the dev doesn't have it).

In repos with the Claude Code hooks, the commit/push gate already runs this
scan for you (`PreToolUse`) — the command above is for running it yourself
before that point.
