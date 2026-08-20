# Gestión del `.gitignore` del harness — Tasks

**Estado:** ✅ board cerrado — T1 (`lib/schema.ts`, campo `gitignoreHarness`) y T2
(`engines/shared/gitignore-harness.ts` con `CUBO_A_ENTRIES` y `buildGitignoreBody`, cubierto
por `engines/shared/__tests__/gitignore-harness.test.ts`) están en `main` igual que T3-T7.

Batches de 1-3. Cada task declara los `R<n>` que cubre y su(s) test(s) con `// Covers: R<n>`.

## Batch 1 — schema + derivación del cuerpo

- [x] **T1** (R1, R8, R11-schema) — Agregar `gitignoreHarness: z.enum(["off","local","full"]).default("off")` a nivel raíz de `NavoriConfigSchema` en `lib/schema.ts` con JSDoc; regenerar los JSON Schema (`pnpm gen:schemas`). · test: `lib/__tests__/schema.test.ts` — default `off`, acepta los 3 valores, rechaza uno inválido `// Covers: R1, R8`; y que `schema-publish.test.ts` pase tras `gen:schemas` `// Covers: R11`.
- [x] **T2** (R3, R4, R8) — Crear `engines/shared/gitignore-harness.ts` con `CUBO_A_ENTRIES` y `buildGitignoreBody(config)`: `null` en `off`, solo Cubo A en `local`, Cubo A + Cubo B (de `ENGINE_OUTPUTS` filtrado por `config.engines`, colapsado con `engineOwnedPaths()`) en `full`. · test: `engines/shared/__tests__/gitignore-harness.test.ts` — `off`→null; `local`→exactamente Cubo A; `full` con `engines:["claude"]` incluye `.claude/`+`CLAUDE.md` pero NO `.codex/`/`AGENTS.md`; `full` con codex sí los incluye; nunca aparece `progress/` a secas `// Covers: R3, R4, R8`.

## Batch 2 — escritura y reconciliación en render

- [x] **T3** (R2, R6, R7) — Enganchar en `render.ts` (tras los engines, antes del reporte) la escritura del bloque managed en `.gitignore` vía `collectExtraFile`/`injectManagedSection` (`commentStyle:"shell"`, `managedId:"gitignore-harness"`, `firstRenderSeed`), respetando `--force`. · test: `commands/__tests__/render*.test.ts` (o e2e) — modo `local` sin `.gitignore` previo lo crea con el bloque `// Covers: R6`; con `.gitignore` de usuario, inserta el bloque preservando las líneas del usuario `// Covers: R2`; bloque editado a mano → `user-modified-skipped` salvo `--force` `// Covers: R7`.
- [x] **T4** (R5) — Verificar reconciliación: al cambiar `config.engines` o el modo, el cuerpo recalculado reescribe solo la región del bloque (agrega/quita entradas) sin tocar líneas externas; render repetido sin cambios deja el archivo byte-idéntico (idempotencia). · test: mismo archivo de T3 — `full`+codex escribe `.codex/`; luego sin codex, un re-render lo quita del bloque y conserva las líneas de usuario; doble render == no-op `// Covers: R5`.

## Batch 3 — preview, doctor, i18n

- [x] **T5** (R9) — El `.gitignore` aparece en el reporte de engine files de `navori render` (preview, sin `--apply`) con status correcto y sin escribir a disco. · test: e2e — preview lista `.gitignore (created)` en repo sin bloque y no crea el archivo `// Covers: R9`.
- [x] **T6** (R10) — `doctor` reporta drift/ausencia del bloque managed del `.gitignore` cuando `modo ≠ off`, comparando `computeManagedHash` contra `buildGitignoreBody(config)`. · test: `commands/__tests__/*doctor*.test.ts` — modo `local` con bloque faltante → drift; con bloque al día → ok; modo `off` → no evalúa `.gitignore` `// Covers: R10`.
- [x] **T7** (R11-i18n) — Strings ES/EN del header del bloque y del reporte en `lib/i18n.ts`; el header escrito respeta `language` del config, no hardcode. · test: `lib/__tests__/i18n*.test.ts` o assert en el test de render — header en ES vs EN según config `// Covers: R11`.

## Traceabilidad (self-check)

| R | Task(s) | Test |
|---|---------|------|
| R1 | T1 | schema.test.ts |
| R2 | T3 | render*.test.ts |
| R3 | T2 | gitignore-harness.test.ts |
| R4 | T2 | gitignore-harness.test.ts |
| R5 | T4 | render*.test.ts |
| R6 | T3 | render*.test.ts |
| R7 | T3 | render*.test.ts |
| R8 | T1, T2 | schema.test.ts / gitignore-harness.test.ts |
| R9 | T5 | e2e preview |
| R10 | T6 | *doctor*.test.ts |
| R11 | T1, T7 | schema-publish.test.ts / i18n |

Todos los `R<n>` tienen ≥1 task y ≥1 test. Listo para descomponer (`leader` → `implementer` → `reviewer`).
