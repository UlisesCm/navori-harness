# Correcciones del plan maestro tras auditoría — Tasks

**Estado:** borrador; ninguna tarea está marcada. Una sola entrega (E1), un PR contra `dev` con un
commit por milestone. Base: `origin/dev` `47c52fa5` (0049 implementada). El LOC es una estimación,
no una medición.

Reglas de ejecución:
- Workplan de la entrega: `0051-master-plan-correcciones-e1`; `tasks.md` es el tracking canónico.
- Cada prueba nueva lleva `// Covers: R<n>`. Los casos nombrados son planeados; los archivos de
  prueba existen en la base salvo `eol.test.ts`. Las pruebas de 0049 que M5 edita se listan en
  `design.md` ("Pruebas de 0049 en `dev` que cambian").
- Los assets Markdown nuevos, las ediciones del skill y las enmiendas de specs pasan por `scribe`
  (`markdownRequests`); los espejos se regeneran con `navori render --apply`, nunca a mano.
- Sin librerías, flags ni esquemas persistidos nuevos. Lo que 0049 implementó se reusa; solo M5
  cambia su comportamiento (decisión del usuario, R6). Las tareas de 0049 no se desmarcan.
- La entrega cierra con `bun check` completo, un recibo y un reviewer fresco.

## E1 — Correcciones de lectura, estado derivado, plantillas, CLI y skill
Estimated LOC: 1000

### M1 — Fin de línea CRLF
- **A1** [observable] — documentos de etapa en CRLF se leen igual que en LF y los hashes de cierre no cambian · `cd packages/cli && bun run test src/lib/primitives/__tests__/eol.test.ts src/lib/master/__tests__/templates.test.ts src/lib/master/__tests__/checks.test.ts src/lib/master/__tests__/close.test.ts` → exit 0, 0 failed
- [ ] **T1** (R1) — helper sin dependencias `normalizeEol`/`detectEol` en `packages/cli/src/lib/primitives/eol.ts`; lo usan `splitTemplateSections` (`templates.ts`), `readStageFile` y la lectura de `STATUS.md` en `runMasterCheck` (`checks.ts`), y reemplaza las copias de `sha256Normalized` (`checks.ts`) y `hash` (`close.ts`) · effect: behavior · test: `packages/cli/src/lib/master/__tests__/checks.test.ts`::"documentos de etapa en CRLF: secciones, check verde e Integridad de CLOSURE.md legible; hashes sin cambio"

### M2 — Archivos ocultos en context/raw
- **A2** — un `.DS_Store` no exige fila en `INTAKE.md` · `cd packages/cli && bun run test src/lib/master/__tests__/checks.test.ts` → exit 0, 0 failed
- [ ] **T2** (R2) — `checkTranscribed` excluye nombres que empiezan con `.`; con solo archivos ocultos sigue fallando como vacío · effect: behavior · test: `packages/cli/src/lib/master/__tests__/checks.test.ts`::"context/raw ignora archivos ocultos y solo-ocultos cuenta como vacío"

### M3 — Etiquetas de tarea en español e inglés
- **A3** — `check --part` acepta etiquetas `es` y `en` y nombra el faltante en el idioma del repo · `cd packages/cli && bun run test src/lib/master/__tests__/check-part.test.ts` → exit 0, 0 failed
- [ ] **T3** (R3) — mapa por clave canónica en `check-part.ts` (`FIELDS`, `validatePartSpec`, `checkPart`) que acepta ambas etiquetas y usa `config.language` para el mensaje · effect: behavior · test: `packages/cli/src/lib/master/__tests__/check-part.test.ts`::"etiquetas en y es aceptadas en repo en; faltante nombrado en inglés; cada etiqueta aparece en tasks.md de su idioma"

