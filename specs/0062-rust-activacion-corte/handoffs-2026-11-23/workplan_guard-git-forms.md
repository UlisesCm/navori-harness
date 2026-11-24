# Workplan — guard-git-forms

## Clasificación
Complexity: 4/10 · Level: 1
Signals: non-trivial-files:3(+2), root-dirs:6(+2)

## Objetivo
Issue #1801: guard-destructive rule 7 also recognises git written as a path (basename git), behind `env` (with or without VAR= assignments) or escaped (\git), and treats a GIT_DIR/GIT_WORK_TREE set as a prefix of the segment or assigned/exported by an earlier segment of the same command as an uninspectable directory (block, same treatment as --git-dir/--work-tree). Identical in shell and native; re-signs; stacked on #1800 (base fix/guard-git-fail-closed). Enters [grupo-refirmas-2] only if reviewed, green and with receipt by Wed 25 nov 12:00 (decisiones-ulises/2026-11-23-1610); otherwise documented as a known 0.13 limitation.

## Criterios
- **A1** (pendiente) — Native tests: the #1801 matrix (GIT_DIR/GIT_WORK_TREE prefix in both orders, export in an earlier segment, /usr/bin/git reset and -C clean, env git) blocks; git reset --hard, FOO=1 git, command git, --git-dir still behave as today; a non-discard git with a path (e.g. /usr/bin/git status) is allowed.
  - command: `systemd-run --user --scope -p MemoryMax=8G -p MemorySwapMax=0 -p CPUWeight=20 -p IOWeight=20 -- flock /tmp/navori-heavy.lock env CARGO_BUILD_JOBS=4 CARGO_TARGET_DIR=~/.cache/navori-rust/target-s1-guardforms cargo test -p navori-hooks -- --test-threads=4`
  - expected: test result: ok, new cases included
- **A2** (pendiente) — Shell/native parity end to end on the #1801 matrix.
  - command: `WT=$PWD BIN=~/.cache/navori-rust/target-s1-guardforms/release/navori-rust bash ~/.cache/navori-rust/s1/guard-git/forms.sh`
  - expected: every bold row of #1801 deny/deny; the other rows unchanged; same verdict in shell and rust on every row
- **A3** (pendiente) — Re-sign consistent, rendered copies in sync, guard suites green in bash and zsh.
  - command: `node scripts/js/rust-hooks-sync.mjs --check && bun run check:render && systemd-run --user --scope -p MemoryMax=8G -p MemorySwapMax=0 -p CPUWeight=20 -p IOWeight=20 -- flock /tmp/navori-heavy.lock bun run --filter navori test -- guard native-hook hook-fuzz hook-verdict-replay hooks-zsh-parity engines`
  - expected: exit 0
- **A4** (pendiente) — Full gate.
  - command: `systemd-run --user --scope -p MemoryMax=8G -p MemorySwapMax=0 -p CPUWeight=20 -p IOWeight=20 -- flock /tmp/navori-heavy.lock navori gate full`
  - expected: navori gate full: exit 0

## Fuera de alcance
- GIT_DIR/GIT_WORK_TREE inherited from the hook's own environment (not written in the command)
- sudo/xargs/eval/sh -c wrappers around git
- Other guard rules

## Archivos
- packages/core/core-assets/hooks/guard-destructive.sh
- .claude/hooks/guard-destructive.sh
- .pi/navori/hooks/guard-destructive.sh
- crates/navori-hooks/src/hooks/guard_destructive/discard.rs
- crates/navori-hooks/tests/guard_destructive.rs
- packages/cli/src/lib/__tests__/guard-destructive.test.ts
- crates/ported.json

## Decisiones
- (none)
