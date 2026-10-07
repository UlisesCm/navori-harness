# Entregas funcionales — Tasks

Primera spec escrita en el formato que ella misma define (design.md § "Plan de entregas de esta
spec"): 3 entregas → 3 PRs contra `main`, que cierran #1253 (`Refs #1253` en E1 y E2,
`Closes #1253` en E3). Cada milestone es un commit. Mientras E2 no esté mergeada, la regla de
gates se aplica a mano: el gate completo corre una vez por entrega, en el ciclo de cierre, y los
ciclos intermedios corren `qualityGate.fast` más los `A<n>` del milestone. Cada test lleva
`// Covers: R<n>`.

## E1 — `navori spec` clasifica y valida specs
Estimated LOC: 1300

### M1 — Parser, clasificación y configuración
- **A1** [observable] — la propia 0044 se clasifica como `split` con 3 entregas ·
  `bun packages/cli/src/index.ts spec classify 0044-entregas-funcionales --json`
  → JSON con `"shape":"split"`, 3 entregas y los umbrales efectivos 12/1500/4
- **A2** — tests de parser, clasificación y config en verde ·
  `cd packages/cli && bun run test src/lib/spec src/lib/config`
  → exit 0, 0 failed
- [x] **T1** (R4, R10) — parser por bloques de `tasks.md` en `lib/spec/` (entregas, milestones,
  criterios, `Consumes:`, tareas, tareas retiradas, fences por tipo y largo, detección de formato
  legacy) · effect: behavior · test: `lib/spec/__tests__/tasks.test.ts`::"bloques, fences y
  formato legacy"
- [x] **T2** (R5, R6, R7) — `classifySpec`: `split` solo con ≥2 entregas y umbral superado
  estrictamente, aviso de fusión, error por exceso de entregas, LOC sin declarar como aviso ·
  effect: behavior · test: `lib/spec/__tests__/classify.test.ts`::"bordes 12/13, 1500/1501, 1 y
  2 entregas, tope"
- [x] **T3** (R2, R3) — `sdd.deliveries` en `SddSchema` sin defaults materializados,
  `resolveDeliveryThresholds` y validación por campo · effect: behavior · test:
  `lib/config/__tests__/config.test.ts`::"sdd.deliveries"
- [x] **T4** (R4, R7, R8, R9) — `commands/spec.ts` con `classify` registrado en `subCommands`,
  `--json` con `formatVersion: 1`, ERROR / WHY / FIX y códigos de salida de D3 · effect: behavior
  · test: `commands/__tests__/spec.test.ts`::"classify"

### M2 — Validación y specs anteriores
- **A3** [observable] — todas las specs reales pasan `check` sin error ·
  `cd packages/cli && bun run test src/lib/spec/__tests__/real-specs.test.ts`
  → exit 0, 0 failed
- **A4** [observable] — la propia 0044 pasa `check` ·
  `bun packages/cli/src/index.ts spec check 0044-entregas-funcionales`
  → exit 0, sin errores
- [x] **T5** (R11, R12, R13) — `checkSpec`: milestone sin criterio, tarea huérfana o duplicada,
  `R<n>` sin cubrir, entrega no vertical (error en `split`, aviso en `single`), `foundation` mal
  ubicada o sin `Consumes:` · effect: behavior · test: `lib/spec/__tests__/check.test.ts`::"una
  regla por caso"
- [x] **T6** (R14) — specs anteriores: todo hallazgo como aviso y exit 0; test sobre todos los
  `specs/*/tasks.md` del repo · effect: behavior · test:
  `lib/spec/__tests__/real-specs.test.ts`::"todas las specs reales"
- [x] **T7** (R4, R11) — subcomando `check`, permisos `allow` de solo lectura
  `navori spec classify` y `navori spec check` en `settings-base.json` · effect: behavior · test:
  `commands/__tests__/spec.test.ts`::"check" y
  `asset-command-permissions.test.ts`::"navori spec"

## E2 — Gates proporcionales y PRs por entrega
Estimated LOC: 1200

### M3 — El CLI decide el tipo de gate
- **A5** [observable] — un milestone intermedio de la 0044 decide `scoped` y el de cierre `full` ·
  `cd packages/cli && bun run test src/lib/spec/__tests__/classify.test.ts src/lib/diagnose/__tests__/receipt.test.ts`
  → exit 0, 0 failed
- [x] **T8** (R25) — `decideGate` en `lib/spec/`: `scoped` solo con trabajo pendiente posterior en
  la misma entrega; `full` en cierre, unidad completa, legacy, milestone desconocido o `tasks.md`
  ilegible · effect: behavior · test: `lib/spec/__tests__/classify.test.ts`::"decideGate"
- [x] **T9** (R16, R17, R25) — `navori receipt gate` de solo lectura; `receipt sign --spec
  --milestone --gate-ran` escribe `gateKind`, rechaza `scoped` cuando la decisión es `full`, y sin
  flags firma como hoy · effect: behavior · test:
  `lib/diagnose/__tests__/receipt.test.ts`::"gateKind"

