#!/usr/bin/env bash
# Hourly read-only R81 check: clock run + rehearsal at 26 Nov 17:16, compact summary.
cd "$HOME/.cache/navori-rust/s3/r81"
stamp=$(date +%Y%m%d-%H%M)
./r81-cierre.sh > "/tmp/s3-vig-reloj.txt" 2>&1; er=$?
f=$(tail -1 /tmp/s3-vig-reloj.txt | sed 's/.*-> //'); mv "$f" "r81-reloj-$stamp.md"
./r81-cierre.sh 2026-11-26T17:16:00-06:00 > "/tmp/s3-vig-ensayo.txt" 2>&1; ee=$?
f=$(tail -1 /tmp/s3-vig-ensayo.txt | sed 's/.*-> //'); mv "$f" "r81-ensayo-$stamp.md"
echo "reloj exit=$er ensayo exit=$ee ($stamp)"
grep -E '^\| [a-z]' "r81-reloj-$stamp.md" | awk -F'|' '{gsub(/ /,"",$2);gsub(/ /,"",$3); printf "%s[%s] calls=%s div=%s nf=%s sf=%s pend=%s canc=%s\n",$2,$3,$5+0,$6+0,$7+0,$8+0,$9+0,$10}'
echo "-- ensayo no verdes:"; grep -E '^\| ' "r81-ensayo-$stamp.md" | grep -vE '\| green \|$|^\| (Hook|Batch|---)' | cut -c1-250
