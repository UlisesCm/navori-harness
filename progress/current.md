# Sesión actual

**Estado: release 0.8.7 en publicación (2026-09-15).** El bump de
`packages/cli/package.json` a 0.8.7 y el re-render obligatorio del espejo (paso 2 del README) van
en la branch `chore/release-0.8.7`, con PR a `main`; el tag lo pone `release-tag.yml` al aterrizar
y el `npm publish` desde `packages/cli` sigue siendo manual.

**El programa de cableado va 7 de 8 cerrados.** Aterrizaron #775 y #778 el 13, y entre el 14 y el
15 los siete restantes: #763 (#787), #782 (#788), #779 (#789), #776 (#790), #777 (#791), #764
(#792), #771 (#793) y #769 (#794). **Queda abierto solo #774** — tres canales de salida que el
evento no entrega y dos matchers de `SessionStart` que pierden sources; está trazado, sin
implementar.

**Siguiente paso explícito, en este orden:**

1. **Publicar 0.8.7** — mergear el PR, dejar que `release-tag.yml` ponga el tag, y `npm publish`
   desde `packages/cli`. Nada del programa de cableado llega al parque hasta que esto salga: ese
   es justo el defecto que el programa diagnosticó.
2. **#774** — el último del programa. Y **#760**, el otro issue abierto (search-before-save contra
   los topic_keys duplicados).

**Fuera de este repo, pendiente de la jornada:**

- **PR #254 de `alertaciudadana_app` sigue abierto.**
- **`alertaciudadana_backend` tiene 55 archivos staged sin commitear.**

**2026-09-13 (tarde) — revisión de los logs de 0.8.6.** Solo **4 sesiones** corrieron con
`navoriRendered=0.8.6`, y 2 puntúan con el corte del minero (>= 3 oportunidades). La línea base
(`docs/research/linea-base-delegacion-0.8.5.md`) pide **20 sesiones** antes de concluir, así que
no hay comparación posible todavía — decirlo es el punto, porque leer la muestra chica es el
error exacto que produjo el hallazgo falso de #705. La forma sí se repite: una sesión 17/17 con
20 agentes, y dos sesiones con CERO agentes que abrieron 5 PRs entre las dos.

**Dos bugs del instrumento, abiertos hoy.** Los dos bloquean el "después" del experimento:

1. **#763** (`bug`, `priority:high`) — la caché negativa de `resolveSessionLog`
   (`packages/cli/src/lib/audit/collect.ts:330`) deja sin tercera fuente a toda sesión que
   arranque con el receptor ya vivo. Tras 18h de uptime el healthz canta
   `{"written":5796,"discarded":5119,"sessions":1}`: escribió en UNA sesión de 70. El comentario
   del código asume que el log nace en `SessionStart`; nace en `UserPromptSubmit`, y los hooks de
   `SessionStart` ya exportaron antes. **Mientras no se arregle, las sesiones nuevas siguen sin
   eventos OTel**, así que R12/R13 de la spec 0021 quedan vacías en la práctica.
2. **#764** (`bug`, `priority:medium`) — `repo=$(basename "$cwd")` parte el log de una sesión en
   un repo fantasma cuando el cwd es un worktree de agente (`.claude/worktrees/<id>`). Además
   puede desviar los eventos OTel al archivo que el reporte no lee, por el orden de `readdir`.

El reporte de rango de esa revisión:
`~/.navori/audits/navori-harness/ranges/2026-09-12--2026-09-13/report.md`.

**La Fase 1 tiene su medición**, y es la que faltaba para decidir: con el corte en el día que entró
el guard, el parque pasó de **6.6% a 40.7%** de búsquedas por la vía buena — mismo instrumento en
los dos lados (`mine-search-routing.py --desde|--hasta`). En la misma ventana `git grep` subió
**9.6× su tasa**: el hábito migró a la vía que ninguna capa veía, ya redirigida por #739. La
próxima ventana dirá si cierra.

**Del carril de ruteo (detrás del release en la cola):** #743 — el rollout del parque, con la
premisa reescrita por el dato.
`alertaciudadana_app` (972 búsquedas) y `_backend` (523) YA tienen tgrep y siguen en ~0.3%, porque
se rindieron con 0.8.4 y tienen el wrapper sin el guard. La palanca es `render --apply` a 0.8.5, no
`navori add tgrep`, y son dos PRs fuera de este repo.

