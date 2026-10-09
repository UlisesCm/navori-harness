# navori:managed start id="model-advisor-base" hash="cc157268" version="0.11.3" source="@navori/core"
#!/usr/bin/env bash
#
# Advisory-only main-session model recommendation. The hook reads only payload
# fields recorded in host-contracts.ts; `/model` remains the user's native,
# explicit switch path. It never writes navori.config.json or agent profiles.
set -euo pipefail

payload=$(cat 2>/dev/null) || payload=""
mode=${1:-}

# The advisor has no effect on permissions or control flow, but its execution
# must remain observable while audit mode is active. Its three Claude entry
# points share one script, so derive the host phase from the explicit mode
# rather than guessing from payload fields.
case "$mode" in
  claude-session-start|codex-session-start) navori_audit_phase="SessionStart" ;;
  claude-post-model-switch) navori_audit_phase="PostModelSwitch" ;;
  claude-stop) navori_audit_phase="Stop" ;;
  *) navori_audit_phase="unknown" ;;
esac
navori_audit_name="model-advisor"
navori_audit_begin() { :; }
navori_audit_log() { :; }
# Shared audit repository resolver (#764) — inlined into every audit hook at
# render time. A nested agent worktree lives below the repository's
# `.claude/worktrees/` directory, but its basename is an ephemeral agent id.
#
# navori_audit_repo_from_cwd <cwd> — prints the stable parent repo name.
# This only uses shell builtins before the existing `basename` call: audit hooks
# run often, so discovering the Git common directory would add an avoidable fork
# per invocation.
navori_audit_repo_from_cwd() {
  navori_audit_repo_cwd=$1
  case "$navori_audit_repo_cwd" in
    */.claude/worktrees | */.claude/worktrees/*)
      navori_audit_repo_cwd=${navori_audit_repo_cwd%%/.claude/worktrees*}
      ;;
  esac
  basename "$navori_audit_repo_cwd" 2>/dev/null
}
# Shared advisory metadata recorder. The CLI is the single private-FD writer.
# No shell redirects, human content, or fallback writes are permitted here.
# Missing CLI or failed validation leaves an observation gap, never a hook failure.
# zsh replaces $0 with the function name; preserve the enclosing script identity.
navori_audit_script=$0
navori_audit_begin() {
  navori_audit_on=0
  navori_audit_root=${NAVORI_AUDITS_ROOT:-${HOME:-}/.navori/audits}
  [ -n "${HOME:-}${NAVORI_AUDITS_ROOT:-}" ] || return 0
  [ -d "$navori_audit_root" ] || return 0
  navori_audit_on=1
  navori_audit_t0=$(navori_audit_now)
}

navori_audit_now() {
  if [ -n "${EPOCHREALTIME:-}" ]; then
    # `1756... .123456` → milliseconds, with pure parameter expansion.
    navori_audit_epoch=${EPOCHREALTIME/,/.}
    printf '%s%s' "${navori_audit_epoch%%.*}" "$(printf '%.3s' "${navori_audit_epoch#*.}")"
    return 0
  fi
  perl -MTime::HiRes=time -e 'printf "%.0f", time*1000' 2>/dev/null \
    || printf '%s' $(( $(date +%s 2>/dev/null || echo 0) * 1000 ))
}

# Resolve one exact marker before invoking the metadata writer. Startup may
# offer a repo-scoped arm candidate; the CLI authoritatively validates private
# modes, ownership and header identity before either append or spool creation.
navori_audit_record_metadata() {
  [ -n "${payload:-}" ] || return 0
  navori_audit_root=${NAVORI_AUDITS_ROOT:-${HOME:-}/.navori/audits}
  [ -n "${HOME:-}${NAVORI_AUDITS_ROOT:-}" ] || return 0
  [ -d "$navori_audit_root" ] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  navori_audit_fields=$(printf '%s' "$payload" | jq -er '
    def id: type == "string" and length > 0 and length <= 256 and test("^[A-Za-z0-9_-]+$");
    select(.session_id | id) |
    [.session_id, (if (.cwd | type) == "string" then .cwd else "" end),
     ([.agent_id, .subagent_id] | map(select(id)) | first) // "orchestrator", "."] | .[]' 2>/dev/null) || return 0
  navori_audit_session=${navori_audit_fields%%
*}
  navori_audit_rest=${navori_audit_fields#*
}
  navori_audit_cwd=${navori_audit_rest%%
*}
  navori_audit_rest=${navori_audit_rest#*
}
  navori_audit_agent=${navori_audit_rest%%
*}
  [ -n "$navori_audit_cwd" ] || navori_audit_cwd=$PWD
  navori_audit_repo=$(navori_audit_repo_from_cwd "$navori_audit_cwd") || return 0
  case "$navori_audit_repo" in "" | . | .. | *[!A-Za-z0-9_.-]*) return 0 ;; esac
  navori_audit_file=$navori_audit_root/$navori_audit_repo/session-$navori_audit_session.log
  if [ ! -f "$navori_audit_file" ] || [ -L "$navori_audit_file" ]; then
    [ "${navori_audit_phase:-}" = SessionStart ] || return 0
    navori_audit_arm=$navori_audit_root/$navori_audit_repo/.armed
    [ -f "$navori_audit_arm" ] && [ ! -L "$navori_audit_arm" ] || return 0
  fi
  command -v navori >/dev/null 2>&1 || return 0
  case "${nv_engine:-}" in
    claude | codex) navori_audit_host=$nv_engine ;;
    *) case "$navori_audit_script" in *".codex/hooks/"* | *".codex/scripts/"*) navori_audit_host=codex ;; *) navori_audit_host=claude ;; esac ;;
  esac
  # The writer assigns eventId/wireVersion before first persistence. Replay
  # keeps those identifiers; this transport never generates replacement IDs.
  printf '%s' "$1" | navori audit --record-metadata --host "$navori_audit_host" \
    --root-session "$navori_audit_session" --repo "$navori_audit_repo" \
    --root "$navori_audit_root" >/dev/null 2>&1 || :
  return 0
}

# Only closed categories and bounded technical identifiers cross this bridge.
# Args: verdict, reason, kind. `reason` is recorded only when it is one of the
# allowlisted codes below (mirrored by HOOK_REASON_CODES in lib/audit/model.ts,
# pinned by a drift test); any other non-empty text is stored as "unspecified".
# `kind` defaults from the verdict (block -> hard, ask -> ask); `deny` stays
# explicit because the confirm hooks use it as deny-as-confirmation on Codex.
navori_audit_log() {
  [ "${navori_audit_on:-0}" = 1 ] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  if [ "${NAVORI_AUDIT_SKIP_NOOPS:-0}" = 1 ]; then
    case "${1:-}" in skip | noop) return 0 ;; esac
  fi
  navori_audit_end=$(navori_audit_now)
  [ "$navori_audit_end" -ge 0 ] 2>/dev/null || navori_audit_end=0
  navori_audit_ms=$(( navori_audit_end - ${navori_audit_t0:-$navori_audit_end} ))
  [ "$navori_audit_ms" -ge 0 ] 2>/dev/null || navori_audit_ms=0
  navori_audit_metadata=$(printf '%s' "${payload:-}" | jq -c \
    --arg name "${navori_audit_name:-unknown}" --arg phase "${navori_audit_phase:-unknown}" \
    --arg verdict "${1:-unknown}" --arg reason "${2:-}" \
    --arg tool "${navori_audit_tool:-}" --arg source "${navori_audit_source:-core}" \
    --arg kind "${3:-}" --argjson ms "$navori_audit_ms" --argjson tsMs "$navori_audit_end" '
    def id: type == "string" and length > 0 and length <= 256 and test("^[A-Za-z0-9_-]+$");
    def technical_label: if length <= 256 and test("^[A-Za-z0-9_.:-]+$") then . else "unknown" end;
    {event:"hook",name:($name|technical_label),source:($source|technical_label),ms:$ms,tsMs:$tsMs,
     phase:(if (["PreToolUse","PostToolUse","SessionStart","SessionEnd","Stop","SubagentStart","SubagentStop","UserPromptSubmit","PreCompact"]|index($phase)) != null then $phase else "unknown" end),
     verdict:(if (["allow","ask","block","deny","skip","noop","clean","dirty","inject","repeat","partial","compact-advice","gate-started","gate-killed"]|index($verdict)) != null then $verdict else "unknown" end),
     agentId:(([.agent_id,.subagent_id]|map(select(id))|first)//"orchestrator")}
     + (if (.tool_use_id|id) then {toolUseId:.tool_use_id} else {} end)
     + (if (["Bash","Edit","Read","Write","Agent","Task","NotebookEdit"]|index($tool)) != null then {tool:$tool} else {} end)
     + (if $reason == "" then {}
        elif (["oversize","no-verify","force-push-base","rm-root","rm-var","no-preserve-root","fork-bomb","block-device","managed-rewrite","binary-missing","plan-denied","subcommand-unavailable","native-hook"]|index($reason)) != null then {reason:$reason}
        else {reason:"unspecified"} end)
     + (($kind | if . == "" then (if $verdict == "block" then "hard" elif $verdict == "ask" then "ask" else "" end) else . end) as $k
        | if (["hard","ask","advisory"]|index($k)) != null then {kind:$k} else {} end)' 2>/dev/null) || return 0
  navori_audit_record_metadata "$navori_audit_metadata"
  return 0
}
navori_audit_begin
navori_audit_on_exit() {
  navori_audit_log "skip" || true
  return 0
}
trap navori_audit_on_exit EXIT

# `Stop` fires for the main agent, but a session started with `--agent` carries
# `agent_type`, and any payload with `agent_id` belongs to a subagent: neither
# can advise, so their `node` spawn is pure waste. Discard it here with a
# fork-free substring test. It sits after the trap so audit mode still records
# the firing.
case "$payload" in *'"agent_id"'* | *'"agent_type"'*) exit 0 ;; esac

# Second layer of the same guard, for the main-thread `Stop` event (spec 0039
# R27: it used to ride `PreToolUse(.*)`, a spawn per tool call; now it runs once
# per finished turn). The only decision input that can change mid-session is the
# effort, and Claude hands it to the shell for free in `$CLAUDE_EFFORT`; there
# is no `$CLAUDE_MODEL`, so the model keeps coming from the session state that
# `node` writes once per lifecycle event. That asymmetry is what lets the shell
# answer alone: the same `node` run leaves a sentinel naming what is already
# settled, and a non-candidate tuple stops paying a spawn per turn while
# `medium` -> `high` stays detectable.
# See `claude-effort-env` and `claude-no-model-env` in host-contracts.ts.
if [ "$mode" = "claude-stop" ]; then
  # Parameter expansion only: no fork, and no dependency on optional `jq`.
  # A payload without the key leaves the path empty and falls through to `node`.
  navori_scratchpad=""
  case "$payload" in
    *'"scratchpad_dir":"'*)
      navori_scratchpad=${payload#*'"scratchpad_dir":"'}
      navori_scratchpad=${navori_scratchpad%%'"'*}
      ;;
  esac
  if [ -n "$navori_scratchpad" ]; then
    # Settled for the rest of the session: already advised, or a model that no
    # effort can turn into a candidate.
    if [ -f "$navori_scratchpad/navori-model-advisor.skip" ]; then
      exit 0
    fi
    # Opus: only a high tier qualifies. An UNDEFINED `$CLAUDE_EFFORT` — the host
    # omits it when the model has no effort parameter — must fall through to
    # `node`, never exit, so the guard stays fail-open.
    if [ -f "$navori_scratchpad/navori-model-advisor.effort-gated" ]; then
      case "${CLAUDE_EFFORT:-}" in
        "" | high | xhigh | max) ;;
        *) exit 0 ;;
      esac
    fi
  fi
fi

# Node is already required by Claude Code and by the generated TypeScript CLI.
# Keep all untrusted payload parsing here rather than interpolating JSON into shell.
PAYLOAD="$payload" MODE="$mode" node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

let payload;
try {
  payload = JSON.parse(process.env.PAYLOAD || "{}");
} catch {
  process.exit(0);
}

if (payload.agent_id || payload.agent_type) process.exit(0);

const mode = process.env.MODE;
const notice = (message) => process.stdout.write(`${JSON.stringify({ systemMessage: message })}\n`);

const claudeMessage = (model) => `### Modelo recomendado disponible
Estás usando \`${model}\`. Para la mayoría de features, bugs y tickets, \`opus/medium\` es suficiente para desarrollar una solución sólida.

Navori no depende sólo del modelo principal: enruta el trabajo al agente adecuado, separa implementación y revisión, y valida la calidad antes de cerrar. Usar \`medium\` en el trabajo cotidiano mejora la eficiencia de tokens y reserva mayor effort para problemas excepcionalmente complejos o críticos.

Para cambiarlo, abre el selector nativo con \`/model\` y elige \`opus/medium\`. `;

if (mode === "codex-session-start") {
  if (payload.model !== "gpt-6-astra") process.exit(0);
  notice(`### Modelo recomendado disponible
Estás usando \`gpt-6-astra\`. Para la mayoría de features, bugs y tickets, \`gpt-5.6-sol/medium\` ofrece capacidad suficiente para una solución sólida.

Navori coordina agentes especializados, separa implementación y revisión, y valida la calidad antes de cerrar. Elegir \`medium\` para el trabajo cotidiano mejora la eficiencia de tokens y deja effort alto disponible para los problemas que realmente lo necesitan.

Para cambiarlo, abre el selector nativo con \`/model\` y elige \`gpt-5.6-sol/medium\`.`);
  process.exit(0);
}

const scratchpadDir = typeof payload.scratchpad_dir === "string" ? payload.scratchpad_dir : "";
if (!scratchpadDir) process.exit(0);
const statePath = path.join(scratchpadDir, "navori-model-advisor.json");
const readState = () => {
  try {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return typeof state.model === "string" && typeof state.notified === "boolean" ? state : null;
  } catch {
    return null;
  }
};
const writeState = (state) => {
  fs.mkdirSync(scratchpadDir, { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state));
};

// Sentinels are the shell half of the guard above: empty marker files whose
// NAME carries the verdict, so `[ -f ]` answers without parsing anything.
const SKIP = "navori-model-advisor.skip";
const GATED = "navori-model-advisor.effort-gated";
/**
 * Leaves at most one sentinel, removing the other, so a `/model` switch cannot
 * leave the shell reading a verdict from the previous model. `null` clears both
 * (Fable, which qualifies at any effort and therefore has nothing to skip).
 */
const writeSentinel = (name) => {
  for (const other of [SKIP, GATED]) {
    if (other !== name) fs.rmSync(path.join(scratchpadDir, other), { force: true });
  }
  if (name) fs.writeFileSync(path.join(scratchpadDir, name), "");
};
/** The verdict the shell can apply on its own for this model. */
const sentinelFor = (model, notified) => {
  if (notified) return SKIP;
  if (model === "claude-fable-5") return null;
  return /opus/i.test(model) ? GATED : SKIP;
};

if (mode === "claude-session-start" || mode === "claude-post-model-switch") {
  const model = mode === "claude-session-start" ? payload.model : payload.to_model;
  if (typeof model !== "string" || !model) process.exit(0);
  const notified = mode === "claude-post-model-switch" ? readState()?.notified === true : false;
  writeState({ model, notified });
  writeSentinel(sentinelFor(model, notified));
  process.exit(0);
}

if (mode !== "claude-stop") process.exit(0);
const state = readState();
if (!state || state.notified) process.exit(0);
// `Stop` carries `effort.level` when the model has an effort parameter; the
// host exports the same level as `$CLAUDE_EFFORT`, which covers a payload
// without the field.
const envEffort = process.env.CLAUDE_EFFORT || null;
const effort =
  payload.effort && typeof payload.effort.level === "string" ? payload.effort.level : envEffort;
const isFable = state.model === "claude-fable-5";
const isHighOpus = /opus/i.test(state.model) && ["high", "xhigh", "max"].includes(effort);
if (!isFable && !isHighOpus) process.exit(0);
writeState({ ...state, notified: true });
writeSentinel(SKIP);
notice(claudeMessage(isFable ? state.model : `${state.model}/${effort}`));
NODE
# navori:managed end id="model-advisor-base"
