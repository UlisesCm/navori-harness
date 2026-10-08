# Delivery tasks template (`harness.masterPlan`, R35)

Organize work by deliveries, each with milestones, acceptance criteria, and tasks. Each task declares exact files, interfaces, pattern file, closed-list reads, pinned library versions, command and expected result, named test cases, and out-of-scope items; do not write function bodies in tasks.

## E1 — <delivery title>

Estimated LOC: <number>

### M1 — <milestone title>

- **A1** [observable] — <criterion description> · `<command>` → <expected output>

- [ ] **T1** (R<n>, ...) — <title> · effect: behavior · test: <file>::<case>
  - **Files:** exact paths this task touches.
  - **Interfaces:** the ones it touches, each named in `design.md`.
  - **Pattern:** an existing repo file to follow.
  - **Reading:** closed list of files to read before writing.
  - **Libraries:** name and exact version (no `^` or `~`).
  - **Done:** command, expected result, and test cases by name. Names the `P<n>.A<m>` it closes.
  - **Out of scope:** what this task does NOT do.

### M2 — <milestone title>

- **A2** — <description> · `<command>` → <expected output>

- [ ] **T2** (R<n>) — <title> · effect: tests · test: <file>::<case>
  - **Files:** ...
  - **Interfaces:** ...
  - **Pattern:** ...
  - **Reading:** ...
  - **Libraries:** ...
  - **Done:** ...
  - **Out of scope:** ...

## E2 — <next delivery title>

Estimated LOC: <number>

### M3 — <milestone title>

- **A3** [observable] — <description> · `<command>` → <expected output>

- [ ] **T3** (R<n>) — <title> · effect: behavior · test: <file>::<case>
  - **Files:** ...

Each `R<n>` in `requirements.md` cites the `P<n>.A<m>` it covers (R60).
