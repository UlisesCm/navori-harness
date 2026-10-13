# Correcciones del plan maestro tras auditoría — Design

**Estado:** borrador, revisado tras el challenge (`solution_review_0051-master-plan-correcciones.md`)
· **Fecha:** 2026-10-13 · **Base revisada:** `origin/dev` `47c52fa5` (0049 implementada: #1313 E1,
#1316 E2, #1318 cierre documental). El PR apunta a `dev`.

**Área crítica.** `writeMasterStatus` escribe `STATUS.md`, la región de `MASTER.md` e `INDEX.md` en
el repo del usuario. R7 extiende esas escrituras a `navori master part`. No se tocan settings,
permisos, hooks, marcadores managed ni el guard anti-rollback.

## Approach

Cada defecto se corrige en la pieza que ya es su dueña. No hay esquemas, flags ni dependencias
nuevas.

Hay dos piezas nuevas, ambas mínimas:

- **Un helper de EOL sin dependencias.** La normalización de fin de línea ya estaba copiada dos
  veces y R1 pedía una tercera; con eso se cumple la regla de tres.
- **Un campo `evidenceBlockers` en `MasterStatus`** (R6).

Lo que dejó 0049 se **reusa o se corrige**, no se duplica:

- Regenerar el estado tras `advance` ya está en `runMasterAdvance`. R7 y R8 aplican lo mismo a
  `part`, con el mensaje de reparación extraído a un helper compartido.
- El bloqueo por huérfana de 0049 R11 sale de `blockers` y pasa a `evidenceBlockers` (R6).

### Lectura (R1-R3)

- **CRLF (R1).** Se crean `normalizeEol` y `detectEol` en `packages/cli/src/lib/primitives/eol.ts`.
  Ese módulo no importa nada, así que no puede formar ciclos. Los usan:
  - `splitTemplateSections`. Con eso basta para encabezados, tablas e Integridad, porque todos los
    parsers de secciones pasan por ahí.
  - Las comparaciones exactas de `runMasterCheck`: `readStageFile` y la lectura de `STATUS.md`.
  - `sha256Normalized` (`checks.ts`) y `hash` (`close.ts`), que dejan sus copias locales. La
    semántica es la misma, así que los hashes no cambian.
  - No se toca `normalize` de `lib/render/marker.ts`: recorta además el espacio final y pertenece
    al render.
- **Archivos ocultos (R2).** En `context/raw/` se ignora todo nombre que empiece con `.`.
- **Etiquetas de `check --part` (R3).** Se acepta la unión es+en por clave canónica. El faltante se
  nombra en el idioma declarado.

### Partes y abandono (R4, R5)

- `checkMasterDocument` exige al menos una parte.
- `runMasterClose` sigue rechazando un abandono tardío (D10 de 0034), salvo cuando la etapa no tiene
  partes. `--convert` no cambia.

### Estado derivado estable (R6-R11)

- **R6: lo que cambia del comportamiento de 0049 en `dev`.**
  - **`readMasterStatus`.** Hoy mete `"<P>.<A>: evidencia huérfana; revalidar con …"` en `blockers`
    para partes sin disposición. Ese texto pasa a un campo nuevo, `evidenceBlockers: string[]`, con
    el mismo contenido. `blockers` y `closable` ya no lo incluyen y vuelven a no depender de `HEAD`.
  - **`renderStatusMd`.** Deja de escribir `· commitsBehind=N`, `· orphan` y
    `· revalidar con '…'`. Renderiza `Cerrable:` desde `closable` y "## Bloqueos" desde `blockers`,
    que ahora son estables.
  - **`runMasterClose`** (entrega legacy, después de `closeBlockers` y de `closable`). Lanza
    `no se puede cerrar; evidencia huérfana:\n<evidenceBlockers>` si el arreglo no está vacío,
    antes de cualquier escritura. `closeBlockers` sigue siendo una función pura de fase y partes
    efectivas: no recibe `HEAD`.
  - **`--json`.** Expone `evidenceBlockers`. `acceptance[].commitsBehind` y `orphan` no cambian.
  - **`CLOSURE.md`.** Conserva `commitsBehind` y `orphan`: es una foto fija al cierre.
  - **0049 R12** ("mostrar su antigüedad y ofrecer revalidarla"). Se cumple con `--json`,
    `CLOSURE.md` y el paso del skill que, antes de cerrar, muestra la evidencia huérfana o atrasada
    y ofrece revalidarla. Ese paso ya existe en "Evidencia de aceptación".
- **R7 y R8.** El subcomando `part` sigue este orden: mutación durable, después el evento de
  auditoría, después la regeneración. Si la regeneración falla, el mensaje sale del helper que se
  extrae del `catch` de `runMasterAdvance`.
- **R9.** Los mensajes de drift de `check` nombran `navori master status`.
- **R10 y R11.** La primera inserción de la región tiene una forma definida y usa el EOL del
  archivo. Un marcador de apertura huérfano hace fallar el comando sin escribir nada.

### Plantillas (R12, R13)

Se agrega la plantilla `parts` (`parts.md` y `en/parts.md`). No tiene secciones `##`: lleva un H1,
instrucciones, un bloque ```json de ejemplo y una línea por campo. `printTemplate` imprime el
contenido completo solo cuando una plantilla no tiene secciones; las demás salen igual que hoy.

### CLI (R14-R16) y skill (R17)

- Los argumentos se validan en el comando, o en `runMasterClose` antes de cualquier escritura.
- El skill se corrige con ediciones de texto. Los espejos se regeneran con
  `navori render --apply`.

### Opciones descartadas

- **Comparar en `check` un render normalizado.** `STATUS.md` mostraría valores que el check ignora.
- **Mantener el huérfano en `blockers` y solo quitar los sufijos.** Un squash-merge pondría rojo
  `check`. Es justo lo que la decisión del usuario prohíbe.
- **Que `closable` en `--json` incluya el huérfano y `STATUS.md` renderice otro booleano estable.**
  Hacen falta dos campos con casi el mismo nombre. `renderStatusMd` ya no sería una proyección uno
  a uno del estado.
- **Degradar el drift a aviso.** Se pierde la detección de ediciones a mano.
- **Escribir `Origen: parts.json` en la región.** Cambia todas las regiones existentes, y
  `parts.json` no es un origen válido según R30.
- **Un asset `parts.json` crudo.**
- **Documentar el esquema en el skill.**
- **`--abandon` en cualquier fase.**
- **Imprimir el preámbulo de todas las plantillas.**
- **Etiquetas estrictas por idioma.**

## Components

- `packages/cli/src/lib/primitives/eol.ts` (nuevo, ya en curso en M1): `normalizeEol` y
  `detectEol`. Covers R1, R10.
- `packages/cli/src/lib/master/templates.ts`:
  - `splitTemplateSections`. Covers R1.
  - `printTemplate`. Covers R13.
  - `TEMPLATE_NAMES` incluye `parts`. Covers R12.
- `packages/cli/src/lib/master/checks.ts`:
  - `readStageFile`, la lectura de `STATUS.md` y `sha256Normalized`. Covers R1.
  - `checkTranscribed`. Covers R2.
  - `checkMasterDocument`. Covers R4.
  - Mensajes de drift de `runMasterCheck`. Covers R9.
  - `runMasterAdvance` arma su mensaje con `derivedWriteFailure`, sin cambio de texto.
- `packages/cli/src/lib/master/check-part.ts` (`FIELDS`, `validatePartSpec`, `checkPart`): mapa de
  claves canónicas `{ es, en }`. `language` es opcional y por defecto `es`. Covers R3.
- `packages/cli/src/lib/master/close.ts` (`runMasterClose`, `hash`):
  - Abandono sin partes. Covers R5.
  - Bloqueo por `evidenceBlockers`. Covers R6.
  - `--reason` en entrega. Covers R16.
  - EOL. Covers R1.
- `packages/cli/src/lib/master/status.ts`:
  - **`MasterStatus.evidenceBlockers`, `readMasterStatus` y `renderStatusMd`.** Covers R6.
  - **`writeMasterStatus`**, con la forma de inserción, el EOL y el marcador huérfano.
    Covers R10, R11.
  - **`derivedWriteFailure(subject, command, cause): string`**, nuevo.
    - Extrae el texto que hoy arma el `catch` de `runMasterAdvance`:
      `"<subject>; falló la escritura derivada: <detalle>. Repare con 'navori master status'; no
      repita '<command>'."`
    - Lo usan `runMasterAdvance`, con el subject `<etapa>: fase durable '<fase>'` y su
      `MasterCheckSetupError` de siempre, y el subcomando `part`, con el subject
      `<etapa>: parts.json actualizado`.
    - Covers R8.
- `packages/cli/src/commands/master.ts`:
  - **Subcomando `part`.** Llama a `changeMasterPart`, después a `appendCliEvent` si aplica, y
    después a `writeMasterStatus` dentro de un `try` que relanza con `derivedWriteFailure`.
    Covers R7, R8.
  - **Subcomando `check`.** Covers R14.
  - **Subcomando `init`.** Covers R15.
- `packages/core/core-assets/master-plan/parts.md` y `en/parts.md` (nuevos, sin `##`). Covers R12.
- `packages/core/core-assets/skills/master-plan.md`:
  - "Procedimiento por fase y checklist de cierre", en los pasos `questioned` y `executing`.
  - "Spec de una parte".
  - "Evidencia de aceptación".
  - "Cierre, conversión y abandono", en el párrafo de `closable` y el de abandono.
  - Covers R17 y el texto de R5 y R6.
- Las specs `0034-master-plan` y `0049-master-plan-production-hardening` reciben las enmiendas de
  abajo. Covers R5, R6, R9.

## Decisions

- **`closable` sigue sin depender de `HEAD`. El bloqueo por huérfana va en `evidenceBlockers` y lo
  aplica `close`.**
  - Así `STATUS.md` sigue siendo una proyección uno a uno de `closable` y `blockers`.
  - `--json` expone el bloqueo, como pide la decisión del usuario.
  - El costo es que `closable: true` ya no significa por sí solo "close va a pasar": hay que leerlo
    junto con `evidenceBlockers`. El skill lo dice (R17), y `close` rechaza sin escribir si alguien
    lo ignora.
  - Cambia el contrato de 0049 R11, que pedía `status.closable` falso. Las enmiendas están abajo.
- **La regeneración de `part` va en el comando, no en `changeMasterPart`.**
  - R8 exige que el evento quede registrado aunque la regeneración falle, y `appendCliEvent` vive
    en el comando.
  - No se usa `finally`: emitiría el evento `allow` también cuando la mutación misma falla, por
    ejemplo con `already has issue`.
  - Es el mismo lugar que el precedente `setMasterUx`.
- **Se extrae el mensaje y no la escritura.**
  - `derivedWriteFailure` solo arma el texto.
  - Cada llamador conserva su clase de error. `runMasterAdvance` sigue lanzando
    `MasterCheckSetupError`, que su handler y sus pruebas en `dev` esperan.
  - El texto de `advance` no cambia: las pruebas de 0049 en `checks.test.ts` comparan con
    `/fase durable '…'.*navori master status.*no repita.*advance/` y siguen verdes.
- **El mensaje de R8 no invita a repetir `part`.** Repetir no es idempotente: `--issue` lanza
  `already has issue` y `--accept` reemplaza la evidencia.
- **R2.** Ignorar todo nombre con `.` también saca de la verificación a archivos ocultos legítimos,
  como `.notes.md`. Se acepta por simple. Si en `context/raw/` solo hay archivos ocultos, sigue
  fallando como vacío.
- **R16.** En legacy, el rechazo va después de "no hay etapa activa" y de "cierre ya iniciado" y
  antes de cualquier `save`. `deliveries` ya lo rechaza antes de escribir y aquí solo gana una
  prueba.
- **R14.** Se compara con `args.part !== undefined` más `trim()`. La exclusión mutua cuenta con
  `!== undefined`, no con `Boolean(...)`.
- **Forma de la primera inserción (R10).** Con `E` = `detectEol(contenido)`, el bloque queda así,
  en este orden:
  1. el encabezado;
  2. `E` dos veces;
  3. la región;
  4. `E` dos veces;
  5. el cuerpo previo recortado, si no está vacío, seguido de `E` dos veces;
  6. el resto desde el siguiente `##`.

  La región se escribe con `E` también cuando se reemplaza una región existente. El cuerpo previo
  no se deduplica.
- **Marcador huérfano (R11).** Si `masterPartsRegion` devuelve `null` y el contenido trae
  `<!-- navori:master-parts`, `writeMasterStatus` lanza un error que nombra el marcador antes de
  escribir cualquier archivo.
- **Presupuesto del skill, medido en `dev`.**
  - Hoy está en **2691 / 2700** palabras, medidas con
    `countWords(parseAsset(raw).managedBody)`, como en `skill-caps.test.ts`. La rama
    legacy/entregas de 0049 consumió el margen.
  - R17 agrega unas 45 palabras: `P<n>`, commit antes de `--accept`, `template parts`, `status`
    tras marcar tareas, `evidenceBlockers` y abandono sin partes. Ninguna edición neutra alcanza.
  - **Propuesta:** en M10, subir `metadata.maxWords` del frontmatter del asset a la medida
    resultante × 1.05, redondeada hacia arriba a la decena, y agregar una línea al comentario que
    nombre `0051 R17` y la medida, como en los precedentes 0039, 0041 y 0044.
  - Alternativa, si se rechaza la subida: compensar recortando la lista de nueve comandos
    `delivery-*` de la rama de 0049. Es texto de otra spec y no lo recomiendo.
- **Assets Markdown.** `parts.md`, `en/parts.md`, el skill y las enmiendas de specs los escribe
  `scribe` (`markdownRequests`). El implementer no escribe `.md`.

## Contracts

- **`MasterStatus` y `navori master status --json`:**
  - Nuevo campo `evidenceBlockers: string[]`, con mensajes
    `"<P>.<A>: evidencia huérfana; revalidar con 'navori master part <P> --accept <A>'"`.
  - En `deliveries` y sin etapa es `[]`.
  - `closable` y `blockers` no dependen de `HEAD`.
  - `acceptance[].commitsBehind` y `orphan` no cambian.
- **`STATUS.md`:**
  - Evidencia: `- P<n>.A<m> (<método>): verificado|sin evidencia`.
  - `Cerrable:` y "## Bloqueos" salen de `closable` y `blockers`.
- **`navori master close`, entrega legacy:** rechaza con
  `no se puede cerrar; evidencia huérfana:` seguido de `evidenceBlockers`, sin escribir nada.
- **Mensajes de reparación:**
  - `advance`: igual que en `dev`.
  - `part`: `"<etapa>: parts.json actualizado; falló la escritura derivada: <detalle>. Repare con
    'navori master status'; no repita 'navori master part'."`
  - Drift de `check`: sufijo `; repare con 'navori master status'` en
    `STATUS.md differs from its render` y en
    `MASTER.md: navori:master-parts differs from parts.json`.
- **`navori master template parts`:** imprime el contenido completo. El JSON del ejemplo valida con
  `PartsSchema` en `es` y en `en`. Las plantillas con secciones salen igual que hoy.

## Failure modes

- **`part` escribió `parts.json` y la regeneración falla.** El evento ya quedó registrado, y el
  mensaje dice "parts.json actualizado" y nombra la reparación. `check` vuelve a nombrarla (R9).
- **Drift por checkboxes o archivos de la spec vinculada.** Queda fuera de R6, porque no depende de
  `HEAD`. La reparación viene de R9 y de la instrucción de R17.
- **Etapas que ya perdieron `Origen:`.** El agente lo reescribe una vez y R10 lo conserva.
- **Marcador de apertura sin cierre.** R11 falla sin escribir.
- **Etapas atoradas sin partes en `mastered` o después.** R5 les da salida. Vaciar `parts.json` a
  propósito también habilita el abandono, pero exige confirmación y razón.
- **Evidencia huérfana al cerrar.** `close` la rechaza aunque `closable` sea `true` (R6). Se
  revalida con `part --accept`.
- **`STATUS.md` existentes**, con los sufijos o con bloqueos de huérfana de `dev`. Difieren una vez,
  y el primer `check` nombra `navori master status`.

## Migration

No cambia ningún esquema persistido. Cambia la forma de `STATUS.md`: se regenera una vez (R9).
`MasterStatus` gana un campo y ningún consumidor de `--json` pierde datos.

## Pruebas de 0049 en `dev` que cambian (M5)

- **`status.test.ts`, describe "master status":**
  - **"blocks orphan %s evidence with and without a linked spec".** El mensaje pasa de
    `status.blockers` a `status.evidenceBlockers`, y `status.blockers` deja de contenerlo. En vez de
    `closable` `false`, se afirma que `renderStatusMd(status)` no contiene `huérfana`. El título
    pasa a "exposes orphan %s evidence in evidenceBlockers, not in STATUS.md".
  - **"blocks an absent executable evidence commit".** Se afirma sobre `evidenceBlockers`.
  - **"keeps current and ancestor %s evidence valid and offers revalidation only for old
    evidence".** Se conservan las aserciones de `--json` (`commitsBehind: 1`), y
    `renderStatusMd(status)` **no** contiene `commitsBehind` ni `revalidar`.
  - **"exempts orphan executable evidence for a %s part".** `evidenceBlockers` vacío.
- **`close.test.ts`:**
  - **"uses the status orphan blocker and writes nothing on rejected closure".** El bloqueo sale de
    `readMasterStatus(cwd).evidenceBlockers[0]`. Se mantiene "writes nothing".
  - **"requires revalidation of orphan runs before closure and detects post-close evidence
    edits".** `toThrow("P1.A2: evidencia huérfana")` debería seguir pasando, porque el mensaje nuevo
    contiene el mismo texto. Solo se ajusta si cambia la forma.
  - **"closes with older ancestor evidence and records its age"** y **"closes a %s part despite
    orphan evidence".** Sin cambio, porque son de `CLOSURE.md`.
- **`checks.test.ts`.** Las pruebas de 0049 R3/R4 sobre `runMasterAdvance` no cambian, porque el
  texto es idéntico.
- Las pruebas de `slice.test.ts`, `master-delivery.test.ts`, `master-first-use.test.ts` y
  `workflow-compatibility.test.ts` que afirman `closable` no tienen evidencia huérfana, así que no
  cambian.

## Enmiendas en este PR (por encabezado)

**`specs/0049-master-plan-production-hardening/`.** Sus tareas ya están marcadas en `dev`: **no se
desmarcan**. Cada documento gana, bajo su línea de **Estado**, una nota: "Enmendado por
`specs/0051-master-plan-correcciones` (2026-10-13): la evidencia huérfana ya no está en
`closable`/`blockers` ni en `STATUS.md`; vive en `evidenceBlockers` (`--json`) y bloquea `close`
(0051 R6)." Además:

- **`requirements.md`:**
  - Al final de **R11**, una nota "(enmendado por 0051 R6: `evidenceBlockers` en lugar de
    `status.closable`)".
  - Al final de **R12**, "(la antigüedad se muestra en `--json`, `CLOSURE.md` y el skill, no en
    `STATUS.md`; 0051 R6)".
