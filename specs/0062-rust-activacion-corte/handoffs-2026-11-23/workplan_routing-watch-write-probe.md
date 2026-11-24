# Workplan — routing-watch-write-probe

## Clasificación
Complexity: 4/10 · Level: 1
Signals: non-trivial-files:2(+2), root-dirs:4(+2)

## Objetivo
Issue #1793: routing-watch rung 1 looks for a write token only in the part of the payload before "tool_response": (when "tool_input": is in that part; otherwise the whole payload, as today), so a Bash whose output alone contains '>' leaves at rung 1 instead of paying the stamp/jq/git path. Same counting verdict as today; Claude Bash calls with '>' only in the output (24.8 % of them) stop costing ~7 ms. Decision: decisiones-ulises/2026-11-23-1325.

## Criterios
- **A1** (pendiente) — Routing-watch tests, bash and zsh: a Bash with '>' only in tool_response leaves at rung 1 (no stamp, no jq/git exec); a Bash with '>' in the command (and also one with '>' in both) is still counted; tee / sed -i in the command still counted; a payload without tool_response or with tool_response before tool_input keeps today's behavior.
  - command: `systemd-run --user --scope -p MemoryMax=8G -p MemorySwapMax=0 -p CPUWeight=20 -p IOWeight=20 -- flock /tmp/navori-heavy.lock bun run --filter navori test -- routing-watch bash-outcome-watch hook-output-contract hook-matcher-wiring audit-gating hook-audit-instrumentation`
  - expected: exit 0, new cases included
- **A2** (pendiente) — Rendered copies match the source and no re-sign.
  - command: `bun run check:render && node scripts/js/rust-hooks-sync.mjs --check && git diff --name-only origin/migration/rust -- crates`
  - expected: exit 0, hooks-sync 0 changes, no crates/ path
- **A3** (pendiente) — Measured saving: interleaved A/B (base vs branch hook) on a Claude Bash with '>' only in the output and on a plain Bash, same harness as docs/research/routing-watch-costo.md.
  - command: `python3 ~/.cache/navori-rust/s1/routing-watch-cost/ab.py`
  - expected: output-only '>' case drops to the plain-Bash cost (~7 ms saved p50); plain and command-write cases unchanged within noise
- **A4** (pendiente) — Full gate.
  - command: `systemd-run --user --scope -p MemoryMax=8G -p MemorySwapMax=0 -p CPUWeight=20 -p IOWeight=20 -- flock /tmp/navori-heavy.lock navori gate full`
  - expected: navori gate full: exit 0

## Fuera de alcance
- #1794 (tree fingerprint of the acceptance lane): out of 0.13
- The node -e reset after a failed Bash
- Any ported hook, crates/, ported.json

## Archivos
- packages/core/core-assets/hooks/routing-watch.sh
- .claude/hooks/routing-watch.sh
- .pi/navori/hooks/routing-watch.sh
- packages/cli/src/lib/__tests__/routing-watch.test.ts

## Decisiones
- (none)
