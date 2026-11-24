#!/usr/bin/env bash
# Read-only monitor: warns when something builds or tests inside the shadow checkout.
# A build there can run the rendered hooks of the checkout with navori-rust in PATH and write
# rows into the live R81 journal (21 nov: 33 rows from crates/navori-hooks/tests/pii_egress_guard.rs).
# Every 10 minutes it compares the newest mtime under <shadow>/target with the baseline taken at
# start; a newer one is logged once per change. It never deletes or touches anything.
set -u
SHADOW=$HOME/Documentos/dev/personal/navori-rust
LOG="$HOME/.cache/navori-rust/s3/r81/target-watch.log"
newest() {
  if [ -d "$SHADOW/target" ]; then
    find "$SHADOW/target" -maxdepth 3 -printf '%T@\n' 2>/dev/null | sort -n | tail -1 | cut -d. -f1
  else
    echo 0
  fi
}
base=$(newest)
echo "$(date '+%F %T') start: baseline newest mtime under target/ = $base ($(date -d "@$base" '+%F %T' 2>/dev/null))" >> "$LOG"
while true; do
  sleep 600
  now=$(newest)
  if [ "$now" -gt "$base" ]; then
    echo "$(date '+%F %T') ALERT: new build activity in $SHADOW/target at $(date -d "@$now" '+%F %T') (baseline $base); check who built in the shadow checkout" >> "$LOG"
    base=$now
  fi
done
