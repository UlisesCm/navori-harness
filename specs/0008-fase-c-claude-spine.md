# Spec 0008 — Fase C: Claude sobre el spine compartido (runbook ejecutable)

**Status:** 🟡 DRAFT para revisión — NO ejecutado. Requiere aprobación de Ulises antes de tocar `claude/index.ts`.
**Fecha:** 2026-07-28
**Driver:** Ulises Ciprés
**Depende de:** [Spec 0007](./0007-render-plan-unificado.md) Fases A y B (mergeadas en rama `refactor/spec-0007-fase-b-execute-plan`): `resolveHarnessPlan` (Capa 1) y `executePlan` + contrato `EngineAdapter` (Capa 3) ya existen y Codex ya corre sobre ellos.
**Objetivo:** que Claude comparta el spine para la lógica que HOY duplica con Codex (resolver inventario + placement + backup/write/prune), sin forzar sus rarezas legítimas dentro del contrato. Cerrar la duplicación real, no mudar todo el archivo por simetría.

> **Cómo leer esta spec:** es la "spec propia" que el runbook 0007 (§2 Fase C, DT-1) exigía antes de tocar Claude. Primero léela completa y **decide el alcance** (§4 DT-C1) — hay una elección de diseño abierta que es tuya. El runbook §6 solo es ejecutable DESPUÉS de esa decisión. Mismos gates que 0007: V-BYTE byte a byte (§7) como gate duro, no solo tests verdes.

---

## 1. Problema (medido en `claude/index.ts`, 1354 LOC)

Tras las Fases A/B, Codex resuelve inventario con `resolveHarnessPlan` y escribe con `executePlan`. Claude sigue con su propio recorrido inline y su propio bloque de backup/write/prune. La duplicación que queda viva entre ambos:

| Lógica duplicada | Claude (inline en `renderClaudeEngine`) | Codex (ya migrado) |
|---|---|---|
| Recorrido de agents `CORE_AGENTS × isAgentEnabled` | §3 (loop propio) | `resolveHarnessPlan` |
| Skills core + workflow + preset extras + libraries (con dedup) | §4/4b/6.5/6.6 | `resolveHarnessPlan` |
| Hooks guard + quality-gate | §6/6.1 | `resolveHarnessPlan` |
| Placement + render managed + backup + escritura atómica + chmod | §9 (bloque propio) | `executePlan` |

**Nota:** el catálogo (`shared/harness-assets.ts`) ya es compartido; lo que se duplica es el RECORRIDO y la FONTANERÍA — exactamente lo que las Fases A/B eliminaron para Codex.

---

## 2. Lo que NO es duplicación (rarezas legítimas de Claude — NO migrar a la fuerza)

Estos ocho comportamientos existen SOLO en Claude; no tienen contraparte en Codex, así que "migrarlos" no elimina duplicación — sería churn con riesgo. Se quedan como código Claude-only (DT-1 de 0007: "Claude queda como único caso especial documentado"; R2: `extraFiles`/válvulas):

1. **Pipeline de `CLAUDE.md` (§1–1e)** — el más pesado. `splitUserSection` → `computeRenderPlan` (managed-blocks con `skipIds`/`forceIds`, `downgrades`, `languageFallbacks`) → skills-index, agents-index, contexto-proyecto, contexto-monorepo (cuatro bloques COMPUTADOS, no assets en disco) → `reorderManagedBlocks` (orden canónico) → `emitUserSection`. Es un pipeline de sub-bloques dentro de UN archivo, no un managed asset 1:1.
2. **`settings.json` (§2)** — `planSettings`: merge de fragmentos de settings que aportan los plugins.
3. **Bootstrap `progress/` (§5)** — `planBootstrapFile`: semántica **seed-once** (se escribe una vez y NUNCA se sobrescribe). El contrato no modela "seed-once".
4. **Plugin scripts (§7)** — `planPluginScript` → `.claude/scripts/` (copia + interpola).
5. **Plugin skills `injectInto` (§8)** — `applySubBlockInject`: inyecta un sub-bloque managed en un archivo que YA existe (ej. `leader.md`), no crea un archivo nuevo.
6. **Reconciliación de 3 vías (§8.5/8.6/8.7)** — plugins deshabilitados (sub-block removal + script removal), lib-skills removidos del registro, lib-skills huérfanos. Poda mucho más rica que `OrphanScan[]`: incluye `removeSubBlock` (quitar un sub-bloque de un archivo sin borrar el archivo).
7. **Reporte extendido** — `ClaudeEngineResult` añade `claudeMdEntries`, `updatesAvailable`, `downgrades`, `languageFallbacks`, `inspected`. `executePlan` hoy devuelve solo `{written, skipped, backupPath}`.
8. **Opciones propias** — `skipIds`/`forceIds` (keep-mine / accept-new de `sync`), `monorepoContext`, `force`.

