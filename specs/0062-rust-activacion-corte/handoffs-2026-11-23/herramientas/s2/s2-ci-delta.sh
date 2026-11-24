#!/usr/bin/env bash
# Usage: s2-ci-delta.sh <run_id> <outdir> <ref_dir>   waits for a Rust coexistence run, extracts reds, diffs against ref lists.
#        s2-ci-delta.sh --check <dir>                 re-validates logs already extracted in <dir> (needs jobs.txt).
# A log counts only if it is a real job log: runner header, end-of-job marker and the job's own marker
# (cargo "test result:" / "rust-oracle: N cases, M differences"). A ServerBusy XML body, an empty or
# truncated log is retried; if it never validates the script exits 3 and prints no delta.
set -u
export LC_ALL=C
REPO=repos/UlisesCm/navori-harness
MAX_TRIES=${S2_DELTA_TRIES:-6}

ext_q(){ grep -a -E 'test .* \.\.\. FAILED' "$1" | sed -E 's/^.*test (.*) \.\.\. FAILED.*$/\1/' | sort -u; }
ext_o(){ grep -a -E 'DIFF [^ ]+' "$1" | sed -E 's/^.*DIFF ([^ ]+).*$/\1/' | sort -u; }

# validate <job> <log> <conclusion>: prints the reason and returns 1 when the log is not trustworthy.
validate(){
  local job=$1 log=$2 concl=$3 n
  [ -s "$log" ] || { echo "empty log"; return 1; }
  if head -c 200 "$log" | grep -aqiE '<\?xml|<Error>|ServerBusy'; then echo "XML error body: $(head -c 160 "$log" | tr -d '\n')"; return 1; fi
  grep -aqiE 'ServerBusy|<Code>[A-Za-z]+</Code>' "$log" && { echo "contains a storage error"; return 1; }
  head -c 300 "$log" | grep -aq 'Current runner version' || { echo "no runner header"; return 1; }
  grep -aqE 'Process completed with exit code|Cleaning up orphan processes|Post job cleanup' "$log" || { echo "no end-of-job marker (truncated?)"; return 1; }
  case $job in
    quality|post-cutover)
      grep -aq 'test result:' "$log" || { echo "no cargo 'test result:' line"; return 1; }
      n=$(ext_q "$log" | wc -l) ;;
    oracle)
      grep -aqE 'rust-oracle: [0-9]+ cases, [0-9]+ differences' "$log" || { echo "no 'rust-oracle: N cases, M differences' line"; return 1; }
      local diffs; diffs=$(grep -aoE 'rust-oracle: [0-9]+ cases, [0-9]+ differences' "$log" | tail -1 | sed -E 's/.*cases, ([0-9]+) differences/\1/')
      n=$(ext_o "$log" | wc -l)
      if [ "$diffs" -gt 0 ] && [ "$n" -eq 0 ]; then echo "summary says $diffs differences but no DIFF ids extracted"; return 1; fi
      if [ "$diffs" -eq 0 ] && [ "$n" -gt 0 ]; then echo "summary says 0 differences but $n DIFF ids extracted"; return 1; fi ;;
  esac
  if [ "$concl" = failure ] && [ "$n" -eq 0 ]; then echo "job concluded failure but 0 reds extracted"; return 1; fi
  if [ "$concl" = success ] && [ "$n" -gt 0 ]; then echo "job concluded success but $n reds extracted"; return 1; fi
  return 0
}

check_dir(){
  local D=$1 bad=0 j concl why
  for j in quality post-cutover oracle; do
    concl=$(awk -v n="$j" '$2==n{print $3}' "$D/jobs.txt")
    if why=$(validate "$j" "$D/$j.log" "$concl"); then echo "OK      $D $j ($concl)"; else echo "INVALID $D $j ($concl): $why"; bad=1; fi
  done
  return $bad
}

if [ "${1:-}" = --check ]; then check_dir "$2"; exit $?; fi

run=$1; D=$2; R=$3; mkdir -p "$D"
gh run watch "$run" --interval 60 >/dev/null 2>&1
gh run view "$run" --json headSha,conclusion,jobs --jq '.headSha, .conclusion, (.jobs[]|"\(.databaseId) \(.name) \(.conclusion)")' > "$D/jobs.txt"
for j in quality oracle post-cutover; do
  id=$(awk -v n="$j" '$2==n{print $1}' "$D/jobs.txt")
  concl=$(awk -v n="$j" '$2==n{print $3}' "$D/jobs.txt")
  ok=0
  for t in $(seq 1 "$MAX_TRIES"); do
    gh api --allow-escape-sequences "$REPO/actions/jobs/$id/logs" > "$D/$j.log" 2>"$D/$j.err"
    if why=$(validate "$j" "$D/$j.log" "$concl"); then ok=1; break; fi
    echo "retry $t/$MAX_TRIES $j (job $id): $why" >&2
    sleep $((30 * t))
  done
  [ "$ok" = 1 ] || { echo "ERROR: $j log (job $id) never validated: $why; no delta reported" | tee "$D/INVALID"; exit 3; }
done
rm -f "$D/INVALID"
ext_q "$D/quality.log" > "$D/quality-fail.txt"
ext_q "$D/post-cutover.log" > "$D/post-cutover-fail.txt"
ext_o "$D/oracle.log" > "$D/oracle-ids.txt"
check_dir "$R" >/dev/null 2>&1 || echo "WARNING: reference $R does not validate; run --check $R"
cat "$D/jobs.txt"
for f in quality-fail post-cutover-fail oracle-ids; do
  echo "== $f: pr=$(wc -l <"$D/$f.txt") ref=$(sort -u "$R/$f.txt" | wc -l)"
  echo "  nuevos: $(comm -13 <(sort -u "$R/$f.txt") "$D/$f.txt" | tr '\n' ' ')"
  echo "  quitados: $(comm -23 <(sort -u "$R/$f.txt") "$D/$f.txt" | tr '\n' ' ')"
done
