# navori:managed start id="audit-mode-trigger-base" hash="8dd388d4" version="0.6.1" source="@navori/core"
#!/usr/bin/env bash
# navori — audit-mode trigger (UserPromptSubmit)
#
# Detects an audit-mode invocation in the user's prompt and asks Claude to
# CONFIRM with the user before anything is recorded. It never activates the
# mode by itself: a false positive must die in the question, leaving no state
# on disk.
#
# While the mode is active it appends the typed prompt to the session's
# append-only log. Writes are O_APPEND only; the log is never re-read to be
# rewritten, so parallel subagents cannot corrupt it and a crashed session
# still leaves a valid (merely shorter) file.
#
# FAIL-OPEN ABSOLUTE: this hook runs on every prompt. Any error, any missing
# dependency, any odd path exits 0 silently. It must never be the reason a
# session fails to start.

set +e

emit_and_exit() { printf '%s\n' "$1"; exit 0; }

payload=$(cat 2>/dev/null) || exit 0
[ -n "$payload" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

prompt=$(printf '%s' "$payload" | jq -r '.user_prompt // ""' 2>/dev/null) || exit 0
session_id=$(printf '%s' "$payload" | jq -r '.session_id // ""' 2>/dev/null) || exit 0
cwd=$(printf '%s' "$payload" | jq -r '.cwd // ""' 2>/dev/null) || exit 0
[ -n "$session_id" ] || exit 0
[ -n "$cwd" ] || cwd=$PWD

repo=$(basename "$cwd" 2>/dev/null) || exit 0
[ -n "$repo" ] || exit 0

if [ -n "$NAVORI_AUDITS_ROOT" ]; then
  audits_root=$NAVORI_AUDITS_ROOT
else
  [ -n "$HOME" ] || exit 0
  audits_root=$HOME/.navori/audits
fi
log_file=$audits_root/$repo/session-$session_id.log

lower=$(printf '%s' "$prompt" | tr '[:upper:]' '[:lower:]' 2>/dev/null) || exit 0

# Deliberately tolerant: a spurious match costs one question, while a missed
# one costs the whole recording.
case "$lower" in
  *"audit mode"*|*"audit-mode"*|*"modo audit"*|*"modo auditoría"*|*"modo auditoria"*) matched=1 ;;
  *) matched=0 ;;
esac

case "$lower" in
  *apaga*|*apagar*|*desactiva*|*"salir de"*|*detén*|*deten*|*stop*|*"turn off"*|*disable*) off_intent=1 ;;
  *) off_intent=0 ;;
esac

if [ -f "$log_file" ]; then
  # Active: record the human's own words — they entered the model's context,
  # so they cost tokens and belong in the audit.
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null) || ts=""
  printf '%s\n' "$(jq -cn --arg ts "$ts" --arg ev "prompt" --arg p "$prompt" \
    '{ts:$ts,event:$ev,prompt:$p}' 2>/dev/null)" >> "$log_file" 2>/dev/null

  if [ "$matched" = "1" ] && [ "$off_intent" = "1" ]; then
    emit_and_exit "[navori audit-mode] El usuario pidió apagar audit-mode. ANTES de hacerlo, pregúntale explícitamente: \"Se apagará audit mode, ¿continuar?\". Solo si confirma, ejecuta: navori audit --stop $session_id (eso cierra el log y genera el reporte). Si dice que no, deja el modo activo y sigue con la tarea."
  fi
  exit 0
fi

if [ "$matched" = "1" ] && [ "$off_intent" = "0" ]; then
  emit_and_exit "[navori audit-mode] Se detectó la invocación de audit-mode en el prompt. ANTES de activar nada, pregúntale explícitamente al usuario: \"Se detectó la invocación de audit mode, ¿continuar?\". Solo si confirma, ejecuta: navori audit --start $session_id (eso crea el log de la sesión). Si dice que no, no ejecutes nada y sigue con la tarea normal."
fi

exit 0
# navori:managed end id="audit-mode-trigger-base"
