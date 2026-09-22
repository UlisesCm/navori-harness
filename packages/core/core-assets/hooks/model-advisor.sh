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
  claude-pre-tool-use) navori_audit_phase="PreToolUse" ;;
  *) navori_audit_phase="unknown" ;;
esac
navori_audit_name="model-advisor"
navori_audit_begin() { :; }
navori_audit_log() { :; }
# navori:include audit-repo
# navori:include audit-log
navori_audit_begin
navori_audit_on_exit() {
  navori_audit_log "skip" || true
  return 0
}
trap navori_audit_on_exit EXIT

# Tool events fire inside every subagent too, and a subagent firing can only
# reach the `agent_id || agent_type` exit below, so its `node` spawn is pure
# waste. Discard it here with a fork-free substring test: the same condition,
# `agent_type` included, so a session started with `--agent` keeps behaving as
# before. It sits after the trap so audit mode still records the firing.
case "$payload" in *'"agent_id"'* | *'"agent_type"'*) exit 0 ;; esac

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

if (mode === "claude-session-start" || mode === "claude-post-model-switch") {
  const model = mode === "claude-session-start" ? payload.model : payload.to_model;
  if (typeof model !== "string" || !model) process.exit(0);
  writeState({ model, notified: mode === "claude-post-model-switch" ? readState()?.notified === true : false });
  process.exit(0);
}

if (mode !== "claude-pre-tool-use") process.exit(0);
const state = readState();
if (!state || state.notified) process.exit(0);
const effort = payload.effort && typeof payload.effort.level === "string" ? payload.effort.level : null;
const isFable = state.model === "claude-fable-5";
const isHighOpus = /opus/i.test(state.model) && ["high", "xhigh", "max"].includes(effort);
if (!isFable && !isHighOpus) process.exit(0);
writeState({ ...state, notified: true });
notice(claudeMessage(isFable ? state.model : `${state.model}/${effort}`));
NODE