**Conclusión del análisis:** la migración de Claude es PARCIAL por naturaleza. El valor está en compartir §1 de esta spec (lo duplicado); forzar §2 dentro del contrato lo convertiría en "todo para todos" y mataría su simplicidad (el anti-objetivo de 0007).

---

## 3. Tensión de diseño a resolver ANTES de ejecutar

Si Claude usa `executePlan` solo para agents/skills/hooks pero conserva su propio `pending[]` para CLAUDE.md/settings/scripts/bootstrap, quedan **dos arrays de pending y dos bloques de escritura** → se rompe el backup unificado, el orden "CLAUDE.md al final" y la atomicidad. Eso es peor que la duplicación actual.

Dos formas de resolverlo:

### Opción C-plan/write (recomendada)
Separar `executePlan` en dos mitades reutilizables:
- `collectPlan(plan, adapter, ctx, { prune })` → devuelve `{ pending: PendingWrite[], removals, skipped }` **sin escribir**.
- `commitWrites(pending, removals, cwd, { backupTargets, dryRun, writeLastPredicate })` → backup + escritura atómica + chmod + poda + reporte `{written, backupPath}`.

`executePlan` pasa a ser `commitWrites(collectPlan(...))` (Codex intacto, byte a byte). Claude entonces:
1. Construye su `pending` de CLAUDE.md/settings/bootstrap/scripts/injectInto como hoy (código Claude-only).
2. Llama `collectPlan` con un `ClaudeAdapter` para agents/skills/hooks → obtiene MÁS pending.
3. **Concatena** ambos pending y llama `commitWrites` UNA vez → backup único, orden "CLAUDE.md al final", una sola superficie de escritura.

Ventaja: una sola fontanería de verdad; Claude reusa exactamente la del executor. Costo: refactor interno de `execute-plan.ts` (bajo riesgo, cubierto por V-BYTE de Codex).

### Opción C-válvulas (alternativa)
Extender el contrato `EngineAdapter` con hooks: `bootstrapFiles`, `subBlockInjects`, `extraRemovals`, `reportExtras`, `writeLastPredicate`. Claude implementa todas; `executePlan` las invoca. Rechazada de entrada: infla el contrato con 5+ ganchos que solo Claude usa (el anti-objetivo), y `computeRenderPlan`/reorder de CLAUDE.md no caben en ningún gancho razonable.

**Decisión requerida (DT-C1):** confirmar C-plan/write. El runbook §6 la asume.

---

## 4. Decisiones (DT) — a ratificar por Ulises

