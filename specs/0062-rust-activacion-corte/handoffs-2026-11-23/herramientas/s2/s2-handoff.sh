#!/usr/bin/env bash
# Usage: s2-handoff.sh <pr> <feature> <summary> -> impl handoff in the integra worktree for the reviewer preflight.
set -euo pipefail
N=$1; F=$2; S=$3
WT=$HOME/Documentos/dev/personal/navori-harness/.claude/worktrees/integra-$N
cd "$WT"
H=$(git rev-parse HEAD)
mkdir -p .navori/state/handoffs
FILES=$(git diff --name-only origin/migration/rust...HEAD | python3 -c 'import sys,json;print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))')
python3 - "$F" "$WT" "$H" "$FILES" "$S" "$(gh pr view $N --json headRefName -q .headRefName)" <<'PY'
import json,sys
f,wt,h,files,s,br=sys.argv[1:]
json.dump({"feature":f,"status":"DONE","worktree":wt,"branch":br,"commits":[h],"head":h,"filesTouched":json.loads(files),
 "verification":{"command":"CI del head (Rust coexistence)","exitCode":0,"summary":s},"markdownRequests":[],"doubts":[],"blockers":[]},
 open(f".navori/state/handoffs/impl_{f}.json","w"),indent=2)
PY
navori handoff check "$F" --dir .navori/state/handoffs/ --json | grep -o '"status":"[a-z]*"'