### M4 — Partes obligatorias y abandono sin partes
- **A4** — `advance` a `mastered` exige partes y una etapa tardía sin partes puede abandonarse · `cd packages/cli && bun run test src/lib/master/__tests__/checks.test.ts src/lib/master/__tests__/close.test.ts` → exit 0, 0 failed
- [ ] **T4** (R4) — `checkMasterDocument` falla con `parts.json` sin partes nombrando la causa · effect: behavior · test: `packages/cli/src/lib/master/__tests__/checks.test.ts`::"advance a mastered con parts vacío falla y nombra parts.json"
- [ ] **T5** (R5) — `runMasterClose` acepta `--abandon` en `mastered`/`ux`/`executing` solo sin partes (`parts.json` ausente o vacío); `--convert` sigue temprano; enmiendas de 0034 (`requirements.md` R58, nota de cabecera, `design.md` D10 y Failure modes de abandono, nota en `tasks.md` T9) · effect: behavior · test: `packages/cli/src/lib/master/__tests__/close.test.ts`::"abandono tardío sin partes cierra abandonada; con una parte se rechaza; convert en mastered se rechaza"

### M5 — STATUS.md sin datos de HEAD; bloqueo huérfano en close y --json
- **A5** [observable] — `check` sigue verde tras un commit ajeno y tras evidencia huérfana; `--json` expone `evidenceBlockers`, `commitsBehind` y `orphan`; `close` rechaza la huérfana sin escribir · `cd packages/cli && bun run test src/lib/master/__tests__/status.test.ts src/lib/master/__tests__/close.test.ts && bun run test:golden` → exit 0, 0 failed
- [ ] **T6** (R6) — `readMasterStatus` mueve el bloqueo huérfano de 0049 de `blockers` a `evidenceBlockers` (`closable` deja de depender de `HEAD`); `renderStatusMd` sin `commitsBehind`, `orphan` ni `revalidar`; `runMasterClose` rechaza con `evidenceBlockers` no vacío antes de escribir; edita las pruebas de 0049 listadas en `design.md`; enmiendas de 0034 (`design.md` Components, D12, Failure modes de evidencia, Testing strategy, cobertura R61; nota en `tasks.md` T8) y notas de enmienda en 0049 (`requirements.md` R11/R12, `design.md`, `tasks.md` M6, sin desmarcar) · effect: behavior · test: `packages/cli/src/lib/master/__tests__/status.test.ts`::"STATUS.md estable tras commit ajeno y tras evidencia huérfana; --json expone evidenceBlockers, commitsBehind y orphan"
- [ ] **T7** (R6) — bloqueo de cierre por evidencia huérfana desde `evidenceBlockers` · effect: behavior · test: `packages/cli/src/lib/master/__tests__/close.test.ts`::"close rechaza evidencia huérfana desde evidenceBlockers sin escribir aunque closable sea verdadero"

### M6 — Regeneración tras part y reparación nombrada
- **A6** — `part` deja `STATUS.md` al día; un fallo de regeneración conserva la mutación y el evento y usa la reparación de `advance`; los mensajes de drift nombran la reparación · `cd packages/cli && bun run test src/commands/__tests__/master-first-use.test.ts src/lib/master/__tests__/part.test.ts src/lib/master/__tests__/checks.test.ts` → exit 0, 0 failed
- [ ] **T8** (R7) — el subcomando `part` (`commands/master.ts`) regenera con `writeMasterStatus` tras la escritura durable de `parts.json`, para `--state`, `--spec`, `--issue` y `--accept` · effect: behavior · test: `packages/cli/src/commands/__tests__/master-first-use.test.ts`::"tras part --state, --spec, --issue y --accept no hay drift de STATUS.md"
- [ ] **T9** (R8) — orden escritura durable → evento de auditoría → regeneración; el mensaje sale de `derivedWriteFailure` (`status.ts`), extraído del `catch` de `runMasterAdvance` sin cambiar su texto · effect: behavior · test: `packages/cli/src/commands/__tests__/master-first-use.test.ts`::"fallo de regeneración tras --accept conserva parts.json y el evento master-part-accept y dice Repare con navori master status"
- [ ] **T10** (R9) — los mensajes de drift de `STATUS.md` y de `navori:master-parts` en `runMasterCheck` nombran `navori master status`; enmienda de 0034 (Failure modes "Ediciones a mano…") · effect: behavior · test: `packages/cli/src/lib/master/__tests__/checks.test.ts`::"mensajes de drift de STATUS.md y de la región nombran navori master status"