- **`design.md`:** una nota de enmienda en la viñeta "Evidencia" de "Approach" y en la viñeta
  "Evidencia huérfana…" de "Failure modes".
- **`tasks.md`:** una nota de enmienda en "M6 — Evidencia huérfana frente a antigua", sin tocar los
  checkboxes.

**`specs/0034-master-plan/`:**

- **Nota de cabecera** en `requirements.md` y `design.md`.
- **`requirements.md`, R58:** la excepción sin partes (0051 R5).
- **`design.md`:**
  - "Components", viñeta de `status.ts`: `commitsBehind`/`orphan` van en `--json`.
  - "D10", párrafo "En `mastered` o después…": la excepción sin partes.
  - "D12", viñeta "Que la evidencia siga vigente": `--json` y `CLOSURE.md`, no `STATUS.md`.
  - "Failure modes", viñetas "Evidencia vieja…" y "Evidencia de un commit que ya no existe…":
    `--json` en vez de `STATUS.md`.
  - "Failure modes", viñeta "Abandono en `mastered` o después": la excepción.
  - "Failure modes", viñeta "Ediciones a mano…": la reparación nombrada.
  - "Testing strategy", fila "Evidencia vieja o huérfana".
  - "Cobertura R<n> → componente", fila R61.
- **`tasks.md`:** notas de enmienda en T8 (`commitsBehind`/`orphan` en `--json`) y en T9 (abandono
  sin partes), sin desmarcar.

