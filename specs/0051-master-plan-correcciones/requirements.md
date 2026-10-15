# Correcciones del plan maestro tras auditoría — Requirements

**Estado:** borrador · **Fecha:** 2026-10-13 · **Base revisada:** `origin/dev` `47c52fa5` (incluye la
spec 0049 implementada: PRs #1313, #1316 y #1318). El PR de esta spec apunta a `dev`.

## Contexto

Antes del primer uso real de `navori master`, una auditoría de solo lectura (2026-10-13), con tres
auditores y reproducciones en repos temporales, encontró defectos que dejan checks en rojo falso,
pierden contenido escrito por el agente, atoran etapas sin salida o hacen que el skill y el CLI se
contradigan. La spec 0049 ya está implementada en `dev` y cubrió la recuperación del render de
`init`, la regeneración de `STATUS.md` tras `advance` con su mensaje de reparación,
`architectContext` en el skill y la redacción del modo en etapas posteriores; esos puntos no se
repiten aquí. Cada `R<n>` de abajo se re-verificó contra `dev` y sigue abierto ahí.

Además, esta spec **cambia comportamiento implementado por 0049**: en `dev`, `readMasterStatus`
mete la evidencia huérfana en `blockers` (y por tanto en `closable` y en `STATUS.md`) y
`renderStatusMd` agrega `commitsBehind`, `orphan` y "revalidar con…" a cada criterio. Decisión del
usuario (2026-10-13): `STATUS.md` no lleva ningún dato que dependa de `HEAD`; el bloqueo por
evidencia huérfana vive solo en `navori master close` y en `navori master status --json` (R6).

Decisión del usuario (2026-10-13): spec separada de 0049, basada en `dev`, una sola entrega con
commits atómicos.

Fuentes estables (símbolos): `packages/cli/src/lib/primitives/eol.ts` (`normalizeEol`,
`detectEol`), `packages/cli/src/lib/master/templates.ts` (`splitTemplateSections`,
`printTemplate`, `TEMPLATE_NAMES`), `packages/cli/src/lib/master/checks.ts` (`runMasterCheck`,
`runMasterAdvance`, `checkMasterDocument`, `checkClosedStage`),
`packages/cli/src/lib/master/check-part.ts` (`FIELDS`), `packages/cli/src/lib/master/status.ts`
(`readMasterStatus`, `renderStatusMd`, `writeMasterStatus`), `packages/cli/src/lib/master/part.ts`
(`changeMasterPart`), `packages/cli/src/lib/master/close.ts` (`runMasterClose`, `closeBlockers`),
`packages/cli/src/commands/master.ts` y el skill canónico
`packages/core/core-assets/skills/master-plan.md`.

## Requirements (EARS)

### Lectura de documentos
- **R1** — WHEN un documento del plan maestro usa fin de línea CRLF, the system SHALL reconocer sus
  secciones, tablas y la tabla de Integridad de `CLOSURE.md` igual que con LF.
- **R2** — WHEN `context/raw/` contiene archivos ocultos (nombre que empieza con `.`, p. ej.
  `.DS_Store`), the system SHALL excluirlos de la verificación de filas de `INTAKE.md`.
- **R3** — The system SHALL aceptar en `navori master check --part` las etiquetas de campo de tarea
  en español y en inglés (las mismas que usan las plantillas `tasks` de cada idioma), y SHALL
  nombrar un campo faltante con la etiqueta del idioma declarado en `navori.config.json`.

### Partes y abandono
- **R4** — IF `parts.json` no declara ninguna parte, THEN `navori master advance` hacia `mastered`
  SHALL fallar nombrando la causa.
- **R5** — WHEN una etapa en fase `mastered`, `ux` o `executing` no tiene partes (`parts.json`
  ausente o con `parts` vacío), the system SHALL permitir `navori master close --abandon` con
  razón, para que una etapa atorada tenga salida. Con al menos una parte, el abandono en esas fases
  sigue rechazado, y `--convert` sigue limitado a las fases tempranas.

### Estado derivado estable
- **R6** — The system SHALL generar `STATUS.md` sin ningún dato que dependa de `HEAD` (commits de
  atraso, evidencia huérfana, sugerencias de revalidar, ni un bloqueo o un `Cerrable:` derivado de
  ellos), de modo que un commit ajeno al plan o un squash-merge no lo vuelvan distinto de su render.
  La evidencia huérfana en partes sin disposición SHALL exponerse en `evidenceBlockers` de
  `navori master status --json` y SHALL seguir bloqueando `navori master close`; `commitsBehind` y
  `orphan` SHALL seguir en `--json` y en `CLOSURE.md`. Decisión del usuario (2026-10-13); enmienda
  el comportamiento de 0049 R11/R12.
- **R7** — WHEN cualquier invocación de `navori master part` termina con éxito y cambió
  `parts.json`, the system SHALL regenerar `STATUS.md`.
- **R8** — IF la regeneración de R7 falla después de escribir `parts.json`, THEN the system SHALL
  registrar el evento de auditoría de la mutación, cuando esta lo emite (hoy `--accept`), y SHALL
  informar que `parts.json` quedó actualizado y que la reparación es `navori master status`, con
  la misma forma de mensaje que ya usa `navori master advance` ("Repare con 'navori master
  status'; no repita …").
- **R9** — IF `navori master check` detecta que `STATUS.md` o la región `navori:master-parts` de
  `MASTER.md` difieren de su render, THEN the system SHALL nombrar `navori master status` como la
  reparación en el mismo mensaje.
- **R10** — WHEN `navori master status` inserta por primera vez la región `navori:master-parts` en
  la sección de entrega en partes, the system SHALL dejar el encabezado, la región y debajo el
  cuerpo previo de esa sección (incluida la línea `Origen:`), con el fin de línea que ya usa el
  archivo.
- **R11** — IF la sección de entrega en partes tiene un marcador de apertura de la región sin su
  cierre, THEN `navori master status` SHALL fallar nombrando el marcador, sin escribir `MASTER.md`.

### Plantillas
- **R12** — The system SHALL ofrecer `navori master template parts`, en español e inglés, con un
  ejemplo de `parts.json` que valide contra su esquema.
- **R13** — WHEN se imprime una plantilla sin secciones `##`, the system SHALL imprimir su contenido
  completo, de modo que `navori master template intake` no salga vacío. La salida de las
  plantillas con secciones no cambia.

### Argumentos del CLI
- **R14** — IF `navori master check --part` se invoca sin identificador de parte (ausente, vacío o
  solo espacios), THEN the system SHALL fallar con un error de uso, sin correr otro check.
- **R15** — WHEN `navori master init <slug>` se invoca con otra etapa activa, the system SHALL
  escribir en stderr que el slug se ignoró y cuál es la etapa activa, conservando el exit 1.
- **R16** — IF `navori master close --reason` se invoca para un cierre entregado, THEN the system
  SHALL rechazarlo antes de cualquier escritura, en ambos workflows (`legacy` y `deliveries`),
  porque la razón solo aplica a abandono o conversión.

### Skill
- **R17** — The skill canónico `master-plan` SHALL indicar `navori master check --part P<n>`, que el
  código probado se commitea antes de `--accept`, que `parts.json` se escribe a partir de
  `navori master template parts`, que tras marcar tareas de una spec se corre
  `navori master status`, y que ofrecer el cierre exige `closable` verdadero y `evidenceBlockers`
  vacío.

## Trazabilidad

Cada `R<n>` termina en al menos una tarea y una prueba nombrada en `tasks.md`, y cada prueba lleva
`// Covers: R<n>` sobre el caso.