### M7 — Inserción de la región de partes
- **A7** — la primera inserción conserva el cuerpo y el fin de línea, y un marcador sin cierre falla sin escribir · `cd packages/cli && bun run test src/lib/master/__tests__/status.test.ts && bun run test:golden` → exit 0, 0 failed
- [ ] **T11** (R10) — `writeMasterStatus` inserta encabezado, región y cuerpo previo con `detectEol` del archivo; idempotente en corridas siguientes · effect: behavior · test: `packages/cli/src/lib/master/__tests__/status.test.ts`::"primera inserción conserva Origen y prosa tras dos corridas idénticas; MASTER.md en CRLF sigue solo CRLF"
- [ ] **T12** (R11) — apertura de región sin cierre: `writeMasterStatus` falla nombrando el marcador antes de escribir `MASTER.md` o `STATUS.md` · effect: behavior · test: `packages/cli/src/lib/master/__tests__/status.test.ts`::"marcador de apertura sin cierre falla sin escribir"

### M8 — Plantilla parts e impresión de plantillas sin secciones
- **A8** — `template parts` imprime un JSON válido contra `PartsSchema` y `template intake` no sale vacío · `bun run check:assets && cd packages/cli && bun run test src/lib/master/__tests__/templates.test.ts` → exit 0, 0 failed
- [ ] **T13** (R12) — assets `packages/core/core-assets/master-plan/parts.md` y `en/parts.md` (vía scribe) con un criterio por método; `parts` en `TEMPLATE_NAMES` · effect: behavior · test: `packages/cli/src/lib/master/__tests__/templates.test.ts`::"el JSON de template parts valida con PartsSchema en es y en"
- [ ] **T14** (R13) — `printTemplate` imprime el contenido completo cuando la plantilla no tiene secciones `##`; las demás no cambian · effect: behavior · test: `packages/cli/src/lib/master/__tests__/templates.test.ts`::"template intake imprime la tabla; template master igual que la base"

### M9 — Argumentos del CLI
- **A9** — `check --part` vacío, `init <slug>` ignorado y `close --reason` entregado fallan con mensaje · `cd packages/cli && bun run test src/commands/__tests__/master-first-use.test.ts src/lib/master/__tests__/close.test.ts` → exit 0, 0 failed
- [ ] **T15** (R14) — `check` usa `!== undefined` + trim para `--part` y para la exclusión mutua · effect: behavior · test: `packages/cli/src/commands/__tests__/master-first-use.test.ts`::"check --part ausente, vacío o espacios es error de uso sin check de etapa"
- [ ] **T16** (R15) — `init` escribe en stderr el slug ignorado y la etapa activa, con exit 1 · effect: behavior · test: `packages/cli/src/commands/__tests__/master-first-use.test.ts`::"init con otro slug y etapa activa explica en stderr y sale 1"
- [ ] **T17** (R16) — `runMasterClose` rechaza `--reason` sin `--abandon`/`--convert` antes de escribir, después de los mensajes "cierre ya iniciado" y "no hay etapa activa" · effect: behavior · test: `packages/cli/src/lib/master/__tests__/close.test.ts`::"close --reason en entrega legacy sale 1 sin escrituras; deliveries rechaza igual"

### M10 — Skill alineada con el CLI
- **A10** [observable] — el skill canónico y su espejo dicen lo que el CLI hace, dentro del tope de palabras; gate completo verde · `cd packages/cli && bun run test src/lib/master/__tests__/workflow-compatibility.test.ts src/lib/assets/__tests__/skill-caps.test.ts src/engines/claude/__tests__/master-plan-render.test.ts && bun run test:golden` → exit 0, 0 failed; luego `bun check` → exit 0
- [ ] **T18** (R17) — texto de `packages/core/core-assets/skills/master-plan.md` (vía scribe): `check --part P<n>`, commitear antes de `--accept`, `template parts` para `parts.json`, `navori master status` tras marcar tareas, cierre con `closable` verdadero y `evidenceBlockers` vacío, y abandono sin partes; `metadata.maxWords` sube a la medida × 1.05 (redondeo a la decena) con línea de justificación `0051 R17` (base medida en `dev`: 2691/2700); espejos con `navori render --apply` · effect: docs · test: `packages/cli/src/lib/master/__tests__/workflow-compatibility.test.ts`::"el skill indica check --part P<n>, commit antes de --accept, template parts, status tras marcar tareas y evidenceBlockers antes de cerrar"
