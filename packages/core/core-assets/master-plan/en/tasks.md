# Part tasks.md template (`harness.masterPlan`, R35)

Same format as `spec-bootstrap` (batches of 1-3 tasks, each naming the `R<n>` it covers), plus these mandatory per-task fields:

- [ ] **T<n>** (R<n>, ...) — <title>.
  - **Files:** exact paths this task touches.
  - **Interfaces:** the ones it touches, each named in `design.md`.
  - **Pattern:** an existing repo file to follow.
  - **Reading:** closed list of files to read before writing.
  - **Libraries:** name and exact version (no `^` or `~`).
  - **Done:** command, expected result and named test cases. Names the `P<n>.A<m>` it closes.
  - **Out of scope:** what this task does NOT do.

Every `R<n>` in `requirements.md` cites the `P<n>.A<m>` it covers (R60).
