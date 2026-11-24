#!/usr/bin/env bash
# Hourly R81 watch for N rounds: report, compact log line, regenerate and PATCH the daily summary.
# Stops early (exit 4) on any divergence, failure, or pending count above the known one.
set -u
cd "$HOME/.cache/navori-rust/s3/r81"
rounds=${1:-3}
known_pending=5
known_div=1
log=vigila-loop.log
for r in $(seq 1 "$rounds"); do
  sleep 3600
  ./vigila.sh > /tmp/s3-vig.txt 2>&1
  stamp=$(head -1 /tmp/s3-vig.txt | sed -E 's/.*\(([0-9-]+)\).*/\1/')
  reloj="r81-reloj-$stamp.md"; ensayo="r81-ensayo-$stamp.md"
  read -r div nf sf pend <<<"$(awk -F'|' '/^\| [a-z]/ {d+=$6; n+=$7; s+=$8; p+=$9} END{print d+0, n+0, s+0, p+0}' "$reloj")"
  pi=$(grep -E '\[pi\]' /tmp/s3-vig.txt | sed -E 's/ div=.*canc=/ canc=/' | tr '\n' ';')
  verdict=$(head -1 "$ensayo")
  echo "$stamp | div=$div nf=$nf sf=$sf pend=$pend | ensayo: $verdict | $pi" >> "$log"
  python3 resumen-gen.py "$ensayo" "$(date '+%d nov %H:%M') CST" resumen-notas.md > resumen-diario-20261120.md \
    && gh api -X PATCH repos/UlisesCm/navori-harness/issues/comments/7043932176 -F body=@resumen-diario-20261120.md --jq .updated_at >> "$log" 2>&1
  if [ "$div" -gt "$known_div" ] || [ "$nf" -gt 0 ] || [ "$sf" -gt 0 ] || [ "$pend" -gt "$known_pending" ]; then
    echo "ANOMALY at $stamp" >> "$log"; exit 4
  fi
done
