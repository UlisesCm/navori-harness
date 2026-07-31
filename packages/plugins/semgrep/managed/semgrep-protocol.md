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
- `p/default` (not `auto`) on purpose: deterministic and telemetry-off — mirrors `scripts/check-semgrep.sh`.
- Custom rules: see `.semgrep.yml` at the repo root if it exists.
- Silent skip if `semgrep` is not installed (don't block if the dev doesn't have it).