## Testing strategy

Cada prueba responde a un riesgo de arriba y lleva `// Covers: R<n>`:

- **R1:**
  - `eol.test.ts`.
  - CRLF en `splitTemplateSections`, en `runMasterCheck` (`MASTER.md`, `INTAKE.md` y `STATUS.md`) y
    en la Integridad de `checkClosedStage`.
  - Los hashes no cambian.
- **R2:** con `.DS_Store` junto a un archivo real, no hace falta fila; con solo `.DS_Store`, el
  directorio cuenta como vacío.
- **R3:** se aceptan `en` y `es` en un repo `en`; el faltante se nombra en inglés; cada etiqueta
  aparece en `tasks.md` de su idioma.
- **R4:** `advance` desde `questioned` con `parts: []` falla y nombra `parts.json`.
- **R5:**
  - Sin partes (ausentes o vacías) en `mastered`, `--abandon` cierra como `abandonada`.
  - Con una parte se rechaza.
  - `--convert` en `mastered` se rechaza.
- **R6:**
  - El render no contiene `commitsBehind`, `orphan`, `revalidar` ni `huérfana`.
  - `check` sigue verde tras un commit ajeno y tras un `reset` más un commit nuevo (evidencia
    huérfana).
  - `--json` trae `evidenceBlockers`, `commitsBehind` y `orphan`.
  - `close` rechaza sin escribir si hay evidencia huérfana.
  - `CLOSURE.md` conserva la antigüedad.
  - Además, las pruebas de 0049 editadas de la sección anterior.