Y **#763 antes de volver a medir 0.8.6**: cada sesión que pasa con el bug vivo es una sesión sin
tercera fuente, y no se recupera — los eventos emitidos mientras nadie los escribe se pierden.

Issues abiertos que NO son de este carril: #705, #728, #730. (#736 cerró con #751.)

**Abierto por #752, sin dueño asignado** — ninguno bloquea nada:

1. **Página de EXTENDING en el website.** Las docs del sitio salen de `src/content/commands.ts`
   (una por comando) y esto no es un comando: pide decidir estructura nueva, por eso quedó fuera.
2. **Normalizar los `Status` de las specs.** Once de 22 no lo declaran y 0001/0002 siguen en
   `proposed` con su contenido en producción. `DIRECTION.md` ya explica cómo leerlos mientras
   tanto; arreglarlos es la primera señal que lee quien llega nuevo.

## ⛔ MORATORIA DE DOCTRINA — vigente hasta que cierre la Fase 5

**No se escriben ni se reescriben bloques de doctrina** (`core-assets/managed/`, `agents/`,
`skills/`) con el objetivo de que el modelo delegue, rutee o active más. Si esa idea aparece en
una sesión futura —tuya o de un agente— la respuesta es: **ya se probó cuatro veces y está
refutado.** Lee `docs/research/activacion-subagentes-y-skills.md` § "La remedición (2026-09-11,
n=16)" antes de proponer nada.

Los tres eslabones están medidos: la doctrina **llega** (7,448–8,657 bytes como cuerpo), se
**entiende** (#668) y se **nota** (`routing-watch` emitió su aviso). La conducta **no cambió**:
tras el aviso, 219 eventos, todos `Bash`, cero subagentes.

La moratoria **no** cubre: corregir doctrina falsa o desactualizada, ni recortarla. Cubre
**agregar o reescribir prosa para cambiar conducta**.

## El plan

Tesis que lo ordena: **en este harness lo mecánico funciona y lo sugerido no.**
`guard-destructive` 14/14 bloqueos · `quality-gate-pre-commit` 7/7 · managed blocks con drift 0
en 22 repos. Contra: aviso de ruteo 0/1, doctrina de búsqueda 4.0%, activación 24%. La línea
divisoria es exacta, y los cuatro releases anteriores parcharon el lado equivocado.

| Fase | Qué | Estado |
|---|---|---|
| **0** | Cerrar el ciclo viejo: corregir la research doc, abrir issues del instrumento, moratoria | ✅ **#677** |
| **1** | Mecanismo 1 — `guard-search-routing.sh`: bloquea búsqueda por shell y redirige al wrapper | ✅ **#679** + tgrep activo en los dos alertaciudadana |
| **2** | Mecanismo 2 — `routing-watch` de `notify` a gate, con override contable en archivo centinela. **Exige spec 0021** (toca hooks + área crítica) | pendiente |
| **3** | Mecanismo 3 — `UserPromptSubmit` con tabla de disparadores de skill (`project.skillTriggers`) | pendiente |
| **4** | Reparar el instrumento (#673, #674) + calibración manual de 20 no-activaciones | paralela a 1–3 |
| **5** | Re-medir y **decidir**, con criterios pre-registrados | semana 2 |

**Criterio de salida de la Fase 1 — CORREGIDO antes de correr el experimento, no después.** El
">60% global" se escribió sobre la línea base vieja (4.0%) y sin conocer el techo del hook. El
criterio honesto es el embudo, que no tiene denominador discutible:

> **De las búsquedas que el hook bloquea, ¿qué fracción se reintenta por el wrapper?**

Secundario: `bueno%` global **> 40%** sobre la línea base corregida de **7.4%** (2,761 búsquedas
reales; el 4.0% salía de un denominador con 3,958 pipes y 2,053 extracciones dentro).

Y hay un experimento natural que no existía: **los dos alertaciudadana tienen el wrapper sin
ningún hook todavía**. Lo que suban por sí solos es la línea base de adopción voluntaria contra
la que se mide el bloqueo.

**El pre-registro es parte del método, no ceremonia.** El 57% se publicó mirando los datos
primero; por eso aguantó cinco sesiones y no dieciséis.

## Lo primero al retomar

1. **El guard de ruteo ya bloquea en este repo.** #679 está en `main`, así que el dogfood
   empezó: si el diseño está mal, se siente aquí antes que en ningún lado. Primera medición útil
   —`python3 scripts/mine-search-routing.py navori-harness`— contra la línea base de 17.3%.

   **Y el squash de #677 volvió a dejar fuera un push posterior**, igual que el #660: la entrada
   de bitácora de esta jornada no entró en ese merge y se rescató aparte. La regla se confirma
   por segunda vez — verifica `main` POR CONTENIDO, nunca por el título del PR.

2. **Fase 2 — el gate de delegación. Exige spec 0021 antes de tocar código**: toca hooks y área
   crítica, y es la regla de este harness. Diseño ya perfilado: `routing-watch` escala de
   `notify` a bloqueo del siguiente Edit/Write, con override declarado en un archivo centinela
   (`.claude/progress/inline-override`) que queda registrado **con su razón** en el log de audit.
   No prohíbe R1 — lo vuelve contable. Depende de un clasificador compartido de "archivo fuente
   no trivial" que descuente lo generado, que es también el fix de #674: una definición, dos
   consumidores.

3. **No abrir frentes nuevos de doctrina** (ver moratoria).

2. **Issues del instrumento abiertos hoy**: #673 (`subagent-stop-handoff` infla ~10×: 518 vs 49
   `Task` reales), #674 (la heurística cuenta archivos generados como lógica — por eso el 24% es
   un piso), #675 (`audit --start` acepta un id fantasma; `session-p.log` en bonum-nexus está
   pendiente de borrar, decisión del usuario), #676 (el render culpa a `config.harness` cuando la
   causa es el recorte 0018-minimal).

