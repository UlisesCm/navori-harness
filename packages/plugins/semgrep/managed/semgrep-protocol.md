## Local security gate (semgrep)

Before closing a relevant change (auth, RBAC, secrets, input validation), run semgrep over the diff.

- Quick diff scan:
  ```
  git diff --name-only $BRANCH_BASE...HEAD | xargs semgrep --config=auto --severity=ERROR
  ```
- Full project scan (slower, opt-in):
  ```
  semgrep --config=auto --error
  ```
- Custom rules: see `.semgrep.yml` at the repo root if it exists.
- Silent skip if `semgrep` is not installed (don't block if the dev doesn't have it).
