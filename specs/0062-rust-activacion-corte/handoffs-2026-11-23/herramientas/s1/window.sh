#!/usr/bin/env bash
# #1772 pre-install verification (S1, window 23 nov 17:00-19:00). Run ONLY after Ulises' go.
# Usage: bash window.sh <step>   steps: replay | fuzz-guard | r17 | fuzz-inert
set -u
OUT=$HOME/.cache/navori-rust/s1/v1772
WTS=$HOME/Documentos/dev/personal/navori-rust/.claude/worktrees
declare -A WT=([tip]=$WTS/s1-inv-23 [g1800]=$WTS/s1-guard-git)
declare -A BIN=([tip]=$HOME/.cache/navori-rust/target-s1-inv23/release/navori-rust [g1800]=$HOME/.cache/navori-rust/target-s1-guardgit/release/navori-rust)
export LOCPATH=$HOME/.cache/navori-rust/s1/locale
heavy() { systemd-run --user --scope -q -p MemoryMax=8G -p MemorySwapMax=0 -p CPUWeight=20 -p IOWeight=20 -- flock /tmp/navori-heavy.lock "$@"; }
stamp() { printf '%s %s load=%s head=%s\n' "$(date +%T)" "$1" "$(cut -d' ' -f1-3 /proc/loadavg)" "$(git -C "${WT[$2]}" rev-parse --short HEAD)"; }
step=${1:?step}
for t in tip g1800; do
  cd "${WT[$t]}" || exit 1
  log=$OUT/$step-$t.log
  stamp "$step start" "$t" | tee -a "$OUT/summary.txt"
  case "$step" in
    replay) NAVORI_RUST_BIN=${BIN[$t]} heavy node scripts/js/hook-verdict-replay.mjs --impl rust --registered > "$log" 2>&1 ;;
    fuzz-guard) NAVORI_RUST_BIN=${BIN[$t]} heavy node scripts/js/hook-fuzz.mjs --hook guard-destructive.sh --seed 1 --cases 100000 --jobs 8 --priority normal --cache off > "$log" 2>&1 ;;
    r17)
      : > "$log"
      for h in guard-destructive.sh subagent-no-background.sh pii-egress-guard.sh; do
        NAVORI_RUST_BIN=${BIN[$t]} heavy node scripts/js/bench-hooks.mjs --impl rust --report-only --runs 5 --hook "$h" >> "$log" 2>&1
        echo "rc[$h]=$?" >> "$log"
      done ;;
    fuzz-inert)
      for h in subagent-no-background.sh pii-egress-guard.sh; do
        NAVORI_RUST_BIN=${BIN[$t]} heavy node scripts/js/hook-fuzz.mjs --hook "$h" --seed 1 --cases 100000 --jobs 8 --priority normal --cache off >> "$log" 2>&1
        echo "rc[$h]=$?" >> "$log"
      done ;;
  esac
  rc=$?
  stamp "$step end rc=$rc" "$t" | tee -a "$OUT/summary.txt"
  tail -3 "$log" | tee -a "$OUT/summary.txt"
done
