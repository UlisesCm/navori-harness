#!/usr/bin/env bash
# Usage: s2-ci-delta.sh <run_id> <outdir> <ref_dir>. Waits for a Rust coexistence run, extracts reds, diffs against ref lists.
set -u
export LC_ALL=C
run=$1; D=$2; R=$3; mkdir -p "$D"
gh run watch "$run" --interval 60 >/dev/null 2>&1
gh run view "$run" --json headSha,conclusion,jobs --jq '.headSha, .conclusion, (.jobs[]|"\(.databaseId) \(.name) \(.conclusion)")' > "$D/jobs.txt"
for j in quality oracle post-cutover; do
  id=$(awk -v n="$j" '$2==n{print $1}' "$D/jobs.txt")
  for try in 1 2 3 4 5; do
    gh api --allow-escape-sequences "repos/UlisesCm/navori-harness/actions/jobs/$id/logs" > "$D/$j.log"
    head -c 200 "$D/$j.log" | grep -q '<Error>' || break
    echo "retry $j ($try): $(head -c 120 "$D/$j.log")" >&2; sleep 30
  done
  head -c 200 "$D/$j.log" | grep -q '<Error>' && { echo "ABORT: $j log unavailable" >&2; exit 4; }
done
ext_q(){ grep -a -E 'test .* \.\.\. FAILED' "$1" | sed -E 's/^.*test (.*) \.\.\. FAILED.*$/\1/' | sort -u; }
ext_o(){ grep -a -E '(DIFF|FAIL) [^ ]+' "$1" | sed -E 's/^.*(DIFF|FAIL) ([^ ]+).*$/\2/' | sort -u; }
ext_q "$D/quality.log" > "$D/quality-fail.txt"
ext_q "$D/post-cutover.log" > "$D/post-cutover-fail.txt"
ext_o "$D/oracle.log" > "$D/oracle-ids.txt"
cat "$D/jobs.txt"
for f in quality-fail post-cutover-fail oracle-ids; do
  echo "== $f: pr=$(wc -l <"$D/$f.txt") ref=$(sort -u "$R/$f.txt" | wc -l)"
  echo "  nuevos: $(comm -13 <(sort -u "$R/$f.txt") "$D/$f.txt" | tr '\n' ' ')"
  echo "  quitados: $(comm -23 <(sort -u "$R/$f.txt") "$D/$f.txt" | tr '\n' ' ')"
done
