# Sesión actual

**Estado:** `main` @ `b399f3c`, limpio, espejo al día, **0 PRs abiertos**, **13 issues**.
Hoy se cerraron **15** issues. No hay trabajo a medias ni worktrees vivos con cambios.

## LO PRIMERO QUE HAY QUE SABER: el rollout 0.6.0 sigue CONGELADO

**Criterio de salida dictado por Ulises (2026-08-24):** no se descongela hasta **(a) resolver
TODOS los issues abiertos** y **(b) garantizar una versión estable** para renderizar en sus
proyectos. No es "cuando baje el tablero" ni "cuando entren los fixes importantes". Se le ofreció
descongelar per-repo el mismo día en que entraron fixes grandes y eligió esperar.

No lo propongas ni lo arranques. Cuando toque: **per-repo, NUNCA `--all`**.

**Límite que hay que decirle ANTES del rollout, no después:** por el hueco de #440, un `render`
**no actualiza las zonas de usuario ya escritas** — se congelan con la redacción del render que
las creó. Así que "versión estable" no basta para dejar limpios los repos onboardeados: los
tokens viejos en zona de usuario (p. ej. el fallback en español de #445) necesitan el chequeo de
`doctor` que entró con #440 y corrección **a mano**.

## Regla de trabajo acordada hoy (aplícala)

Ulises señaló que el tablero llevaba días sin bajar. Se midió: no estaba creciendo, estaba en un
**punto fijo** — cada ciclo cerraba ~3 y abría ~3, porque cada implementación auditaba el código
vecino. El conteo medía tasa de descubrimiento, no avance.

> Un hallazgo se vuelve issue **solo** si (a) necesita una decisión que no es del agente, (b) no
> cabe en el ciclo que lo encontró, o (c) se va a olvidar y duele. Si el fix cabe en el diff
> abierto y no requiere decisión: **se arregla ahí y se cuenta en el cuerpo del PR**, sin ticket.

Caso testigo de la regla: **#447** no debió abrirse (guard de una línea) y encima su análisis
resultó equivocado — decía "no explotable" mirando solo `resolvePath`, cuando la fuga estaba en
`placeholderFallback`. Lo destapó el test al fallar.

Y **#423 se cerró sin código**, con una medición que probó que el caché saldría 1.3 s peor.
Medir antes de implementar es camino legítimo a cero, no atajo.

## Issues abiertos (13)

**Decisiones de Ulises del 2026-08-24 (cuestionario), dirección ya fijada:**

- **#461** `high` — 209 errores de tipos que ningún gate ve. **Decisión: limpiar los 209 PRIMERO,
  y después agregar `typecheck` al gate.** Descartadas explícitamente la variante de baseline y la
  informativa. Recomendación de ejecución: medir el reparto por archivo y regla antes de repartir
  tandas.
- **#462** — el `guard-destructive` bloquea prosa que *cita* comandos destructivos (frenó el cuerpo
  del PR de #403 por citar sus strings de ataque). **Decisión: acotarlo a lo que se EJECUTA, no al
  texto que se escribe.** NO autoriza excusar la escritura de archivos por completo. **Bloqueado
  por nada ya** (#454 mergeó), pero toca los mismos hooks: revisa el estado antes.
- **#458** — `.gitignore` es la única escritura del render que esquiva el punto de respaldo.
- **#459** — el cierre de marcador sigue con `indexOf` crudo: un cierre citado trunca el bloque real.
- **#460** `low` — `MARKER_ID_ATTR_RE` más laxo que el parser (tercera forma del hueco de #432).

**Tanda de optimización, alcance decidido el 20-ago:** #377 (fan-out en fase 2 del intake),
#378 (R1 exprés atado al diff), #379 (solo mitad B), #370 (asíncrono solo para cerrar).

**Testing:** #394 (golden snapshot por engine), #395 (repos fixture init→render→doctor),
#396 (benchmark, NO gate de CI — es `question`, evaluar si procede).

**Auditoría de reprocesos:** #401 (ceremonia de memoria duplicada) — último de los tres.

## Lo que se cerró hoy (15)

#435, #375, #439, #440, #428, #447, #403, #405, #432, #423 (wontfix con medición), #445, #443,
#452, #454, y el estado de sesión.

Los cuatro más grandes, por si hace falta el contexto:

- **#375 + el bug que destapó**: un placeholder que resolvía a vacío dejaba prosa rota
  (`a `` area`) en TODO repo sin el campo declarado.
- **#452**: `findMarker` no era fence-aware en la **ruta de escritura**. Doble `render --apply`
  demostró que `main` **destruía el ejemplo documentado** y dejaba el bloque duplicado, en
  silencio y permanente.
- **#454**: los hooks de semgrep/jscpd/pre-commit **pasaban en verde sin escanear** desde un
  worktree de agente. Todos los commits del flujo multi-agente estaban sin gatear por los dos
  escáneres que CI no corre.
- **#403**: el quality gate promptaba permisos; 772 entradas acumuladas y 91 envolturas
  `bash -c` que el agente aprendió para esquivar el prompt.

## Gotchas de proceso vigentes

- **Un fuente con un byte NUL es invisible para grep y opaco para `git diff`.** Diagnóstico:
  `file <archivo>` dice `data`; `command grep` sin pipe muestra `Binary file … matches`.
- **La base se mueve durante un ciclo largo.** Pasó cuatro veces hoy. El receipt se ancla a
  `git diff HEAD`, NO a `origin/main`: anclarlo a la ref movida ata archivos de ciclos ajenos que
  la review nunca cubrió. El pilot rebasa y **re-corre el gate** — el verde del reviewer caduca.
- **Editar el body de un PR puede romper el auto-cierre del issue** (`Closes #<n>`).
- **`${PIPESTATUS[0]}` no existe en zsh** (es `$pipestatus[1]`): sale vacío y no prueba nada.
- **Al aplicar un fix con script, no reuses la variable del path.** Hoy escribí un archivo sobre
  otro; se detectó porque el build falló y **se restauró desde el blob del receipt**
  (`git cat-file -p <sha>`), verificando que `git hash-object` volviera a coincidir.

## Residuos declarados en cuerpos de PR, SIN ticket (decisión consciente)

- **#454**: dos worktrees enlazados del mismo repo son indistinguibles, así que
  `cd <hermano> && cd <main> && git commit` sigue peor que `main`. Documentado en el script
  (`SAME-REPOSITORY CONSTRAINT — DO NOT REMOVE`) con su disparador de mejora.
- **#454**: un `GIT_DIR` en el entorno del hook colapsaría la igualdad. Sin vía alcanzable
  encontrada.
- **#445**: el título del test en `placeholders.test.ts` dice "defaults to es" para un default que
  ya no existe. La aserción sigue siendo válida.

## Notas heredadas

- `~/.navori/backups` acumula fixtures de test históricos. **El filtro seguro es por prefijo, no
  por edad**: `navori backup prune` borra por edad y se llevaría los backups reales, que son los
  más viejos. Conteo: `ls ~/.navori/backups | grep -v '^navori-harness-' | wc -l`.
- La ruta de los repos Bonum del `~/.claude/CLAUDE.md` global está desactualizada
  (`/Users/ulisescm/Documents/dev/bonum/` no existe en esta máquina), `~/.navori/registry.json`
  conserva una entrada de prueba apuntando al scratchpad, y siguen pendientes los PRs del repo
  externo bonum-webapp (#639, #640, #559) más el rebind de SonarCloud.
