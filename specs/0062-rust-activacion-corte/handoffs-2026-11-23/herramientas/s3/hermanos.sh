#!/usr/bin/env bash
# Sibling check for one unfinished begin (read-only, metadata only: hook, id prefix, offsets).
# Usage: hermanos.sh <hook> <ISO UTC of the begin, e.g. 2026-11-20T15:54:07.194Z>
# Prints every pi begin within ±500 ms across all shadow journals, whether it completed,
# and the completion offset. A "cancelled by a sibling" needs at least one other hook completed.
set -euo pipefail
D=$HOME/Documentos/dev/personal/navori-rust/.navori/state/rust-shadow
hook=$1
t=$(node -e 'console.log(Date.parse(process.argv[1]))' "$2")
cat "$D"/*.jsonl | jq -r --argjson t "$t" -s '
  (map(select(.kind=="complete")) | map({key:.id, value:.timeMs}) | from_entries) as $done
  | map(select(.kind=="begin" and .engine=="pi" and ((.timeMs - $t) | fabs) <= 500))
  | sort_by(.timeMs)[]
  | "\(.hook)\t\(.id[0:8])\tbegin \((.timeMs - $t) | tostring) ms\t"
    + (if $done[.id] then "complete +\(($done[.id] - $t) | tostring) ms" else "SIN COMPLETE" end)'
last=$(cat "$D"/*.jsonl | jq -s --argjson t "$t" '[.[] | select(.engine=="pi" and .timeMs > $t + 500)] | min_by(.timeMs) | .timeMs - $t')
echo "siguiente fila de pi (cualquier hook): +${last} ms"
echo "hook revisado: $hook"