3. **El working tree sigue sucio a propósito.** `docs/inspiration.md` (+109) y los dos untracked
   de `docs/research/` (`awesome-harness-engineering.md`, `claude-code-harness-lessons.md`) son
   de otro ciclo. **Es la decisión más vieja pendiente**: ya sobrevivió a tres sesiones.

4. **Los reportes de la auditoría viven en `.claude/progress/` (gitignored)**, así que no viajan
   en git: `audit_consolidado_navori-audit.md`, `audit_deep_navori-audit.md` y
   `plan_navori-audit.md`. Si se quieren durables, hay que moverlos.

## Deuda del `audit` que la auditoría dejó priorizada

Con los 4 altos shippeados en 0.8.4, y ahora con #673/#674 al frente de la cola por ser
precondición de todo lo demás:

- **Quick wins (S/XS)**: M3 separar `logParseErrors` de `parseErrors`; M4 acumular los
  parseErrors de transcripts de subagentes; M7 colapsar re-emisiones de `permission-mode`; M9
  leer solo `permissionMode`.
- **Con diseño**: M1 descontar Bash allow-listed de `classifier-round-trips`; M2 carril
  "wrapper" en `tool-mix`; M5 canario de drift semántico; M6 anclar `findVerdict`.
- **Señales del host sin consumir**: `toolUseResult.agentId` (**ahora es el fix de #673**),
  `isCompactSummary`, `system/turn_duration`, `attributionSkill`, la fase `PermissionDenied`.
- **Limpieza**: B3 un solo `k()`.

Decisiones humanas abiertas: B2 (repos homónimos comparten carpeta de audits), B6 (los prompts
viajan en claro en el log), y si `MCP_HINTS` debe derivarse de `.mcp.json`.

## Pendiente fuera de este repo

1. **Mergear los rollouts de 0.8.4**: moonar #137 (CI verde) y navori-health #55.
2. **#661 sigue abierto a propósito.** Los dos que moverían la aguja —`alertaciudadana_app` y
   `alertaciudadana_backend`, 2,094 búsquedas y 0% wrapper— exigen PR por repo. **La Fase 1 los
   vuelve la prueba principal**, así que la decisión de habilitar tgrep ahí deja de ser opcional.
3. `bonum-webapp` tiene 43 archivos de `.claude/` trackeados, contra la convención de los repos
   `/bonum`. Puede ser deliberado; conviene decidirlo a propósito.
4. `~/.claude/skills/` quedó solo con `systematic-debug` (las otras dos duplicaban `leader.md` y
   `reviewer.md`; respaldo en `~/.claude/backups/cleanup-20260910/`). Candidata a promoverse a
   navori: sus 4 fases bloqueantes y el diagnostic instrumentation pattern no están cubiertos por
   `debug-error` ni `loop-back-debug`.
