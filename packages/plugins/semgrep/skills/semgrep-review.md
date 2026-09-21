---
name: semgrep-security-gate
description: Use when auditing security or closing a change that touches auth, RBAC, secrets or input validation and the repo renders the semgrep plugin — run the static scan over the diff before closing.
metadata:
  type: behavior
---

## Local security gate (semgrep)

Before closing a relevant change (auth, RBAC, secrets, input validation), run
the repository's canonical gate command:

```
bun run semgrep:check
```

The script diffs `{{branchBase}}...HEAD` and scans it with
`--config=p/default --error --metrics=off` (deterministic, telemetry-off) —
do not recreate that scoping or those flags with a manual `xargs` command.
- Custom rules: see `.semgrep.yml` at the repo root if it exists.
- Silent skip if `semgrep` is not installed (don't block if the dev doesn't have it).

The commit/push gate runs this for you (`PreToolUse`), so this text is the
reasoning and the canonical command — not a second mechanism.
