# Plan maestro v2: slices aceptados por el usuario

## Resultado

Del objetivo al primer slice listo en horas, con estado visible sin archivos que mantener. Ningún agente integra un segundo slice mientras otro espera aceptación, ni acepta o aprueba sin el usuario. Reemplaza `legacy` y `deliveries` (#1470, #1507).

## Flujo

1. `navori master init <slug>` crea `PLAN.md` (una página): objetivo, aceptación, índice y decisiones.
2. El agente entrevista al usuario y llena el índice: "actor → resultado", ≤3 días (SPIDR si no cabe).
3. `check` valida plan, verticalidad y entorno.
4. El siguiente slice recibe su `spec.md` (#1483), `spec check` verde: listo.
5. Se construye en `slice/S<n>-<slug>` y se integra en la rama de aceptación si el WIP lo permite.
6. Ronda de QA: el usuario o un tester corre los guiones; el usuario acepta o rechaza por lote.
7. Aceptada, la spec deja de mantenerse y de ser fuente de verdad; no se borra.

## Reglas aplicables

- **Identidad.** Un commit es de S<n> si su mensaje lleva `Slice: S<n>`, o su asunto `[S<n>]` o `slice/S<n>-` (merge commit de GitHub). Sin marca no es de un slice (arreglos, chores, hotfixes) y no paga fricción. El publisher marca commits y título; la CI exige `[S<n>]` en el título de los PR `slice/…`.
- **Estado = git**, derivado al leer, sin archivos de estado; `check` hace fetch de `origin` o falla cerrado.
  - `pendiente`: sin commits marcados. `integrado`: alguno es ancestro de la rama de aceptación (`git merge-base --is-ancestor`), o el `Commit` del índice (slices previos a la v2).
  - `en curso`: marcado sin integrar, o integrado con rechazo vigente.
  - `aceptado`: aceptación vigente. Commits marcados posteriores solo se avisan.
- **Log**: `acceptance.jsonl` en la rama huérfana `navori/acceptance` (compartida por worktrees; ningún PR la toca). Solo lo escriben `accept` y `reject`, siempre con `--approved-by user`: veredicto, fecha, entorno, head de la rama de aceptación y evidencia o notas. Escriben con compare-and-swap y push (un reintento); sin push, "sin publicar": `status` lee la rama local; la CI, la remota.
  - `accept S1 S3 [--evidence <url>]`: lote atómico, solo de slices `integrado`. Evidencia opcional y externa (Notion, video): aprueba el usuario.
  - `reject S2 --notes "…"` (obligatorio, repetible, se acumula): cada nota es una tarea abierta de S2 que muestran `status S2` y `master-plan-context`, hasta aceptarlo.
- **Confirmación.** Claude: `master-accept-confirm` pregunta ante `master accept|reject` (cualquier invocador) o `navori/acceptance`; Pi pide "yes, run it" (`extension-source.ts:435-464`); Codex niega.
- **Decisiones.** Una `D<n>` es propuesta hasta que `accept D<n>` (aparte) la registra.
- **WIP N=1.** Cuenta los slices distintos con código en la rama destino o la de aceptación sin aceptación vigente. `check --incoming <ref>` falla si los commits marcados que trae suman un slice nuevo al conteo y este ya llega a N; un arreglo de un slice contado pasa. Parada dura del publisher y check requerido de CI (lee `PLAN.md` de la base).
- **Entorno.** `PLAN.md` declara entorno, URL, rama que lo despliega y rama destino; `status` marca `sin entorno` lo que no llega y avisa si un slice tarda más de 3 días en integrarse.
- **Evasión deliberada** (riesgo aceptado): quitar las marcas (título editado en el squash, commits sin `Slice:` fuera de `slice/…`) o usar plumbing de git sobre `navori/acceptance`.

## Metas de tamaño

`wc -l` sobre `lib/master/*.ts`, `commands/master.ts` y `diagnose/master-plan.ts`; `wc -w` para doctrina. Se miden tras T7 (T6 conserva la v1 en solo lectura).

| Medida | v1 | v2 |
|---|---|---|
| Código | 7,413 | ≤1,500 |
| Tests | 10,785 | ≤2,500 |
| Subcomandos | 19 | 5 (+`migrate` una release) |
| Valores de estado | 32 | 4 |
| Archivos por plan | 10–12 por etapa | `PLAN.md`, el log y una spec por slice |
| Doctrina | ~6,100 palabras | ≤1,000 |
| Plantillas | 22 | 2 |

Se elimina: fases, `architect` ×3, etapas, `UX.md`, `DIGEST.md`, `CODEBASE.md`, `DECISIONS.md`, `CLOSURE.md`, `STATUS.md`, `state.json`, `parts.json`, checklist de rigor y evidencia `P<n>.A<m>`.

## Impacto en Rust

- **Se borran sin portar** 9,334 líneas `*master*` de `origin/migration/rust`: `navori-core/src/master/` (con `index.rs` y `delivery_parts.rs`, que #1527 iba a reubicar), `navori-cli/src/master*.rs`, los hooks `master_*` y el mapeo R22 de `spec.rs:563-576`.
- **No se agrega nada.** `master` sigue en TS, único lector de `PLAN.md` y del log; con `harness.masterPlan` y los dos hooks bash intactos, el render Rust solo cambia assets.

## Estados

| Estado | Qué ve el usuario |
|---|---|
| Vacío | Sin `PLAN.md`: "corre `navori master init`"; índice vacío: error. |
| Error | Sin rama remota o `fetch-depth` corto: falla cerrado y nombra el arreglo. |
| Sin conexión | Refs locales con su antigüedad. |
| Sin permiso | `accept` del agente: ask, frase en Pi o deny. Push rechazado: "sin publicar". |

## Entorno y datos

- CLI del worktree en un repo desechable con remoto, `qa` de aceptación y `dev` destino; datos ficticios.
- Fixture: plan v1 ficticio con tres entregas ya en `qa`; S3 sin guion.

## Guion de aceptación

1. `migrate` sobre el fixture, sin y con `--write`. **Esperado:** imprime; luego `PLAN.md` con S1–S3 `integrado`.
2. `check`. **Esperado:** "3 integrados sin aceptar (N=1)".
3. Ronda de QA: `status --qa`. **Esperado:** entorno y guiones para el tester; aviso "S3 sin guion".
4. El agente corre `node …/index.js master accept S1 --approved-by user`. **Esperado:** ask en Claude, deny en Codex.
5. El usuario: `accept S1 S3 --evidence https://example.test/qa-1 --approved-by user`. **Esperado:** dos líneas con fecha, commit y evidencia; `accept S1 S9` falla entero.
6. `reject S2` sin notas y con `--notes "a" --notes "b"`. **Esperado:** falla; luego S2 `en curso` con 2 tareas, en el WIP.
7. Agrega S4 "todo el backend de pagos". **Esperado:** `check` lo marca horizontal.
8. PRs `slice/S4-…`, `feat/s4` (commits `Slice: S4`) y `fix/typo`. **Esperado:** los dos primeros fallan por "S2 sin aceptar"; `fix/typo` pasa.
9. S2 corregido entra a `dev`, se promueve y se acepta; S4 se integra por squash. **Esperado:** `sin entorno` antes de promover; S4 `integrado` por `[S4]`.
10. `init demo` en repo vacío. **Esperado:** `PLAN.md`, 0 slices.

## Opciones descartadas

- **`STATUS.md` o JSON del CLI:** se desincronizan (jey 1aac075; `state.json` autoriza solo E1).
- **"Hecho" por evidencia de agentes** (v1) y **WIP en prosa** (D100): nunca se cumplieron.
- **Marca obligatoria en todo commit:** frena hotfixes.
- **Reabrir un aceptado por commits posteriores:** falsos positivos con promociones y reverts.
- **Spec viva:** deriva (Böckeler).

## Fuera de alcance

- Entorno y migración de jey (guía de T5).

## Tareas

1. `status` (con `--qa`) y `check --incoming` sobre `PLAN.md` y git, sin escrituras.
2. `accept`/`reject` por lote en `navori/acceptance` y regex del hook (tras #1481, sesión 1).
3. `init`, plantilla `PLAN.md` es/en, skill ≤600 palabras, bloque y `master-plan-context`.
4. Enforcement: marcas del publisher, parada dura y bloque de CI.
5. `migrate` y guía de jey: entorno (promover por slice a qa tras el demo, o entorno de dev) y adopción por ronda de QA con los guiones de #248–#250.
6. v1 en solo lectura; fuera R22 de `spec check` y los usos en `lib/plan` (con la sesión 1).
7. Release siguiente: se borra la v1 y su par Rust; se miden las metas.
