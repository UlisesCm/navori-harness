# El scribe es dueño del Markdown — Tasks

Cada tarea declara quién la ejecuta. La regla entra en vigor cuando esta spec mergea y se
renderiza; hasta entonces rige el contrato actual. Por eso el lote 2 lo escribe el `implementer`
por última vez (decisión de Ulises, 2026-09-23): el contrato vigente del `scribe` le prohíbe
investigar y escribir documentación de usuario, y ese contrato es justo lo que cambia T4. T7 ya
corre con la cadena nueva.

## Lote 1 — mecánica (implementer)

- [x] **T1** (R2, R10) · implementer — Capturar un payload real de `PostToolUse(Agent)` y confirmar `tool_input.subagent_type`; después, validación de `impl_<feature>.json` en `subagent-stop-handoff.sh` al volver el implementer (existe, parsea, trae las claves de R2) y de `Status:` en `impl_<feature>.md` al volver el scribe · test: `hook-claims-vs-scripts.test.ts` con fixtures válido / sin clave / sin parsear / md sin `Status:`, con `// Covers: R2, R10`.
- [x] **T2** (R3, R4) · implementer — Hook `implementer-no-markdown.sh` y su registro en `build-settings.ts` (matcher `Bash|Edit|Write|NotebookEdit`, bloqueo con `exit 2`) · test: suite nueva del hook con deny por tool y por patrón de `Bash`, allow para hilo principal, `scribe` y archivos no-md; `hook-matcher-wiring.test.ts` con el matcher nuevo, con `// Covers: R3, R4`.

## Lote 1b — flag (implementer)

- [x] **T8** (R13) · implementer — `harness.scribeOwnsMarkdown` (default `false`) en `HarnessSchema`; registro de `implementer-no-markdown.sh` condicionado al flag; `navori:if`/`navori:if-not` disponibles en los assets de agentes y skills que toca el lote 2 · test: schema default, settings con y sin flag, render condicional de un asset de agente, con `// Covers: R13`.

## Lote 2 — contratos de prosa (implementer, excepción final)

Toda la prosa nueva va dentro de `navori:if scribeOwnsMarkdown`, y el contrato actual queda en
`navori:if-not`, de modo que con el flag apagado el render es idéntico al de hoy.

- [x] **T3** (R1, R2) · implementer — Reescribir `implementer.md` en core-assets: prohibición explícita de `.md`/`.mdx`, contrato JSON con `markdownRequests`, retorno `done -> .claude/progress/impl_<feature>.json` · test: aserción de contrato sobre el asset (ninguna instrucción de escribir `.md`, claves de R2 presentes), con `// Covers: R1, R2`.
- [x] **T4** (R5, R6, R7) · implementer — Reescribir `scribe.md` como autor del Markdown, no solo serializador: render del handoff desde el JSON, `BLOCKED` ante payload inválido o `feature` distinta, aplicación de `markdownRequests` en el worktree del implementer con commit propio; retirar "not yet wired", "you do not investigate" y la exclusión de documentación de usuario · test: aserción de contrato sobre el asset, con `// Covers: R5, R6, R7`.
- [x] **T5** (R8, R9) · implementer — `orchestrator.md` y el bloque managed `orquestacion`: cadena `implementer → scribe → reviewer`, ruta `scribe → reviewer` para cambios solo de prosa, elección de modelo por despacho, tabla de archivos de `.claude/progress/` con el `.json`, excepción del implementer en la plantilla de cierre, y las menciones de `impl_<feature>.md` en las skills `resolve-ticket` y `verify-before-done` · test: aserción de contrato sobre ambos assets, con `// Covers: R8, R9`.

## Lote 3 — cierre

- [x] **T6** (R1–R10, R13) · implementer — `bun run --filter navori build`, `node packages/cli/dist/index.js render --apply`, snapshots de render y full gate · test: `check:render` y las suites de T1–T5 en verde.
- [ ] **T7** (R11, R12, R14) · orquestador + scribe — Encender `harness.scribeOwnsMarkdown` en este repo; el orquestador junta los tokens por agente de 3 ciclos reales con la cadena nueva (solo él ve el `usage` de cada despacho) y se los pasa al scribe como evidencia; el scribe escribe la enmienda en `specs/0027-scribe-agent/design.md` y el resultado en la fila de `scribe` de `specs/0031-admision-de-agentes/design.md`; si se cumple el criterio de retiro, el flag vuelve a `false` · test: aserción de que la enmienda de 0027 y la tabla de 0031 referencian `0030-scribe-owns-markdown`, con `// Covers: R11, R12, R14`.
