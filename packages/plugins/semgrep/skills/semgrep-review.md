---
name: semgrep-security-gate
description: Use when auditing security or closing a change that touches auth, RBAC, secrets or input validation and the repo renders the semgrep plugin — run the static scan over the diff before closing.
type: behavior
---

## Local security gate (semgrep)

Before closing a relevant change (auth, RBAC, secrets, input validation), run semgrep over the diff.

- Quick diff scan:
  ```
  git diff --name-only {{branchBase}}...HEAD | xargs semgrep scan --config=p/default --error --metrics=off
  ```
- Full project scan (slower, opt-in):
  ```
  semgrep scan --config=p/default --error --metrics=off
  ```
- `p/default` (not `auto`) on purpose: deterministic and telemetry-off — mirrors the plugin's check script.
- Custom rules: see `.semgrep.yml` at the repo root if it exists.
- Silent skip if `semgrep` is not installed (don't block if the dev doesn't have it).

The commit/push gate runs this for you (`PreToolUse`), so this text is the
reasoning and the manual command — not the mechanism.
