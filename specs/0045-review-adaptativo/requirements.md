# Review adaptativo: verificación proporcional y checks en git hooks nativos — Requirements

**Fecha:** 2026-10-08 · **Estado:** borrador para aprobación.
**Evidencia:** `.navori/state/handoffs/audit_deep_review-flow.md` (auditoría del flujo
implementer → scribe → reviewer → publisher) y la medición por paso de `qualityGate.full` de este
repo (sección "Baseline").

## Contexto

El ciclo implementer → review → publish es lento en cada corrida y en cada proyecto. La
auditoría encontró tres causas:

- **Verificación igual para todos los niveles.** El nivel del plan (0–3) cambia solo la
  planeación; un cambio de nivel 0 paga el mismo reviewer y el mismo `qualityGate.full` que uno
  de nivel 2.
- **El gate completo corre por ronda, no por aprobación.** Cada `CHANGES_REQUESTED` repite
  `qualityGate.full`. La 0044 resolvió esto solo para milestones de spec; los workplans quedaron
  fuera.
- **Checks mecánicos duplicados entre el harness y los git hooks del proyecto.** En
  `services--companies` lint corre 3 veces y typecheck 2 por ciclo (reviewer + hook
  `quality-gate-pre-commit` + `.husky/pre-commit`). En este repo semgrep y jscpd corren en el
  pre-commit versionado y otra vez en los hooks de plugin sobre los mismos bytes.

Además hay cuatro huecos de verificación: `expected` nunca se compara contra la salida, el
nivel 0 no tiene criterio de aceptación, el reviewer compara contra el encargo del orquestador y
no contra la petición original, y `plan check` reporta un `cumplido` sin evidencia como warning
mientras el reviewer lo trata como finding.

## Alcance y decisiones

**Decisiones del usuario (2026-10-08):**

- **Ruta SDD**, con medición previa como baseline.
- **Los checks mecánicos (format, lint, typecheck, semgrep, jscpd) salen del harness** y viven
  en el pre-commit/pre-push nativo del proyecto. Antes el harness los cargaba porque en Bonum no
  se podía integrar; hoy sí.
- **navori solo detecta y avisa** sobre los git hooks nativos: no los instala ni los escribe.
- **La duplicación se quita por config, no por detección** (tras el challenge, 2026-10-08): la
  config versionada decide qué deja de correr el harness; `doctor` da error si lo declarado no
  está activo. Las rondas `CHANGES_REQUESTED` usan `qualityGate.scoped` si existe, si no `fast`.
  Este repo declara `qualityGate.nativeHooks`.
- Prioridad de `docs/DIRECTION.md`: calidad > tokens > velocidad. Ninguna regla baja la
  garantía final: el gate completo sigue corriendo sobre los bytes que se firman y publican.

## Requirements (EARS)

### A — Checks mecánicos en git hooks nativos

- **R1** — The system SHALL aceptar en `navori.config.json` el campo booleano
  `qualityGate.nativeHooks`, ausente por defecto, que declara que el pre-commit nativo del
  proyecto ejecuta `qualityGate.fast`, y el campo booleano `plugins.<semgrep|jscpd>.nativeHook`,
  ausente por defecto, que declara que el hook nativo ejecuta el chequeo de ese plugin.
- **R2** — WHEN `qualityGate.nativeHooks` es `true`, the system SHALL dejar de ejecutar
  `qualityGate.fast` desde el hook del harness en `git commit`, decidiéndolo solo por la config
  versionada (nunca por detección), de modo que `navori render` produzca la misma salida en
  cualquier clone.
- **R3** — WHILE `qualityGate.nativeHooks` es `true`, the system SHALL seguir aplicando en
  `git commit` los guards del harness que no son el gate (el tope de `progress/current.md` y la
  user-section del hook).
- **R4** — WHEN `plugins.<semgrep|jscpd>.nativeHook` es `true`, `navori render` SHALL omitir del
  `settings.json` generado el hook de commit de ese plugin, y el plugin SHALL seguir instalando su
  script de chequeo para que el hook nativo lo invoque.
- **R5** — WHEN el usuario ejecuta `navori doctor`, the system SHALL reportar qué pre-commit o
  pre-push nativo está activo en el clone o worktree actual (`core.hooksPath`, husky, lefthook,
  pre-commit o un ejecutable en el directorio de hooks de git).
- **R6** — IF la config declara `qualityGate.nativeHooks` o `plugins.<p>.nativeHook` y `navori
  doctor` no confirma un hook nativo activo con contenido del usuario en ese clone o worktree THEN
  the system SHALL reportar un error que nombre el hook que falta. Un stub generado por el
  gestor de hooks (por ejemplo, los de `.husky/_`) o una detección ambigua cuentan como ausente.
- **R7** — WHEN `navori doctor` detecta un hook nativo activo y la config no declara
  `qualityGate.nativeHooks`, the system SHALL avisar que los checks mecánicos corren duplicados y
  SHALL sugerir declararlo.

### B — Gate completo por aprobación, no por ronda

