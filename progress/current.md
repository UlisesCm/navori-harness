# Sesión actual

**Estado:** el ciclo de #375 está cerrado y mergeado (PR #441). No hay trabajo a medias, no
hay PRs abiertos, el espejo del harness está al día y `main` está limpio.

## Lo que se cerró

- **#375** (`priority:high`, prosa → mecanismo) — PR #441. Al dimensionarlo, dos de los cinco
  casos ya estaban hechos (**caso 2**, el quality gate, ya derivaba de `{{qualityGate.*}}` sin
  un solo hardcode; **caso 5**, "gates ready", ya lo cubría `scanQualityGateReadiness` en
  `doctor.ts:134`). Los otros tres se cerraron borrando la regla y citando su mecanismo.
- **#435** — PR #438, mergeado al abrir la sesión.

## El hallazgo que valió más que el issue

`project.criticalAreas` tiene `.default([])`, el interpolador serializa arrays con
`join(", ")` → `""`, y como `""` no es `null` el `placeholderFallback` **nunca disparaba**.
Resultado: `CLAUDE.md:72` renderizaba literalmente ``a `` area`` en la lista de señales
R2-architectural, en **todo repo que no declarara el campo**. Arreglado en dos mitades que
cargan peso las dos (verificado revirtiendo una a la vez: sin el interpolador 3 tests fallan,
sin los fallbacks 5, con ambas 11 pasan).

## Bytes NUL en un fuente: la clase de defecto más cara de la sesión

`engines/codex/compat.ts` tenía **dos U+0000 crudos** en el literal del sentinel. Efectos
verificados, no teóricos:

- `file(1)` lo clasificaba como `data`; `grep`/`rg` lo trataban como binario y **ocultaban las
  líneas** (un `| head` se come el aviso `Binary file … matches` y se lee como "sin hits");
- `git log -p` imprimía `Binary files … differ`: **ningún cambio a ese archivo mostró diff
  legible jamás**, ni en la CLI ni en la vista de PR. En un repo cuyo modelo de calidad es
  enteramente basado en diff, el `reviewer` no podía juzgar ese archivo.

Costo real: es lo que impidió localizar la reescritura de rutas que busca **#428**. Está en
`compat.ts:48` (`.replaceAll(".claude/", ".codex/")`, el catch-all de
`adaptHarnessTextForCodex`), ya comentado en el issue con la evidencia. Mecanismo que quedó:
`no-nul-bytes.test.ts` barre `packages/**` y falla si algún fuente trae un NUL.

## Decisión de diseño registrada (no re-litigar)

**La zona de usuario de un archivo renderizado se escribe UNA vez y nunca se re-interpola**:
`render-managed-file.ts:73-95` calcula `interpolatedUserTpl` y `assembleFresh` lo usa, pero
`rerender` **ni lo recibe**. Es correcto (esa zona es del usuario), pero implica que **un fix
del interpolador NO llega a los repos ya onboardeados** por más que re-rendericen. Los 9
tokens `<not configured:>` de este repo se corrigieron a mano y el reviewer validó que quedan
byte-idénticos a un render fresco. El mecanismo que falta es **detectar y avisar, no
reescribir** → #440.

## Issues abiertos

**Nuevos de esta sesión:**

- **#439** `priority:medium` — los `{{...}}` literales de un asset los devora el interpolador:
  la lib-skill de i18next renderiza `<not configured: count>` en vez de `{{count}}`, o sea
  desinforma sobre la sintaxis que documenta. Preexistente. Falta un mecanismo de escape
  (estilo el marcador `shq:`), no un fallback. El test de #375 lo atrapa agregando
  `project: { libraries: ["i18next"] }` a sus `PROJECT_SHAPES`.
- **#440** `priority:medium` — chequeo en `doctor` para los tokens congelados en zona de
  usuario (ver la decisión de arriba).

**Desbloqueado esta sesión:**

- **#428** `priority:medium` — ya está localizada la reescritura (`compat.ts:48`) y el archivo
  volvió a ser diffeable, que era precondición para revisar su fix. La opción 1 del issue
  (lista de prefijos traducibles en vez de reemplazo ciego) es la que ataca la causa.

**Con alcance ya decidido (no re-litigar):** #379 (solo mitad B), #378 (R1 exprés atado al
diff), #377 (fan-out en fase 2 del intake), #370 (asíncrono solo para cerrar).

**Auditoría de reprocesos, sin empezar:** #401 (ceremonia de memoria duplicada), #403
(allowlist derivado del config), #405 (backup proporcional al diff).

**Testing:** #394 (golden snapshot), #395 (repos fixture), #396 (benchmark, NO gate de CI).

**Otros:** #432 (`listMarkers` no es fence-aware), #423 (jscpd sin caché — **medir antes**; si
el ahorro no lo justifica, cerrar como `wontfix` con la medición adjunta).

## Rollout 0.6.0: CONGELADO

Ulises pidió explícitamente **no hacer el rollout** hasta que lo indique. No proponerlo ni
arrancarlo. Cuando toque, es per-repo (NUNCA `--all`). Avisos vigentes: drift gestionado
esperado en el próximo render; el guard es más estricto con el TEXTO del comando (un mensaje
de commit que mencione un borrado recursivo de HOME se bloquea — la salida es
`git commit -F <archivo>`); los repos con `socket.io-client` necesitan `navori update` además
de `render`. **Nuevo**: el fix del placeholder vacío NO llega solo a las zonas de usuario ya
escritas (#440).

## Decisión pendiente de Ulises (no automatizar)

`~/.navori/backups` acumula fixtures de test históricos. **El filtro seguro es por prefijo, no
por edad**: `navori backup prune` borra por edad y se llevaría justo los backups reales, que
son los más viejos. Conteo de lo que sobra:
`ls ~/.navori/backups | grep -v '^navori-harness-' | wc -l`.

## Gotchas de proceso vigentes

- **Un fuente con un byte NUL es invisible para grep y opaco para `git diff`.** Diagnóstico:
  `file <archivo>` dice `data`; `command grep` (sin pipe) muestra `Binary file … matches`.
  Mientras el blob VIEJO tenga NUL, el diff del commit que lo arregla sigue viéndose binario
  (git marca el par si cualquiera de los dos lados lo tiene): se lee con `git diff --text`.
- **Editar el body de un PR puede romper el auto-cierre del issue.** Al reescribir el body de
  #416 se perdió la línea `Closes #<n>` y el merge no cerró el issue.
- **En zsh, `$0` dentro de una función es el nombre de la función**, no la ruta del script.
- **El `||` del llamador suprime errexit dentro de la función llamada.**
- **`${PIPESTATUS[0]}` no funciona en zsh** (es `$pipestatus[1]`): un `echo "exit=${PIPESTATUS[0]}"`
  sale vacío y no prueba nada. Verifica el verde con la salida del comando, no con esa variable.

## Notas heredadas

- La ruta de los repos Bonum en el `~/.claude/CLAUDE.md` global sigue desactualizada,
  `~/.navori/registry.json` conserva una entrada de prueba apuntando al scratchpad, y siguen
  pendientes los PRs del repo externo bonum-webapp (#639, #640, #559) más el rebind de
  SonarCloud.
