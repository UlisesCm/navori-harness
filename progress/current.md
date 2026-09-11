# Sesión actual

**Estado:** **0.8.4 publicado y rodado** — npm `latest: 0.8.4`, tag `v0.8.4` sobre `e8b2c54`,
sitio en `v0.8.4`, y el rollout abierto en moonar (#137) y navori-health (#55). **Arrancó el
plan de mecanización** (abajo): Fase 0 en curso.

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
| **0** | Cerrar el ciclo viejo: corregir la research doc, abrir issues del instrumento, moratoria | **en curso** |
| **1** | Mecanismo 1 — `guard-search-routing.sh`: bloquear búsqueda de contenido por shell y redirigir al wrapper | siguiente |
| **2** | Mecanismo 2 — `routing-watch` de `notify` a gate, con override contable en archivo centinela. **Exige spec 0021** (toca hooks + área crítica) | pendiente |
| **3** | Mecanismo 3 — `UserPromptSubmit` con tabla de disparadores de skill (`project.skillTriggers`) | pendiente |
| **4** | Reparar el instrumento (#673, #674) + calibración manual de 20 no-activaciones | paralela a 1–3 |
| **5** | Re-medir y **decidir**, con criterios pre-registrados | semana 2 |

**Criterio de salida de la Fase 1, pre-registrado antes de mirar datos:** una semana de sesiones
reales en repos con el hook → **wrapper+nativo > 60%** (línea base: 4.0% sobre 4,665 búsquedas).
No 100%: parte del shell actual es extracción legítima de archivo ya conocido, y ese techo no se
conoce hasta la Fase 4.

**El pre-registro es parte del método, no ceremonia.** El 57% se publicó mirando los datos
primero; por eso aguantó cinco sesiones y no dieciséis.

## Lo primero al retomar

1. **Seguir el plan por fases.** No abrir frentes nuevos de doctrina (ver moratoria).

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
