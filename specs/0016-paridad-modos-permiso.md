# Spec 0016 — Paridad entre modos de permiso (auto / acceptEdits / default)

- **Status**: accepted (2026-09-07) — en ejecución. L1 en curso; L0/L2 ver §7.
- **Fecha**: 2026-09-07
- **Autor**: Ulises Ciprés
- **Relacionado**: #574/#576 (escalera vs auto mode), #575/#577 (MCP tools a los roles),
  #579/#580 (los seis modos), spec 0015 + #582/#583 (dieta del always-on + histograma por
  modo), #587 (costo real de hooks + fast-path del guard), specs 0005/0006 (lectura
  eficiente / reducción de contexto)
- **Evidencia base**: 27 sesiones de audit-mode (2026-08-25 → 09-05, CC 2.1.231/2.1.236,
  6 repos) + doc oficial de Claude Code (`code.claude.com/docs/en/permission-modes`,
  `/permissions`, `/auto-mode-config`) + lectura verificada de los assets fuente.
  Cada afirmación de esta spec trae su `file:line` o su métrica medida; lo que no se pudo
  verificar quedó en la Fase 0 como pregunta abierta, no como supuesto.

## 1. Problema

El harness debe funcionar igual de bien en `auto`, `acceptEdits` y `default`. Hoy no:
la percepción reportada es que en auto mode "las búsquedas y en general los resultados
son más lentos y peores". La medición confirma la degradación pero corrige la causa.

**Lo que se REFUTÓ** (y por tanto esta spec no ataca):

- *"Auto es más lento por comando."* Falso: la mediana de una búsqueda por shell es igual
  entre modos (0.20s auto vs 0.21s acceptEdits), y en comandos pesados auto es MÁS rápido
  (p50 2.49s vs 8.71s) porque el clasificador (~1.5–2s, visible en el p75: 1.83s vs 0.94s)
  le gana por 10x a la espera de aprobación humana.
- *"Auto produce más fricción/bloqueos."* Falso en proporción: 0.40% vs 0.37% de calls.

**Lo que se CONFIRMÓ** — la degradación es de mezcla y volumen, no de latencia unitaria:

| Métrica (hilo orquestador) | auto | acceptEdits | default |
|---|---|---|---|
| Bash del total de tool calls | **90.2%** (6,382/7,072) | 64.9% | 63.0% |
| Tools nativas (Read/Edit/Grep/Glob) | **3.0%** | 26.6% | 24.6% |
| Búsquedas shell puras / hora activa | **26.8** | 8.5 | 7.7 |
| Tiempo activo esperando shell | **44%** (28.3 h de 64.5 h) | — | — |
| Output tokens / minuto activo | **1,590** | 1,074 | 1,203 |

La vía que auto abandona es 10–25x más rápida y funciona en auto (66 usos medidos):
Grep/Read nativo p50 **0.08s**, codegraph/engram p50 **0.13s**, contra búsqueda shell p50
0.20s con p75 1.83s. Y cada Bash arrastra además su batería de hooks (5 con jscpd+semgrep
instalados) y su resultado re-entrando al contexto — el +48% de tokens/minuto es la
explicación de "resultados peores": más ruido por movimiento, no más avance.

**El dato que amplía el alcance**: el dominio de Bash NO es exclusivo de auto. El
histograma del #583 midió sesiones 100% Bash también en `default` (9/9) y `acceptEdits`
(13/13). Auto no causa el comportamiento; lo *encarece* (clasificador + hooks + tokens).
Por eso esta spec tiene dos frentes: **bajar el costo del Bash donde es caro (auto)** y
**bajar el volumen de Bash en TODOS los modos** empujando la mezcla hacia
nativas/MCP — que es además lo que hace mejores las sesiones en default/acceptEdits
(sus esperas de prompt humano p90 ~102s desaparecen para todo lo que deja de ser shell
o queda cubierto por `allow`).

## 2. Las tres causas, verificadas

1. **allow ↔ doctrina rotos.** `operaciones-seguras.md:22` ordena "one `rg` over a scoped
   path beats a loop of greps", pero `settings-base.json` no trae `Bash(rg:*)` (sí trae
   `Bash(grep:*)` en :54 y `Bash(ast-grep:*)` en :55): el binario recomendado paga
   clasificador y el desaconsejado es gratis. La derivación del gate
   (`build-settings.ts:426-431`) solo emite `Bash(<pm> run <script>:*)`, así que
   `pnpm test` sin `run` también paga.
