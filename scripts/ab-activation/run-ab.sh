#!/usr/bin/env bash
# A/B de activación — H4: ¿el modo de permisos explica que no se delegue?
#
# Una sola variable: `--permission-mode auto` contra `--permission-mode acceptEdits`.
# Todo lo demás idéntico: mismo fixture recién clonado, mismo prompt, mismo modelo,
# misma versión de navori.
#
# Uso:  bash run-ab.sh <corridas-por-brazo> [modelo]
#
# Cada corrida:
#   1. regenera el fixture desde cero (git limpio, sin contaminación entre corridas)
#   2. renderiza el harness con el navori local
#   3. lanza `claude -p` con el prompt y el modo del brazo
#   4. guarda el id de sesión para que la medición lea SU transcript
set -euo pipefail

N="${1:?uso: run-ab.sh <corridas-por-brazo> [modelo]}"
MODEL="${2:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
LAB="${AB_LAB:-/tmp/navori-ab}"
NAVORI="${AB_NAVORI:-node $ROOT/packages/cli/dist/index.js}"

# El prompt cruza los dos umbrales a propósito, y NO nombra ningún agente ni
# skill: si la delegación ocurre, fue automática.
PROMPT='Agrega el campo obligatorio `email: string` al tipo `User` de src/types.ts y propágalo a TODOS sus consumidores (makeUser, greeter, serializer, registry, report) y a los tests. Deja el quality gate completo en verde antes de terminar.'

# Template construido UNA vez: fixture + deps + harness renderizado. Cada corrida
# lo clona, así que las 2N sesiones arrancan del mismo estado byte por byte, y el
# gate está verde desde el primer turno — un gate roto mandaría al agente a
# depurar, y eso no es lo que este experimento mide.
TPL="$LAB/_template"
mkdir -p "$LAB"
if [ ! -d "$TPL" ]; then
  echo "▸ construyendo template (una sola vez)…"
  bash "$HERE/make-fixture.sh" "$TPL" >/dev/null
  ( cd "$TPL" && npm install --silent --no-audit --no-fund >/dev/null 2>&1 )
  ( cd "$TPL" && $NAVORI render --apply >/dev/null 2>&1 ) || true
  if ( cd "$TPL" && npm run typecheck >/dev/null 2>&1 && npm test >/dev/null 2>&1 ); then
    echo "  ✓ baseline verde (typecheck + test por código de salida)"
  else
    echo "  ✗ el template NO arranca verde — abortando"; exit 1
  fi
  ( cd "$TPL" && git add -A && git -c user.email=ab@fixture -c user.name=ab commit -qm harness ) || true
fi

# Cada invocación estrena su propio namespace: las corridas son inmutables y
# nunca hace falta borrar nada.
STAMP="$(date +%Y%m%d-%H%M%S)"
BATCH="$LAB/$STAMP"
mkdir -p "$BATCH"
: > "$BATCH/runs.tsv"
echo "▸ lote $STAMP — $N corridas por brazo"

for ARM in auto acceptEdits; do
  for i in $(seq 1 "$N"); do
    RUN="$BATCH/${ARM}-${i}"
    SID="$(uuidgen | tr 'A-Z' 'a-z')"
    cp -R "$TPL" "$RUN"

    echo "▶ $ARM #$i  (sesión $SID)"
    ( cd "$RUN" && claude -p "$PROMPT" \
        --permission-mode "$ARM" \
        --session-id "$SID" \
        ${MODEL:+--model "$MODEL"} \
        >"$RUN/stdout.txt" 2>"$RUN/stderr.txt" ) || echo "  (la corrida terminó con error; se mide igual)"

    printf '%s\t%s\t%s\t%s\n' "$ARM" "$i" "$SID" "$RUN" >> "$BATCH/runs.tsv"
  done
done

echo
echo "corridas en $BATCH/runs.tsv — mide con:  python3 $HERE/score-ab.py $BATCH/runs.tsv"
