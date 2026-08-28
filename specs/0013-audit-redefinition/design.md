# Redefinición de `navori audit` — Design

## Approach

Tres cambios independientes que comparten el mismo archivo de log, y por eso viven en una
sola spec: el log deja de ser un índice de marcado y pasa a ser el registro de eventos del
harness.

**1. La activación se saca del texto.** Hoy `audit-mode-trigger.sh` decide por subcadena
sobre el prompt y le pide al agente que pregunte. Eso confunde *hablar de* la feature con
*invocarla* — y ninguna heurística sobre lenguaje natural distingue las dos. La activación
pasa a ser exclusivamente `navori audit --start <id>`, invocada por el operador o pedida en
lenguaje natural al agente. El hook conserva su otra mitad, que sí es correcta: registrar
el prompt cuando el modo ya está activo (R3, R4).

**2. Los hooks se auto-registran a través de un helper compartido.** Un `SKILL`-style
partial (`hooks/lib/audit-log.sh`) que cada hook managed hace `source` y llama una vez. Se
elige el helper sobre diez implementaciones independientes porque el formato del evento es
un contrato del lector (`parse.ts`): diez copias de un `jq -cn` derivan, y el lector se
entera cuando ya perdió datos. El helper es no-op sin log presente, así que fuera de
audit-mode el costo es un `[ -f ]` (R5, R6).

**3. El reporte gana una ficha por agente.** Este es el cambio con menos riesgo y más
valor visible: `AgentRun` ya captura tipo, modelo, descripción, tokens, arranque,
`toolCounts`, `skillsRead`, fricción, `repeatedCommands`, veredicto, `durationMs` y
`overlapsWith`. El trabajo está en `report.ts` (render) más dos correcciones en `parse.ts`
(MCP agrupado, skills con procedencia).

**Descartado — granularidad por paso dentro del agente.** Se evaluó emitir una fila por
turno/tool-call con su costo incremental. Localiza mejor un pico de gasto, pero exige
parseo nuevo sobre el transcript y produce reportes que nadie lee entero. La ficha por
agente cubre la pregunta real ("¿qué me costó este subagente y con qué trabajó") sobre
datos que ya existen.

**Descartado — declaración de skills por el propio agente.** Sería la única vía para
captar una skill aplicada sin abrir su archivo, pero un audit que pregunta al auditado
verifica nada: mide honestidad, no comportamiento.

## Components

- `packages/cli/src/commands/audit.ts` — valida las banderas antes de actuar; falla
  ruidoso cuando `--start`/`--stop` llegan vacías. Cubre R2.
- `packages/cli/src/lib/audit/paths.ts` — constructores de las rutas nuevas
  (`sessions/<fecha>-<id>/`, `ranges/<desde>--<hasta>/`), con la misma validación de id que
  hoy protege el log. Cubre R15, R16.
- `packages/cli/src/lib/audit/parse.ts` — agrupación MCP por servidor; procedencia de
  skills y descarte de las vistas por listado; lectura de los eventos `hook` del log.
  Cubre R9, R10, R11 y la mitad lectora de R5.
- `packages/cli/src/lib/audit/model.ts` — `AgentRun` gana `mcpCalls`, `skills` (con
  procedencia) y `hookEvents`; `AuditReport.schemaVersion` pasa a `2`. Cubre R8, R17.
- `packages/cli/src/lib/audit/report.ts` — render de la ficha por agente, del desglose de
  tiempo y del resumen corregido. Cubre R8, R12, R13, R14.
- `packages/core/core-assets/hooks/lib/audit-log.sh` (nuevo) — el helper compartido.
  Cubre R5, R6, R7.
- `packages/core/core-assets/hooks/*.sh` — los ocho hooks managed que no son del audit
  (`guard-destructive`, `managed-drift-watch`, `precompact-session-summary`,
  `quality-gate-pre-commit`, `session-start-context`, `stop-verify-reminder`,
  `subagent-stop-handoff`, `worktree-reclaim`) hacen `source` del helper y lo llaman.
  Cubre R5.
- `packages/core/core-assets/hooks/audit-mode-trigger.sh` — pierde la detección por
  subcadena y conserva el registro de prompts. Cubre R3, R4.

## Decisions

- **El helper vive en `hooks/lib/` y no dentro de `_partials/`** — `_partials` compone
  texto en tiempo de render; esto es un archivo shell que se `source`a en tiempo de
  ejecución. Mezclarlos haría que un cambio de render pudiera romper un hook en marcha.
- **El evento `hook` lleva `ms` propio, no derivado de timestamps** — dos eventos
  consecutivos pueden pertenecer a hooks distintos de la misma fase; restar sus `ts` mide
  el hueco entre ellos, no la duración de ninguno.