- **R8** — WHEN el `reviewer` emite `CHANGES_REQUESTED`, the reviewer SHALL usar como evidencia
  de gate `qualityGate.scoped` (o `qualityGate.fast` si no está declarado) más los comandos `A<n>`
  asignados, sin correr `qualityGate.full`.
- **R9** — WHEN el `reviewer` va a emitir `APPROVED`, the reviewer SHALL correr
  `qualityGate.full` sobre los bytes que firma, como hoy.
- **R10** — WHEN `navori receipt gate` recibe `--feature <f>` sin `--spec` y existe
  `workplan_<f>.json` con fases, the system SHALL decidir `scoped` mientras quede una fase
  posterior con algún `A<n>` sin `cumplido`, y `full` en otro caso.
- **R11** — IF `navori receipt gate` no puede leer o validar el workplan THEN the system SHALL
  decidir `full`.
- **R25** — The system SHALL aceptar en `navori.config.json` el campo opcional
  `qualityGate.scoped` (los checks baratos de `full` sin la suite completa, más los tests
  relacionados con el diff), y el carril `scoped` SHALL correrlo en lugar de `qualityGate.fast`
  cuando esté declarado.

### C — Verificación proporcional al nivel

- **R12** — WHEN el encargo abre con `nivel-0:`, the system SHALL exigir un criterio de
  verificación con comando y resultado esperado en esa misma línea, y el plan-gate SHALL negar
  el despacho del `implementer` si falta.
- **R13** — WHILE el nivel es 0, `navori plan classify --diff` sigue respondiendo 0 y el repo
  declara `criticalPaths` sin que el diff toque ninguno, the `reviewer` SHALL limitar el pase 2
  al checklist de `review-diff` sobre el diff, sin `security-invariants`.
- **R14** — IF el diff toca un área crítica declarada en `project.criticalAreas` THEN the
  `reviewer` SHALL aplicar el review completo (pases 1 y 2 con `security-invariants`) sin
  importar el nivel.

### D — Integridad de la aceptación

- **R15** — The workplan SHALL aceptar un campo opcional `request` con el texto literal de la
  petición o el ID y cuerpo del ticket, y `navori plan render` SHALL mostrarlo junto a `goal`.
- **R16** — WHERE el workplan tiene `request`, the `reviewer` SHALL comparar el diff contra
  `request` en el pase 1, además de contra el encargo.
- **R17** — The schema SHALL aceptar `expected` en forma estructurada (`exit <n>`,
  `contains: <texto>` o `matches: /<regex>/`), además del texto libre actual.
- **R18** — WHEN el host corre el `command` de un `A<n>` con `expected` estructurado, the system
  SHALL registrar en la evidencia el código de salida y el resultado de la comparación, sin
  guardar la salida completa.
- **R19** — IF `expected` es estructurado y la comparación falla THEN `navori plan update
  --progress A<n>=cumplido` SHALL rechazar la marca.
- **R20** — WHEN `navori plan check` encuentra un `A<n>` en `cumplido` sin evidencia
  registrada, the system SHALL reportarlo como finding, no como warning.

### E — Flujo

- **R21** — The system SHALL producir `impl_<feature>.md` desde `impl_<feature>.json` con un
  comando determinista (`navori handoff render <feature>`), y el orquestador SHALL despachar el
  `scribe` solo cuando `markdownRequests` no esté vacío.
- **R22** — The doctrina del orquestador SHALL indicar que una observación informativa (score
  menor a 80) posterior a `APPROVED` se reporta en el PR y no reabre el ciclo.
- **R23** — The `navori.config.json` de este repo SHALL ordenar `qualityGate.full` de barato a
  caro (format, lint y typecheck primero, `test:coverage` al final) y SHALL incluir typecheck en
  `qualityGate.fast`.
- **R24** — The prosa de R8, R9, R12–R14, R16, R21 y R22 SHALL renderizarse para Claude y Codex.

## Baseline

Medición en este repo, 2026-10-08, cada paso de `qualityGate.full` por separado:

| Paso | Segundos |
|---|---|
| format:check | 0.1 |
| check:links | 0.1 |
| check:render | 1.2 |
| check:assets | 0.1 |
| check:doc-budgets | 0.1 |
| check:blame-ignore | 0.0 |
| jscpd:check | 0.6 |
| semgrep:check | 7.0 |
| check:size | 0.0 |
| test:coverage | 398.5 |
| lint | 0.1 |
| typecheck | 0.7 |
| **Total** | **≈408** |

**Lectura:** `test:coverage` es el 97 % del gate. Mover lint/semgrep/jscpd a git hooks quita
duplicación (segundos); el ahorro grande viene de correr la suite completa menos veces (bloque B)
y de correr solo los tests afectados en las rondas intermedias (R25).

## NOT in scope

- Instalar o escribir git hooks del proyecto: decisión del usuario, navori solo detecta.
- Profundidad de `// Covers: R<n>` (que el test cubra bien el requisito): sigue siendo juicio del
  reviewer.
- Correr el gate en paralelo con la lectura del reviewer (M2 de la auditoría): se evalúa con el
  baseline posterior a esta spec.
- Memo por fingerprint en los hooks de semgrep/jscpd (M9): queda obsoleto con el bloque A.