- **R7:** tras `part --state`, `--spec`, `--issue` y `--accept`, no hay drift.
- **R8:**
  - Con `writeMasterStatus` forzado a fallar, `parts.json` queda actualizado y el evento
    `master-part-accept` queda registrado.
  - El mensaje dice "parts.json actualizado" y "Repare con 'navori master status'".
  - El mensaje de `advance` no cambia.
- **R9:** los dos mensajes de drift nombran `navori master status`.
- **R10:**
  - La inserción tiene la forma exacta.
  - `Origen:` y la prosa se conservan tras dos corridas idénticas byte a byte.
  - Un archivo CRLF sigue siendo solo CRLF.
- **R11:** con un marcador de apertura sin cierre, el comando falla y no escribe `MASTER.md` ni
  `STATUS.md`.
- **R12:** el JSON de `template parts` valida con `PartsSchema` en `es` y en `en`.
- **R13:** `template intake` imprime la tabla; `template master` sale igual que en la base.
- **R14:** con `--part` ausente, vacío o con espacios, hay error de uso y no corre el check de
  etapa.
- **R15:** stderr nombra el slug ignorado y la etapa activa, y el exit es 1.
- **R16:** un cierre legacy entregado con `--reason` no escribe nada; `deliveries` también lo
  rechaza; se conservan los mensajes "cierre ya iniciado" y "no hay etapa activa".
