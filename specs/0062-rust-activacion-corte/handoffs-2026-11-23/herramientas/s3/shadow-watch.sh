#!/usr/bin/env bash
# Periodic counts of the rust-shadow journals in the persistent checkout. Counts and flag names only, never content.
R=$HOME/Documentos/dev/personal/navori-rust
D=$R/.navori/state/rust-shadow
while :; do
  ts=$(date -Is)
  for f in "$D"/*.jsonl; do
    [ -f "$f" ] || continue
    h=$(basename "$f" .jsonl)
    jq -r --arg ts "$ts" --arg h "$h" -s '
      def div(c): (c.shellFailed) or ((c.nativeUnobserved!=true) and (c.nativeFailed or c.codeDiffers or c.stdoutDiffers or c.stderrDiffers));
      [.[]|select(.kind=="complete")] as $c
      | ($c|group_by(.engine)|map("\(.[0].engine):complete=\(length),div=\(map(select(div(.comparison)))|length),unobs=\(map(select(.comparison.nativeUnobserved==true))|length),natFail=\(map(select(.comparison.nativeFailed))|length),shFail=\(map(select(.comparison.shellFailed))|length)")|join(" ")) as $e
      | "\($ts) \($h) lines=\(length) begin=\(map(select(.kind=="begin"))|length) impls=\(map(.implementation)|unique|length) \($e)"' "$f" 2>/dev/null || echo "$ts $h unreadable"
  done
  sleep 600
done