- **DT-C1 — Enfoque C-plan/write.** Separar `executePlan` en `collectPlan` + `commitWrites`; Claude comparte `commitWrites` con un `pending` combinado. (§3)
- **DT-C2 — Migrar SOLO agents/skills/hooks de Claude al `ClaudeAdapter`.** CLAUDE.md, settings, bootstrap, scripts, injectInto y la reconciliación de 3 vías se quedan Claude-only. No se toca su lógica; solo se saca su backup/write al `commitWrites` compartido.
- **DT-C3 — El reporte extendido se ensambla en `renderClaudeEngine`, no en el spine.** `commitWrites` devuelve `{written, backupPath}`; Claude le agrega `claudeMdEntries`/`updatesAvailable`/`downgrades`/`languageFallbacks`/`inspected`. El contrato no crece.
- **DT-C4 — V-BYTE con matriz ampliada.** Claude tiene más ejes (monorepo, `skipIds`/`forceIds`, plugins con injectInto, preset extras condicionales, `language="en"` con fallback). El baseline V-BYTE (§7) cubre: repo simple, workspace de monorepo, y repo con plugin injectInto + preset extras. Cero bytes de diferencia en los tres.
- **DT-C5 — `inspected` se preserva exacto.** Es contrato con el reporter de `render`. Cada `place*`/bootstrap/reconciliación que hoy suma `inspected += n` debe seguir sumando lo mismo. Se cuenta en `renderClaudeEngine` alrededor de las llamadas, no dentro del spine.

---

## 5. Qué se comparte tras la Fase C (mapa final)

```
resolveHarnessPlan ──┬─▶ Codex adapter ──▶ collectPlan ─┐
   (Capa 1, shared)   └─▶ Claude adapter ─▶ collectPlan ─┼─▶ commitWrites (shared)
                                                          │      backup/write/chmod/prune
CLAUDE.md pipeline ───────────────────────────────────────┘      (una sola vez)
settings/bootstrap/scripts/injectInto  ──(pending Claude-only)──┘
```

- Compartido: Capa 1 (resolver) + `collectPlan` + `commitWrites`.
- Claude-only: el pipeline de CLAUDE.md, settings, bootstrap, scripts, injectInto, reconciliación de 3 vías y el reporte extendido — como pre/post pasos que alimentan el MISMO `pending`.

---

## 6. Runbook (ejecutable SOLO tras ratificar DT-C1) — por fases

> Cada fase termina en **VERIFICAR**. No avanzar con un VERIFICAR en rojo. Localizar bloques `ANTES` por grep, no por línea.

### Fase C.1 — Partir `executePlan` en `collectPlan` + `commitWrites` (en `shared/execute-plan.ts`)
- Extraer el cuerpo de acumulación (place* → render → collect pending/skipped) a `collectPlan(plan, adapter, ctx, { prune }): { pending, removals, skipped }`.
- Extraer el bloque de backup/sort/escritura/chmod/poda a `commitWrites(input): { written, backupPath }`, parametrizando: `backupTargets`, `dryRun`, y `writeLast` (predicado; Codex lo pasa como `p => p.path.endsWith("/AGENTS.md")`).
- `executePlan` = `commitWrites({ ...collectPlan(...), cwd, backupTargets: adapter.backupTargets, dryRun, writeLast: agentsMdPredicate })`.
- **VERIFICAR C.1:** `pnpm test` verde (Codex intacto) · V-BYTE §7 solo-codex → byte-idéntico. Codex NO debe cambiar ni un byte.

### Fase C.2 — `ClaudeAdapter` para agents/skills/hooks
- Nuevo `claude/adapter.ts`: `createClaudeAdapter()` con `placeAgent`/`placeSkill`/`placeHook` que devuelven `PlacementRequest` con destinos `.claude/...` y los `managedId` actuales (`<id>-base`, bare para workflow/library, `extra.id` para preset). `backupTargets: ["CLAUDE.md", ".claude", "navori.config.json"]`, con el `exclude` de §9 (settings.local.json, progress/) — **requiere** que `commitWrites`/`createBackup` acepten `exclude` (verificar que ya lo hace; hoy Claude lo pasa).
- `orphanScans`: SOLO las que hoy hacen los pasos genéricos; la reconciliación de 3 vías (§8.5/8.6/8.7) NO va aquí (se queda Claude-only en §C.3).
- En `renderClaudeEngine`, reemplazar los loops §3/§4/§4b/§6/§6.1/§6.5/§6.6 por: `resolveHarnessPlan(config, coreAssets, preset, { includeLeader: true })` + `collectPlan(plan, claudeAdapter, ctx, { prune: false })`, y **fusionar** su `pending`/`skipped` con los de CLAUDE.md/settings/etc.
  - ⚠️ **`includeLeader: true`** — Claude SÍ emite `leader.md` (a diferencia de Codex). El parity test (0007 M1) ya trata `leader` como diff intencional.
  - ⚠️ Preservar el **dedup** `renderedSkillDests` (preset gana sobre library) — hoy vive en el loop; debe seguir aplicándose antes de construir el plan o dentro del adapter.
  - ⚠️ Preservar el conteo **`inspected`** exacto (DT-C5).