- **R17:**
  - Aserciones de texto sobre el skill.
  - `skill-caps.test.ts` en verde con el tope nuevo.

Los hitos que tocan Markdown o renders (M5, M7, M8, M10) verifican además `bun run test:golden`,
`bun run check:assets` y `bun run check:render`. El PR cierra con `bun check`.

## Hitos propuestos (E1, un commit por hito)

`Estimated LOC` estima código, pruebas y Markdown.

| Hito | R | Archivos | LOC est. | Commit |
|---|---|---|---|---|
| M1 | R1 | `primitives/eol.ts` + `eol.test.ts`, `templates.ts`, `checks.ts`, `close.ts`, pruebas | 110 | `fix(master): normaliza fin de línea CRLF con un helper compartido` |
| M2 | R2 | `checks.ts`, `checks.test.ts` | 30 | `fix(master): ignora archivos ocultos en context/raw` |
| M3 | R3 | `check-part.ts`, `check-part.test.ts` | 90 | `fix(master): acepta etiquetas de tarea en español e inglés` |
| M4 | R4, R5 | `checks.ts`, `close.ts`, pruebas; enmiendas de 0034 (R58, cabecera, D10, Failure modes de abandono, T9) | 120 | `fix(master): exige partes desde mastered y permite abandonar sin partes` |
| M5 | R6 | `status.ts`, `close.ts`, `status.test.ts`, `close.test.ts` (pruebas de 0049 editadas); enmiendas de 0034 (Components, D12, Failure modes de evidencia, Testing strategy, R61, T8) y de 0049 (notas en requirements R11/R12, design y tasks M6) | 190 | `fix(master): saca de STATUS.md el bloqueo y la antigüedad de evidencia` |
| M6 | R7, R8, R9 | `status.ts` (`derivedWriteFailure`), `checks.ts` (`runMasterAdvance` lo usa; mensajes de drift), `commands/master.ts` (`part`), `master-first-use.test.ts`, `part.test.ts`, `checks.test.ts`; 0034 Failure modes "Ediciones a mano…" | 110 | `fix(master): regenera STATUS.md tras part con la reparación de advance` |
| M7 | R10, R11 | `status.ts`, `status.test.ts` | 80 | `fix(master): conserva la sección de partes y su fin de línea al insertar la región` |
| M8 | R12, R13 | `templates.ts`, `parts.md`, `en/parts.md`, `templates.test.ts` | 150 | `feat(master): agrega plantilla parts e imprime plantillas sin secciones` |
| M9 | R14, R15, R16 | `commands/master.ts`, `close.ts`, `master-first-use.test.ts`, `close.test.ts` | 90 | `fix(master): rechaza argumentos vacíos o ignorados en check, init y close` |
| M10 | R17 | skill canónico (texto y `maxWords`) + espejos con `navori render --apply` | 30 (+ espejos) | `docs(master-plan): alinea la skill con el CLI` |

**Total E1:** unas 1000 líneas. M7 depende de `detectEol` (M1), M10 de M4, M5 y M8, y M6 de que M5
no altere el mensaje de `advance`.

## NOT in scope

- Lo que 0049 ya implementó en `dev`: render de `init`, regeneración tras `advance`,
  `architectContext`, modo en etapas ≥ 2, `spec check` estricto y smoke. Solo se reusa.
- El drift por checkboxes o archivos de la spec vinculada (R9 y R17 lo reparan).
- Digests de entregas sobre bytes crudos (`delivery.ts`, `delivery-checks.ts`) con `core.autocrlf`.
- `normalize` de `lib/render/marker.ts`.
- Rediseño de entregas.
- Coincidencia por subcadena (`P1` contra `P10`).
- Placeholders sin llenar.
- `check --fit`.
- Permisos.
- Parser Markdown unificado.
- Regenerar desde `mode`.
