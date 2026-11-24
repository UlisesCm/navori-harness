#!/usr/bin/env bash
# Usage: s2-wait-pr.sh <pr> <head-prefix> <ref-sha>: waits for all runs of the head, then prints coexistence delta and non-pass checks.
set -u
N=$1; H=$2; REF=$3
cd $HOME/Documentos/dev/personal/navori-harness
BR=$(gh pr view "$N" --json headRefName -q .headRefName)
for i in $(seq 1 90); do
  P=$(gh run list --branch "$BR" --limit 10 --json headSha,status --jq "[.[]|select(.headSha|startswith(\"$H\"))|select(.status!=\"completed\")]|length")
  C=$(gh run list --branch "$BR" --limit 10 --json headSha --jq "[.[]|select(.headSha|startswith(\"$H\"))]|length")
  [ "$C" -ge 2 ] && [ "$P" = 0 ] && break
  sleep 60
done
gh run list --branch "$BR" --limit 10 --json name,headSha,conclusion,databaseId --jq ".[]|select(.headSha|startswith(\"$H\"))|\"\(.databaseId) \(.name) \(.conclusion)\""
R=$(gh run list --branch "$BR" --limit 10 --json name,headSha,databaseId --jq ".[]|select(.name==\"Rust coexistence\" and (.headSha|startswith(\"$H\")))|.databaseId" | head -1)
mkdir -p ~/.cache/s2-integra/$N
bash ~/.cache/s2-ci-delta.sh "$R" ~/.cache/s2-integra/$N/$H ~/.cache/navori-rust/ci/$REF | tail -9
echo "coexistence-run=$R"
gh pr checks "$N" 2>&1 | awk -F'\t' '{print $2"\t"$1}' | grep -v '^pass'
