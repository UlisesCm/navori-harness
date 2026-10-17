#!/usr/bin/env bash
#
# Startup/lifecycle modes advise the main session; `/model` remains the user's
# explicit switch path. The fixed Codex PreToolUse mode rewrites future child
# arguments or denies recoverable failures. No mode writes project config or profiles.
set -euo pipefail

payload=$(cat 2>/dev/null) || payload=""
mode=${1:-}

# Lifecycle advice has no permission effect; the fixed native PreToolUse mode
# does affect tool control flow. Audit both through their explicit host phase.
case "$mode" in
  claude-session-start|codex-session-start) navori_audit_phase="SessionStart" ;;
  claude-post-model-switch) navori_audit_phase="PostModelSwitch" ;;
  claude-stop) navori_audit_phase="Stop" ;;
  codex-pretool-profile) navori_audit_phase="PreToolUse" ;;
  *) navori_audit_phase="unknown" ;;
esac
navori_audit_name="model-advisor"
navori_audit_begin() { :; }
navori_audit_log() { :; }
# navori:include audit-repo
# navori:include audit-log
navori_audit_begin
navori_profile_verdict="skip"
navori_audit_on_exit() {
  navori_audit_log "$navori_profile_verdict" || true
  return 0
}
trap navori_audit_on_exit EXIT

# Fixed native argument rewrite, before the advisory subagent skip. Recoverable
# failures deny; an outer host timeout/crash can fail open and remains uncertain.
if [ "$mode" = "codex-pretool-profile" ]; then
  if [ "${#payload}" -gt 1048576 ]; then
    printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"profile-hook-input-too-large; effective-selection-pending"}}'
    navori_profile_verdict="block"
    exit 0
  fi
  profile_exit=0
  profile_output=$(node 3<<<"$payload" <<'PROFILE_NODE'
const { spawn } = require("node:child_process");
const rawPayload = require("node:fs").readFileSync(3, "utf8");
const deny = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "profile-hook-cli-unavailable-or-invalid; effective-selection-pending" } };
let child;
let timer;
let finished = false;
const finish = (value, code) => {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  if (child?.pid) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }
  process.stdout.write(JSON.stringify(value) + "\n");
  process.exitCode = code;
};
let original;
try { original = JSON.parse(rawPayload); }
catch { finish(deny, 2); }
if (!finished) {
  const bytes = Buffer.byteLength(rawPayload);
  if (bytes > 1024 * 1024) finish(deny, 2);
  else {
    child = spawn("navori", ["codex", "profile", "hook"], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const chunks = [];
    let size = 0;
    timer = setTimeout(() => finish(deny, 2), 11_000);
    child.once("error", () => finish(deny, 2));
    child.stdin.on("error", () => finish(deny, 2));
    child.stdout.on("data", chunk => {
      size += chunk.length;
      if (size > 1024 * 1024) finish(deny, 2);
      else chunks.push(chunk);
    });
    // Audit belongs on stderr; do not forward untrusted CLI diagnostics/payloads.
    child.stderr.on("data", () => {});
    child.once("close", (code, signal) => {
      if (finished) return;
      if (code !== 0 || signal) return finish(deny, 2);
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (result !== null && typeof result === "object" && !Array.isArray(result) && Object.getPrototypeOf(result) === Object.prototype && Object.keys(result).length === 0) return finish({}, 3);
        const output = result?.hookSpecificOutput;
        if (output?.hookEventName !== "PreToolUse") return finish(deny, 2);
        if (output.permissionDecision === "deny" && typeof output.permissionDecisionReason === "string") return finish({ hookSpecificOutput: output }, 2);
        const updated = output.updatedInput;
        const input = original?.tool_input;
        const plain = value => value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
        const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
        const profile = result.navoriProfile;
        if (output.permissionDecision !== "allow" || !plain(output) || Object.keys(output).some(key => !["hookEventName", "permissionDecision", "permissionDecisionReason", "updatedInput", "additionalContext"].includes(key)) || (output.additionalContext !== undefined && typeof output.additionalContext !== "string") || (output.permissionDecisionReason !== undefined && typeof output.permissionDecisionReason !== "string") || !plain(updated) || !plain(input) || !exact(result, ["hookSpecificOutput", "navoriProfile"]) || !exact(profile, ["version", "role", "model", "effort"]) || profile.version !== 1 || typeof profile.role !== "string" || !profile.role || profile.role !== input.agent_type) return finish(deny, 2);
        for (const [field, key] of [["model", "model"], ["effort", "reasoning_effort"]]) {
          const choice = profile[field];
          if (choice?.kind === "set") {
            if (!exact(choice, ["kind", "value"]) || typeof choice.value !== "string" || !choice.value || updated[key] !== choice.value) return finish(deny, 2);
          } else if (!exact(choice, ["kind"]) || choice.kind !== "inherit" || Object.hasOwn(input, key) || Object.hasOwn(updated, key)) return finish(deny, 2);
        }
        const keys = new Set([...Object.keys(input), ...Object.keys(updated)]);
        for (const key of keys) {
          if (key === "model" || key === "reasoning_effort") continue;
          if (JSON.stringify(input[key]) !== JSON.stringify(updated[key])) return finish(deny, 2);
        }
        finish({ hookSpecificOutput: output }, 0);
      } catch { finish(deny, 2); }
    });
    child.stdin.end(rawPayload);
  }
}
PROFILE_NODE
  ) || profile_exit=$?
  # Capture first: a missing/fatal/signaled supervisor cannot leak a partial
  # response or append a second JSON document after an already valid denial.
  if [ -n "$profile_output" ] && { [ "$profile_exit" -eq 0 ] || [ "$profile_exit" -eq 2 ] || [ "$profile_exit" -eq 3 ]; }; then
    printf '%s\n' "$profile_output"
  else
    printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"profile-hook-supervisor-unavailable; effective-selection-pending"}}'
    profile_exit=2
  fi
  case "$profile_exit" in
    0) navori_profile_verdict="allow" ;;
    3) navori_profile_verdict="skip" ;;
    *) navori_profile_verdict="block" ;;
  esac
  exit 0
fi

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