- **`--stop` sigue siendo no idempotente por diseño, pero lo dice** — sellar dos veces
  añade un segundo evento `stop`; el log es append-only y reescribirlo para "limpiar"
  rompería su garantía. El lector toma el primer `stop` y el reporte nota los extras.
- **Un id de sesión inválido sigue rechazándose en `paths.ts`** — las rutas nuevas se
  componen igual que el log, así que heredan el guard de #503 en vez de re-validar en cada
  llamador.
- **La estructura vieja no se migra** — mover archivos bajo `~/.navori` para ordenar es un
  borrado sin petición del usuario. Las dos estructuras conviven; la nueva es la que se
  escribe (R18).

## Contracts

El evento `hook` que el helper escribe y `parse.ts` lee:

```json
{"ts":"2026-08-28T02:09:04Z","event":"hook","name":"guard-destructive",
 "phase":"PreToolUse","tool":"Bash","verdict":"block","ms":9,
 "reason":"rm -rf con ruta absoluta"}
```

`name`, `phase`, `verdict` y `ms` son obligatorios. `tool` y `reason` son opcionales: hay
fases sin tool asociada (`SessionEnd`) y veredictos sin motivo (`allow`). Un evento al que
le falte un campo obligatorio se cuenta en `parseErrors` y no rompe la lectura — misma
tolerancia que el log ya tiene con las líneas malformadas.

Estructura de salida (R15, R16):

```
~/.navori/audits/<repo>/
├─ sessions/<YYYY-MM-DD>-<id8>/{session.log, report.json, report.md}
└─ ranges/<desde>--<hasta>/{report.json, report.md}
```

## Failure modes

- **Un hook falla al registrar** (disco lleno, log borrado a media sesión): el helper
  vuelve 0 sin escribir y el hook sigue su curso. El registro es observación, nunca puede
  ser la causa de que una sesión falle (R7). Es la misma regla fail-open absoluta que ya
  gobierna `audit-mode-trigger.sh`.
- **Log con eventos de una versión más nueva del formato**: se cuentan en `parseErrors` y
  el reporte los declara, en vez de descartarlos en silencio.
- **Sesión sin sellar** (la sesión murió sin `SessionEnd`): sigue siendo auditable; el
  reporte marca la sesión como no sellada en vez de excluirla.
- **Escritura concurrente de dos hooks**: el log es O_APPEND y cada evento es una línea
  completa escrita de una vez, que es la garantía que ya sostiene el log actual con
  subagentes en paralelo.

## Migration

`schemaVersion` pasa de `1` a `2` (R17). Los consumidores del JSON son internos, así que
no hay compatibilidad hacia atrás que sostener; el número sube para que un lector futuro
distinga un reporte con fichas de uno sin ellas.

Los archivos con el layout viejo (`audit-<desde>-<hasta>.{md,json}`,
`session-<id>.log` sueltos en la raíz del repo) se quedan donde están y se siguen leyendo
para generar reportes; solo la escritura usa el layout nuevo (R18).

## Testing strategy

Cada prueba responde a un riesgo nombrado arriba, no a una cuota:

- **La falla abierta que originó la spec**: `--start` y `--stop` con cadena vacía deben
  salir distinto de 0 sin escribir reporte. Es el defecto que hizo que un operador leyera
  un sellado inexistente como éxito.
- **El fail-open del helper**: con el log ausente y con el log no escribible, el hook
  conserva su código de salida y su stdout. Un audit que rompe sesiones es peor que uno
  que no existe.
- **La procedencia de skills**: un agente que lista el índice de skills no debe acumular
  once usos; uno que abre un `SKILL.md` concreto sí debe registrar uno, y la ficha debe
  decir por cuál de las dos rutas lo supo.
- **El solapamiento**: cinco agentes concurrentes de 20 minutos no suman 100 minutos de
  reloj. El agregado debe distinguirlo.
- **Las rutas nuevas**: un id path-shaped no debe componer una ruta fuera del audit root,
  igual que hoy protege el log (#503).

## NOT in scope

- **Granularidad por paso dentro del agente.** Descartada arriba; si más adelante hace
  falta, entra por el JSON antes que por el Markdown.
- **Migrar o borrar los reportes viejos.** Explícitamente fuera (R18).
- **Medir hooks de plugins.** Hoy ningún plugin envía hooks propios
  (`packages/plugins/*/assets/hooks/` no existe); cuando alguno lo haga, hereda el helper
  sin cambios en el lector.
- **Reportar el contenido del contexto inicial de un agente.** El transcript registra su
  tamaño, nunca su contenido; eso es un límite del host, no una tarea pendiente.
- **Atribuir costo en dinero.** El reporte cuenta tokens; convertirlos a moneda exige una
  tabla de precios por modelo que envejece sola.