- **VERIFICAR C.2:** `pnpm test` verde · V-BYTE §7 matriz completa → byte-idéntico.

### Fase C.3 — Escritura unificada + reconciliación Claude-only
- Sustituir el bloque §9 de `renderClaudeEngine` por una sola llamada `commitWrites` con el `pending` combinado (CLAUDE.md incluido) y `writeLast: p => p.path === claudeMdPath`.
- La reconciliación de 3 vías (§8.5/8.6/8.7) y `scriptRemovals` siguen calculándose en Claude y se pasan a `commitWrites` como `removals` adicionales (junto con los de `collectPlan`).
- Ensamblar el reporte extendido en `renderClaudeEngine` (DT-C3).
- Borrar el código muerto de Claude (el viejo bloque de backup/write, ahora en el spine).
- **VERIFICAR C.3:** `grep` cero referencias al bloque de escritura viejo · `pnpm test` verde (incluye `render-engine`, `render-monorepo`, `idempotency`, `sync-resolve`) · V-BYTE §7 matriz → byte-idéntico · `wc -l claude/index.ts` baja de forma notable (esperado ~-150 LOC de fontanería).

---

## 7. V-BYTE (matriz Claude, gate duro — DT-C4)
Tres configs, baseline ANTES de editar, diff al final (procedimiento idéntico a 0007 §5):
1. **Simple:** `preset: nextjs`, `engines: ["claude"]`, engram on.
2. **Monorepo workspace:** raíz + un workspace hijo (usa `render --all` o el loop de workspace).
3. **Plugins + extras:** un plugin con `injectInto` (leader) + preset con extra condicional + `project.libraries` con uno que el preset también trae (ejercita el dedup) + `language: "en"`.

`diff -r` byte-idéntico en los tres. Cualquier diferencia → detente y reporta.

---

## 8. Riesgos
- **R-C1 — El pipeline de CLAUDE.md se enreda con el spine.** Mitigado por DT-C2: CLAUDE.md ni se toca; solo su `pending` fluye al `commitWrites` común.
- **R-C2 — `inspected` deriva.** Mitigado por DT-C5 + un test que hoy afirma el conteo (verificar `render-engine.test.ts`); si no existe, añadir uno ANTES de C.2.
- **R-C3 — Backup/exclude no soportado por el spine.** Mitigado en C.2: `commitWrites` debe aceptar `exclude`; si no, es un ajuste de firma previo (bajo riesgo).
- **R-C4 — Orden de escritura de CLAUDE.md.** Mitigado por `writeLast` parametrizado (C.1).
- **R-C5 — La ganancia real es modesta.** Honesto: se comparten ~150 LOC de fontanería; el grueso de Claude (CLAUDE.md) seguirá siendo Claude-only. Si al revisar juzgas que no compensa el riesgo sobre un archivo tan sensible, **la decisión válida es NO ejecutar** y dejar Claude como caso especial (DT-1 de 0007 ya lo contempla: "si Claude nunca migra, la duplicación igual muere" al compartir Codex+futuros el spine).

## 9. Estimación
C.1 ~medio día · C.2 ~1 día · C.3 ~1 día + endurecer V-BYTE. Total ~2.5 días. Reversible por fase (cada una con V-BYTE propio).

---

## Registro de ejecución (llenar al ejecutar)

| Fecha | Fase | Resultado | Notas |
|---|---|---|---|
| | C.1 | | |
| | C.2 | | |
| | C.3 | | |