2. **La doctrina de auto mode empuja al shell y la señal del audit lo refuerza.** El bullet
   "When the host mandates Bash" (`operaciones-seguras.md:19-22`) enseña a *agrupar*
   comandos de shell, y el texto de la señal `classifier-round-trips`
   (`signals.ts:318-319`) dice literalmente que lo que baja el costo es "agrupar comandos…
   **no cambiar de herramienta**" — afirmación hoy refutada por la medición (cambiar de
   herramienta es exactamente lo que la baja 10–25x).
3. **Hooks por cada Bash.** `guard-destructive` (Pre, siempre) + `managed-drift-watch`
   (Post, siempre) + `quality-gate`/`check-jscpd`/`check-semgrep` (Pre, si están
   configurados). El fast-path del guard (#587, `guard-destructive.sh:337-389`) resuelve
   en ~2ms el 80% de comandos, pero **todo comando que contenga el substring `git` — la
   familia más frecuente — paga el análisis completo (~46ms)** porque `git` es token del
   `case` de la línea 382.

## 3. Solución paso a paso

Seis fases en orden de riesgo. Cada paso lista qué cambia, qué se verificó antes de
proponerlo, y cómo se comprueba que funcionó.

### Fase 0 — Verificación en vivo (sin tocar código)

El corpus es CC 2.1.231/236 y todo pre-navori-0.7.2; la doc oficial actual ya **no**
documenta que auto mode obligue a trabajar por shell, y las nativas funcionan en auto
(66 usos medidos). Antes de reescribir doctrina hay que medir el presente.

- **T0.1** — Correr 3 sesiones A/B con `navori audit --start`, misma tarea representativa
  (un ticket chico real), una por modo (`auto`, `acceptEdits`, `default`), en CC ≥2.1.260
  con navori ≥0.7.2. Responden tres preguntas que la spec deja abiertas a propósito:
  1. ¿El host aún induce shell en auto mode, y para qué (¿solo ediciones, o también
     búsqueda/lectura?)? — decide entre las dos variantes de T2.1.
  2. ¿Las reglas `allow` de prefijo del settings **del proyecto** (`Bash(grep:*)`-style)
     resuelven sin clasificador en auto? (La doc dice que las reglas *amplias* tipo
     `Bash(*)` se descartan al entrar a auto y las estrechas se mantienen, y que el bloque
     `autoMode.*` solo se lee de `~/.claude/settings.json`/managed — falta confirmar en
     vivo dónde cae exactamente un prefijo por binario.)
  3. Baseline post-#576/#583: ¿la doctrina 0.7.2 ya movió la mezcla, o sigue en ~3%
     nativas?
- **Criterio de salida**: los tres reportes de `navori audit` comparados; las respuestas
  se anotan en esta spec antes de ejecutar la Fase 2.

### Fase 1 — Cerrar la brecha allow ↔ doctrina (mejora los TRES modos)

Cada regla nueva elimina un round-trip de clasificador en auto **y** un prompt humano en
default/acceptEdits. Solo reglas estrechas (las amplias se descartan en auto mode).

- **T1.1 — RECHAZADO al implementar** (2026-09-07). La verificación original era falsa en
  sus dos mitades y la tarea no entra; ver §4.5. En su lugar, la brecha de la causa 1 se
  cierra **por el lado de la doctrina**, que es lo que Fase 1 se propone ("cerrar la brecha
  allow ↔ doctrina"): `operaciones-seguras.md:22` deja de recomendar `rg` por shell y pasa
  a mandar al `Grep` nativo — que ES ripgrep por debajo, YA está en `allow`
  (settings-base.json:42) y no paga clasificador. La cifra medida (0.08s vs 0.20s / p75
  1.83s) se cita ahí mismo como argumento. Este cambio de texto NO depende de la Fase 0:
  no reescribe la doctrina de auto mode, corrige una recomendación que apuntaba a un
  binario que el harness nunca va a pre-aprobar.
- **T1.2 — HECHO, con corrección.** `deriveQualityGateAllow` emite también la forma sin
  `run`, pero **solo donde el package manager de verdad la resuelve al script**. La
  premisa original ("`pnpm test` es azúcar de `pnpm run test`") solo vale para pnpm y yarn.
  Medido con un `package.json` que declara los cinco scripts, en pnpm 10 / npm 11 / yarn 1
  / bun 1:

  | pm   | build            | test              | lint | typecheck | format |
  |------|------------------|-------------------|------|-----------|--------|
  | pnpm | script           | script            | ✓    | ✓         | ✓      |
  | npm  | `Unknown command`| script            | ✗    | ✗         | ✗      |
  | yarn | script           | script            | ✓    | ✓         | ✓      |
  | bun  | **BUNDLER**      | **TEST RUNNER**   | ✓    | ✓         | ✓      |

  Dos motivos distintos para excluir, y solo uno es cosmético: npm falla con "Unknown
  command" salvo en su alias `test` (una regla ahí es peso muerto que aparenta una
  capacidad inexistente); y `bun build` / `bun test` son el **bundler** y el **test runner**
  de bun, no los scripts — emitirlas pre-aprobaría un comando distinto del que la regla
  dice (`bun build --outdir <donde sea>` escribe archivos), justo la expansión de superficie
  que esta tarea prometía no introducir. La forma explícita `<pm> run <script>` se emite
  para los cuatro, sin cambios. `SAFE_GATE_STEP` (build-settings.ts:341,399-407) intacto.
- **T1.3** — **`sed -n` NO entra** (corrección a la propuesta original): `sed -n` no es
  read-only puro — el comando `w` de sed (`sed -n 's/a/b/w archivo'`) escribe archivos.
  La lectura de spans la cubre `Read` nativo, que ya está en allow. `find` tampoco entra:
  exclusión deliberada preexistente (`operaciones-seguras.md:7`, por `-exec`/`-delete`).
- **Tests**: los de `build-settings` existentes + caso nuevo por forma directa del
  dev-loop; `pnpm check:render` para el espejo auto-hospedado.
- **Criterio**: el settings rendereado de este repo muestra las reglas nuevas; `doctor`
  limpio; en la re-auditoría, `rg`/`pnpm test` dejan de aparecer en la cola p75 de auto.

### Fase 2 — Doctrina nativa-primero en TODOS los modos (condicionada a Fase 0)

El fondo: la escalera existe y no arranca en ningún modo. La doctrina se reescribe para
que la vía barata sea la misma historia en los tres modos, no un carve-out de auto.

- **T2.1** — Reescribir el bullet de auto mode (`operaciones-seguras.md:19-22`). Dos
  variantes pre-decididas según T0.1:
  - *(a) El host ya no induce shell*: desaparece "the host mandates Bash"; el bullet pasa a
    "en auto mode la escalera nativa/MCP no es preferencia sino la única vía sin
    clasificador; el shell es la vía cara". Se conservan las partes verificadas y vigentes:
    `sed -i` no falla como `Edit` (:20), archivos generados solo vía render/sync (:21).
  - *(b) El host induce shell solo para ediciones*: el bullet se parte en dos — ediciones
    (se mantiene la guía actual de heredocs/verificación) y **búsqueda/lectura**, que se
    reasigna explícitamente a nativas/MCP con la cifra medida (10–25x) como argumento.
- **T2.2** — Corregir el texto de la señal `classifier-round-trips`
  (`signals.ts:316-320`): eliminar "no cambiar de herramienta" (refutado); la
  recomendación pasa a ser escalera primero, agrupar solo lo que deba seguir siendo shell.
- **T2.3** — Refuerzos puntuales donde la doctrina ya es correcta pero no cita el costo:
  `researcher.md:40-41` (ya dice native-first — verificado) gana la línea "in auto mode
  the shell additionally pays a classifier round-trip per command"; `structural-search.md`
  Rung 1 (:19-24) aclara que `rg` por shell aplica cuando `Grep` nativo no cubre el caso
  (git history, flags de contexto), no como default.
- **Criterio**: en la re-auditoría, % nativas+MCP en tramos auto ≥ el nivel de acceptEdits
  de hoy (~26%), y búsquedas shell/hora ≤ 12 (hoy 26.8). Si la doctrina sola no mueve la
  aguja (ya pasó con #576), la señal de Fase 4 lo hará visible por sesión y la Fase 5
  deja de estar parqueada.

### Fase 3 — Dieta de hooks por Bash

- **T3.1** — Fast-path de segunda etapa en el guard para `git` read-only
  (`guard-destructive.sh`, después de :389): si el comando ES un único segmento
  `git <subcomando-read-only>` (los mismos de la familia allow: status/diff/log/show/
  blame/branch/describe/rev-parse/ls-files/cat-file/shortlog/…) **sin** secuenciadores,
  sustituciones, redirecciones ni heredocs → verdict `skip`. Soundness verificada contra
  el argumento del propio archivo (:347-351): las reglas 1-2 solo disparan con
  push/commit/config/hooks; un segmento único read-only no puede alcanzarlas. Se valida
  igual que #587: suite diferencial bash×zsh sobre comandos reales, cero divergencias.
- **T3.2** — Medir el piso trivial de `check-jscpd`/`check-semgrep`/`quality-gate` con la
  mediana del #587 (el reporte ya separa corridas >1s) en una sesión nueva. Verificado:
  `check-jscpd.sh:6-7` ya se gatea a `git commit` vía `is_scan_trigger`
  (`_partials/gate-trigger.sh:18-70`) — las medias del corpus (267/201/212ms) están
  infladas por los escaneos reales, así que **primero se mide, luego se recorta**: si el
  piso trivial supera ~20ms, el trigger-check se adelanta a cualquier trabajo del hook.
  No se especula con "0.8s de desperdicio por Bash".
- **T3.3** — `managed-drift-watch`: **NO se condiciona por "forma de escritura"**
  (descartado, ver §4). Si tras medir el piso (~25-48ms) se quiere recortar, la única vía
  segura es *debounce con stamp* (saltar si el último pase corrió hace <N segundos) más un
  pase garantizado en `SessionEnd` — detección con retraso acotado, nunca detección
  perdida. Opcional; se decide con los números de T3.2.
- **Criterio**: mediana de hooks para un Bash trivial ≤ 100ms con la batería completa de
  5; suite diferencial del guard verde; cero cambios en `ask`/`deny`.

### Fase 4 — Señales de audit que cierran el loop

- **T4.1** — `classifierRoundTrips` (`signals.ts:297-299`) cuenta por **tramo** de modo
  usando `session.permissionModes` y la atribución posicional que el histograma del #583
  ya tiene en `parse.ts`, en vez de exigir que `auto` domine la sesión (hoy una sesión
  mixta con minoría auto reporta cero).
- **T4.2** — Señal nueva `tool-mix`: emite en CUALQUIER modo cuando Bash supera un umbral
  (~85%) del total de tool calls del hilo, con el desglose nativas/MCP/shell. Es el
  termómetro de si la escalera arranca — la carencia que #576 y #583 dejaron anotada.
- **T4.3** — Con el campo de versión del #587 ya presente (≥0.7.2), toda re-auditoría
  distingue "harness viejo" de "doctrina nueva ignorada" — el confounder que este corpus
  no pudo separar.
- **Criterio**: una sesión mixta sintética produce la señal por tramo; la señal tool-mix
  aparece en sesiones Bash-pesadas de cualquier modo.

### Fase 5 — PARQUEADA: pre-aprobación local (`permissionDecision: "allow"`)

La palanca de mayor impacto teórico: el fast-path del guard ya clasifica en ~2ms la clase
inofensiva; un `PreToolUse` que devuelva `allow` la sacaría del clasificador remoto.
**Se parquea a propósito** y solo se abre con enmienda a esta spec + opt-in explícito en
`navori.config.json`, si la re-auditoría post Fases 1-4 aún muestra round-trips altos en
tramos auto. Razones: es la misma mecánica de un bypass (toca las áreas críticas
declaradas del harness: permisos y hooks); el clasificador ve contexto de sesión que un
hook local no ve; y las Fases 1-3 logran la mayor parte por la vía documentada (reglas
`allow`, que Claude Code evalúa primero con parseo de comandos compuestos ya resuelto).

### Housekeeping (se cuelga del primer PR que toque el área)

- `build-settings.ts:129`: el comentario describe drift-watch como "un find ~10ms"; el
  hook se rediseñó a shasum ~25ms precisamente porque find/mtime fallaba en CI
  (`managed-drift-watch.sh:28-41`). Actualizarlo.
- `specs/0015-orquestacion-fuera-del-always-on/tasks.md`: los 8 checkboxes siguen sin
  marcar aunque #582/#583 lo implementaron. Marcarlos.
- `doctor`: aviso para settings pre-0016 — **evaluado y DESCARTADO** (2026-09-07). Medido
  sobre `services--calendar` (rendereado con la navori anterior) contra el build con L1:
  `doctor` ya reporta 65 drifts, `doctor --strict` sale 1, y sus "Próximos pasos" ya dicen
  literalmente `Corre 'navori render --apply'`. Un repo al que le falten las reglas nuevas
  es, por construcción, un repo rendereado por una navori vieja — el estado que doctor ya
  detecta y con el remedio ya impreso. Un segundo detector del mismo estado es una copia
  que se desincroniza, que es justo lo que el `CLAUDE.md` de este repo prohíbe para el
  quality gate. (Límite conocido: el conteo de drift sale de los MARCADORES, y
  `settings.json` no lleva marcador; sería ciego a un cambio que tocara solo ese archivo
  sin mover `cliVersion`. No puede pasar hoy: todo cambio de `settings-base` viaja en un
  release que bumpea la versión y re-estampa cada marcador.)

## 4. Descartado durante la verificación (anti-especulación)

Ideas que salieron de la investigación y **no** entran, con la razón verificada:

1. **`managed-drift-watch` condicional a comandos "con forma de escritura"** — inseguro.
   El probe del guard es sólido para las reglas del guard (:347-351: cada `block` necesita
   un token literal), pero como detector de "este comando no puede escribir" es un hueco:
   `node script.js`, `python -c`, `cp`, `dd` escriben archivos managed sin contener ningún
   token. El watcher existe para el write que se le escapa al guard; eximirlo por esa
   heurística anula su propósito.
2. **`Bash(sed -n *)` en allow** — `sed -n` escribe con el comando `w`; no es read-only.
3. **Hooks `PreToolUse` que aprueban incondicionalmente** (sugerencia recurrente al
   investigar cómo "saltarse el clasificador") — descartado de plano: es un bypass del
   control, no una optimización, y contradice las capas defensivas del propio harness.
   La versión acotada y con opt-in queda como Fase 5 parqueada.
4. **Atacar la latencia unitaria del clasificador** — refutada como causa (§1); ninguna
   fase gasta esfuerzo ahí.
5. **`Bash(rg:*)` en allow (era el T1.1 de esta misma spec)** — inseguro, y su ausencia
   nunca fue un descuido. Las dos mitades de la verificación original eran falsas:
   - *"hoy no existe ninguna regla `rg`"* — cierto, pero **por decisión explícita ya
     fijada en un test**: `build-settings.test.ts:85-88` enumera `find`, `env`, `xargs`,
     `sed`, `awk` y **`rg`** como comandos que *parecen* read-only y pueden EJECUTAR
     código por un flag interno, con la razón anotada en el propio comentario
     (`rg (--pre/--pre-glob run a command)`).
   - *"`rg` no tiene modo de escritura de archivos (read-only puro)"* — falso, y además
     mide la propiedad equivocada: el riesgo no es que escriba, es que **ejecuta**.
     Comprobado en vivo: `rg --pre ./script.sh patrón archivo` corrió el script, que
     escribió un archivo nuevo en disco. Un patrón de permiso matchea por PREFIJO y no
     puede excluir un flag interno, así que `Bash(rg:*)` pre-aprobaría eso.
   Es la misma clase que el T1.3 ya había cachado en `sed -n`: la spec detectó a `sed` y
   se le pasó `rg`. El límite duro que declara `build-settings.ts:34-38` (`bash -c`,
   `node -e`, `python3 -c`, `perl`, red — nunca en allow) cubre este caso.

## 5. Guía operativa de modos (para el usuario; el harness no la impone)

Con las fases anteriores, los tres modos convergen al mismo flujo (escalera nativa/MCP +
shell solo pre-aprobado). Mientras tanto, la elección de modo que mejor le queda a cada
sesión, según lo medido:

- **Investigación / auditoría / spec** → `plan` o `default`: trabajo read-only; las
  nativas y MCP no pagan nada en ningún modo.
- **Implementación interactiva** → `acceptEdits`: los edits nativos son gratis; con la
  Fase 1, el shell del dev-loop deja de pedir prompt.
- **Corridas largas autónomas** → `auto`: sigue siendo el modo correcto para no bloquear
  en prompts (su p50 en comandos pesados ya le gana a acceptEdits); las fases bajan su
  costo por volumen.

## 6. Métricas de éxito (re-auditoría con `navori audit` tras el rollout)

| Métrica | Hoy (corpus) | Objetivo |
|---|---|---|
| % nativas+MCP en tramos auto | 3.0% + 2.2% | ≥ 26% (paridad con acceptEdits) |
| Búsquedas shell puras / hora activa (auto) | 26.8 | ≤ 12 |
| p75 búsqueda en auto | 1.83s | ≤ 1.0s |
| Mediana de hooks por Bash trivial | sin medir (medias bimodales) | ≤ 100ms |
| Señal tool-mix / round-trips por tramo | no existen | emiten en cualquier modo |
| Regresión de seguridad | — | 0 cambios en ask/deny; guard diferencial verde |

## 7. Orden de ejecución

| Lote | Contenido | Depende de |
|---|---|---|
| L0 | Fase 0 (3 sesiones A/B medidas — no es PR) | navori ≥0.7.2 rolled out |
| L1 | Fase 1 + housekeeping | — (paralelo a L0) |
| L2 | Fase 2 (doctrina + texto de señal) | resultados de L0 |
| L3 | Fase 3 (guard git read-only + medición de hooks) | — |
| L4 | Fase 4 (señales por tramo + tool-mix) | — |
| — | Fase 5 | re-auditoría post L1-L4, solo si el gap persiste |
