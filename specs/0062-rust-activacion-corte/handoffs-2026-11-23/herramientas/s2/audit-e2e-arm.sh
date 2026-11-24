#!/usr/bin/env bash
# A10 E2E for rust-audit-arm-native: native `navori audit --arm`, then the real
# session-start-context hook consumes the flag (via the TS --consume-arm) and announces audit-mode.
set -uo pipefail
WT=${WT:-$HOME/Documentos/dev/personal/navori-rust/.claude/worktrees/s2-gate-audit}
BIN=${BIN:-$WT/target/debug/navori-rust}
REAL_TS=${REAL_TS:-$WT/packages/cli/dist/index.js}
NODE_REAL=$(readlink -f "$(command -v node)")
BUN_REAL=$(readlink -f "$(command -v bun)")
T=$(mktemp -d /tmp/s2-e2e-arm.XXXXXX)
mkdir -p "$T/home" "$T/bin" "$T/tmp"
ln -s "$NODE_REAL" "$T/bin/node"; ln -s "$BUN_REAL" "$T/bin/bun"
ln -s "$BIN" "$T/bin/navori-rust"; ln -s "$BIN" "$T/bin/navori"
printf '[user]\n\tname = e2e\n\temail = e2e@example.invalid\n[init]\n\tdefaultBranch = main\n' > "$T/gitconfig"
export HOME="$T/home" TMPDIR="$T/tmp" GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1
export PATH="$T/bin:/usr/bin:/bin"
unset NAVORI_HOOK_IMPL NAVORI_AUDITS_ROOT
AUD="$HOME/.navori/audits"
fail=0; ok() { echo "ok: $1"; }; bad() { echo "FAIL: $1"; fail=1; }

# Fake TS: records any call and fails, so a delegation cannot go unnoticed.
cat > "$T/fake-ts.js" <<JS
require("fs").appendFileSync("$T/ts-called", process.argv.slice(2).join(" ") + "\n"); process.exit(97);
JS

R="$T/e2erepo"
mkdir -p "$R/.claude/hooks" && git -C "$R" init -q
cp "$WT/.claude/hooks/session-start-context.sh" "$R/.claude/hooks/"
printf '{"name":"e2erepo","version":"1.0.0","harnessVersion":"0.12.2","engines":["claude"],"preset":"custom","language":"en","branchBase":"main","gitignoreHarness":"off","commits":"conventional","qualityGate":{"fast":"true","full":"true"}}\n' > "$R/navori.config.json"
git -C "$R" add -A && git -C "$R" commit -qm init

echo "== 1. native --arm (TS replaced by a fake that fails if called)"
out=$(cd "$R" && NAVORI_TS_CLI="$T/fake-ts.js" navori audit --arm 2>&1); rc=$?
echo "rc=$rc out=$out"
[ "$rc" = 0 ] && [ ! -e "$T/ts-called" ] && ok "native, no delegation" || bad "arm delegated or failed"
ARMED="$AUD/e2erepo/.armed"
[ -f "$ARMED" ] && { echo "armed: $(cat "$ARMED") mode=$(stat -c %a "$ARMED")"; ok ".armed written"; } || bad ".armed missing"

echo "== 2. real session-start-context hook, SessionStart payload"
payload=$(printf '{"session_id":"e2e-sess-1","hook_event_name":"SessionStart","source":"startup","cwd":"%s"}' "$R")
hout=$(cd "$R" && printf '%s' "$payload" | NAVORI_TS_CLI="$REAL_TS" CLAUDE_PROJECT_DIR="$R" bash .claude/hooks/session-start-context.sh 2>"$T/hook-err"); hrc=$?
echo "hook rc=$hrc"; echo "context: $(printf '%s' "$hout" | grep -o 'audit-mode ACTIVE[^"]*' | head -1)"
printf '%s' "$hout" | grep -q 'audit-mode ACTIVE' && ok "context says audit-mode ACTIVE" || { bad "no audit-mode ACTIVE"; sed 's/^/stderr: /' "$T/hook-err"; }
[ ! -e "$ARMED" ] && ok ".armed consumed" || bad ".armed still present"
echo "tree after session:"; (cd "$AUD" && find . | sort | sed 's/^/  /')

echo "== 3. --arm then --disarm leaves the audit tree empty (fresh audits root)"
export NAVORI_AUDITS_ROOT="$T/audits2"
(cd "$R" && NAVORI_TS_CLI="$T/fake-ts.js" navori audit --arm >/dev/null 2>&1; echo "arm rc=$?")
dout=$(cd "$R" && NAVORI_TS_CLI="$T/fake-ts.js" navori audit --disarm 2>&1); drc=$?
echo "disarm rc=$drc out=$dout"
left=$(find "$NAVORI_AUDITS_ROOT" -type f 2>/dev/null | wc -l)
[ "$drc" = 0 ] && [ "$left" = 0 ] && [ ! -e "$T/ts-called" ] && ok "no files left, native" || { bad "files left=$left"; find "$NAVORI_AUDITS_ROOT" | sed 's/^/  /'; }
echo "RESULT: $([ $fail = 0 ] && echo PASS || echo FAIL) ($T)"
exit $fail
