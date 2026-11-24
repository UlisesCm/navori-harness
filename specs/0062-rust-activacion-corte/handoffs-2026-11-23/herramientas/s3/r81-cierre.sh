#!/usr/bin/env bash
# R81 close table, per hook and engine (first row + 7 d). Read-only on the shadow checkout.
# Usage: r81-cierre.sh [ISO instant replacing the clock]. Run on 26 Nov after the last row closes.
# causes.json mirrors the causes recorded in the engram note coordinacion/rust-0.13/sombra-ventana.
set -euo pipefail
SHADOW=$HOME/Documentos/dev/personal/navori-rust
TOOL=$SHADOW/.claude/worktrees/s3-r81-close
DIR=$HOME/.cache/navori-rust/s3/r81
OUT=$DIR/r81-cierre-$(date +%Y%m%d-%H%M).md
NOW_ARGS=()
if [ $# -gt 0 ]; then NOW_ARGS=(--now "$1"); fi
cd "$TOOL"
set +e
node scripts/js/hook-shadow-report.mjs --root "$SHADOW" --window 7 --close-per-row "${NOW_ARGS[@]}" \
  --markdown --sibling-cancel --causes "$DIR/causes.json" --batches "$DIR/batches.json" | tee "$OUT"
status=${PIPESTATUS[0]}
echo "exit=$status (0 green, 1 red, 3 amber, 2 error) -> $OUT"
exit "$status"