### M4 — Doctrina de entregas para Claude y Codex
- **A6** [observable] — las anclas nuevas se renderizan en ambos engines ·
  `cd packages/cli && bun run test src/engines`
  → exit 0, 0 failed
- **A7** — topes de palabras y presupuesto always-on ·
  `bun run check:doc-budgets`
  → exit 0
- [x] **T10** (R10, R15) — bloque `sdd`, skill `spec-bootstrap` (entregas, milestones, tareas en
  lugar de lotes) y bloque `orquestacion` (ciclo acotado = `qualityGate.fast` + `A<n>`, gate
  completo una vez por PR, `navori receipt gate`); una línea en `planificacion` para el workplan
  por entrega · effect: behavior · test: `engines/__tests__/render-engine.test.ts`::"anclas sdd y
  orquestacion"
- [x] **T11** (R16, R17, R26) — `reviewer` (encargo `spec: <spec> E<n> M<n>`, `receipt gate`,
  ciclo de cierre con el diff completo de la entrega) y `publisher` (`mode: commit-only` antes
  de "PR flow"), con topes de palabras justificados en el frontmatter · effect: behavior · test:
  `engines/__tests__/render-engine.test.ts`::"commit-only antes de PR flow"
- [x] **T12** (R18, R19, R23) — `publisher`: PR por entrega con `Spec-Delivery:`, orden con
  `git merge-base --is-ancestor`, `Refs`/`Closes` y aviso cuando `prTarget` no es la branch por
  defecto; fila `flow:spec-delivery-publication` en la matriz de solapamiento · effect: behavior
  · test: `engines/__tests__/render-codex.test.ts`::"anclas de entrega" y
  `engines/shared/__tests__/native-overlap.test.ts`::"spec-delivery"

### M5 — Dirección, branch destino y calibración
- **A8** [observable] — este repo publica contra `main` ·
  `cd packages/cli && bun run test src/lib/__tests__/pr-target-render.test.ts`
  → exit 0, 0 failed
- **A9** — re-render sin drift ·
  `bun run check:render`
  → exit 0
- [ ] **T13** (R20) — `prTarget: "main"` en `navori.config.json` y `navori render --apply` · effect:
  behavior · test: `lib/__tests__/pr-target-render.test.ts`::"reviewer y publisher apuntan a
  main"
- [ ] **T14** (R1) — sección de unidad de PR y de verificación en `docs/DIRECTION.md`, con enlace
  a la dirección · effect: docs · test: `lib/__tests__/direction-doc.test.ts`::"unidad de PR"
- [ ] **T15** (R24) — línea base 0039/0041 y tabla de calibración en
  `docs/research/distribucion-entregas-agentes.md`; el reporte de investigación pasa a
  `docs/research/` como anexo de evidencia · effect: docs · test:
  `lib/__tests__/direction-doc.test.ts`::"tabla de calibración"

## E3 — Master-plan reparte con las mismas reglas
Estimated LOC: 450

### M6 — Mapeo de entregas con `parts.json`
- **A10** [observable] — una parte de master-plan valida sus `E<n>` contra `parts.json` ·
  `cd packages/cli && bun run test src/lib/master/__tests__/delivery-checks.test.ts`
  → exit 0, 0 failed
- [ ] **T16** (R22) — `deliveryIdsForSpec` de solo lectura en `lib/master/` y su regla en
  `checkSpec`; aviso cuando el destino de la entrega difiere de `prTarget` · effect: behavior ·
  test: `lib/master/__tests__/delivery-checks.test.ts`::"deliveryIdsForSpec"

### M7 — Skill y plantillas de master-plan
- **A11** [observable] — la skill y las plantillas citan la clasificación en ambos engines ·
  `cd packages/cli && bun run test src/engines src/lib/master`
  → exit 0, 0 failed
- [ ] **T17** (R21, R23) — skill `master-plan` (spec de una parte y fase `executing`) y plantillas
  `tasks.md`, `delivery-master.md` y `slice.md` en es y en, con tope de palabras justificado ·
  effect: behavior · test: `engines/__tests__/render-engine.test.ts`::"master-plan clasifica
  specs"

## Trazabilidad

| R | Tareas |
|---|---|
| R1 | T14 |
| R2, R3 | T3 |
| R4 | T1, T4, T7 |
| R5, R6 | T2 |
| R7 | T2, T4 |
| R8, R9 | T4 |
| R10 | T1, T10 |
| R11 | T5, T7 |
| R12, R13 | T5 |
| R14 | T6 |
| R15 | T10 |
| R16, R17 | T9, T11 |
| R18, R19 | T12 |
| R20 | T13 |
| R21 | T17 |
| R22 | T16 |
| R23 | T12, T17 |
| R24 | T15 |
| R25 | T8, T9 |
| R26 | T11 |
