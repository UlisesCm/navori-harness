# Spec 0007 — Render plan unificado: eliminar duplicidad Claude ↔ Codex (y abaratar el proveedor N+1)

- **Status**: proposed (planning only — NO implementar hasta aprobación)
- **Fecha**: 2026-07-28
- **Autor**: Ulises Ciprés
- **Relacionado**: Spec 0002 (engine Claude), Spec 0004 (engine Codex, ya mergeado en rama `codex`), Spec 0005 (search layer)
- **Disparador**: auditoría post-merge de la rama `codex` (2026-07-27). El adapter Codex funciona (1105 tests verdes, e2e OK) pero reimplementa ~250 LOC de lógica que no es específica de ningún proveedor.

---

## 1. Problema: qué está duplicado hoy (medido, no de oído)

`claude/index.ts` (2297 LOC) y `codex/index.ts` (573 LOC) duplican dos categorías de lógica que **no varían por proveedor**:

### 1.1 Resolvers de inventario ("qué emitir")
Ambos engines recorren config + preset + libraries para decidir qué agents/skills/hooks materializar:

| Lógica | Claude | Codex |
|---|---|---|
| Skills: core + workflow + preset extras + libraries | `claude/index.ts:616-643` + extras `:751-754` + libs `:779` | `collectSkillSources` (`codex/index.ts:404-435`) |
| Agents: CORE_AGENTS filtrados por `isAgentEnabled` + preset extras | `claude/index.ts:205-207, 597-598` | `collectAgentSources` (`codex/index.ts:325-349`) |
| Hooks: guard-destructive siempre, quality-gate si `config.qualityGate.fast` | inline en claude | inline en codex (`:126-153`) |

Los dos consultan el mismo catálogo compartido (`shared/harness-assets.ts`: `CORE_AGENTS`, `CORE_SKILLS`, `WORKFLOW_SKILLS`, `isAgentEnabled`, `extraConditionMet`) — el catálogo NO está duplicado; el **recorrido** sí, dos veces, con el destino incrustado en el loop.

### 1.2 Pipeline de ejecución ("cómo escribir")
Plan → backup → escritura atómica → chmod → orphan-collection → reporte de status:

| Pieza | Claude | Codex |
|---|---|---|
| Acumular pending/skipped por status | inline | `collectPlan` (`codex/index.ts:551-573`) |
| Render de un asset managed | `renderManagedFile` (compartido ✅) | `planManagedAsset` / `planRawManagedFile` (wrappers propios, `:504-549`) |
| Backup + write atómico + chmod + rollback hint | inline en claude | `codex/index.ts:171-212` |
| Poda de huérfanos (assets deseleccionados) | `claude/index.ts:716-898` | `collectOrphanedManagedFiles` (`:437-480`) |

**Riesgo real de esta duplicación**: no es (solo) el costo de escribirla — es la **divergencia silenciosa**. Un fix en la poda de huérfanos de Claude (p.ej. el bug #105 de library skills) no llega solo a Codex; hay que acordarse de portarlo. Dos pipelines = dos superficies de bugs para el mismo contrato.

### 1.3 Lo que NO está duplicado (y hay que preservar)
- El catálogo (`shared/harness-assets.ts`) — única fuente de verdad de qué existe. ✅
- El cuerpo de prosa (`shared/prose-harness.ts` → `buildHarnessProse`) — AGENTS.md sale del mismo builder con flags. ✅
- La mecánica de markers (`injectManagedSection`, `renderManagedFile`, `parseAsset`, `interpolate`). ✅

La arquitectura ya acertó en compartir lo semántico; lo que falta es compartir el **recorrido** y la **fontanería**.

---

## 2. Diseño: resolver una vez → mapear declarativo → ejecutar una vez

```
┌─────────────────────────┐   ┌──────────────────────────────┐   ┌───────────────────────────┐
│ CAPA 1: resolveHarness- │   │ CAPA 2: EngineAdapter        │   │ CAPA 3: executePlan       │
│ Plan (shared, NUEVA)    │──▶│ (por engine, ~80 LOC c/u)    │──▶│ (shared, NUEVA)           │
│ config+preset+libraries │   │ tabla: kind → destino+formato│   │ backup/write/chmod/orphan │
│ → PlannedAsset[]        │   │ + extraFiles (settings/toml) │   │ /idempotencia/reporte     │
└─────────────────────────┘   └──────────────────────────────┘   └───────────────────────────┘
```

### 2.1 Capa 1 — `shared/harness-plan.ts` (nueva)
Unifica los resolvers duplicados de §1.1 en una función pura:

```ts
type AssetKind = "agent" | "skill" | "hook" | "rule-doc";

interface PlannedAsset {
  kind: AssetKind;
  id: string;                    // "reviewer", "verify-before-done", "guard-destructive"
  assetPath: string;             // ruta absoluta al asset fuente en @navori/core o preset
  managedId: string;             // id del marcador (estable, anti-retroceso)
  meta: {
    modelKey?: keyof NonNullable<NavoriConfig["models"]>;  // para agents
    exec?: boolean;              // para hooks (chmod +x)
    sandbox?: "read-only" | "workspace-write";             // ver mejora M5
  };
}

export function resolveHarnessPlan(config: NavoriConfig, repoRoot: string): {
  assets: PlannedAsset[];
  warnings: string[];            // preset inválido, plugin no cargable, etc.
}
```

Regla: esta función NO conoce rutas de destino ni formatos. Solo "qué existe y qué metadata tiene". Se extrae mecánicamente de `collectSkillSources`/`collectAgentSources` (Codex) verificando equivalencia contra los loops de Claude.

### 2.2 Capa 2 — contrato `EngineAdapter` (por proveedor)
Lo ÚNICO que un proveedor define. Declarativo, sin loops ni I/O:

```ts
interface Placement {
  destRelPath: string;
  commentStyle: "html" | "shell";
  /** Serialización específica del engine (p.ej. agent .md → .toml de Codex). */
  transform?: (body: string, asset: PlannedAsset, config: NavoriConfig) => string;
}

interface EngineAdapter {
  id: string;
  /** null = este engine no emite ese asset (p.ej. cursor no emite hooks). */
  place(asset: PlannedAsset): Placement | null;
  /** Archivos que no derivan 1:1 de un asset: settings.json (Claude), config.toml (Codex). */
  extraFiles(config: NavoriConfig, plan: PlannedAsset[], plugins: LoadedPlugin[]): PlannedFile[];
  /** Raíces a respaldar antes de escribir. */
  backupTargets: string[];
  /** Advertencias one-shot del engine (p.ej. hook-trust de Codex). */
  engineWarnings?(config: NavoriConfig): string[];
}
```

El adapter Codex queda en ~80 LOC: una tabla `kind → { .codex/agents/<id>.toml | .agents/skills/<id>/SKILL.md | .codex/hooks/<id>.sh | AGENTS.md }`, el transform `toCodexAgentToml` (hoy `planAgentFile:383-390`) + `adaptHarnessTextForCodex` (compat.ts), y `buildCodexConfigToml` como `extraFiles`. Los prose engines (agents-md/cursor/copilot) son adapters de UNA fila (`rule-doc`).

### 2.3 Capa 3 — `shared/execute-plan.ts` (nueva)
El pipeline de §1.2, una sola vez:

```ts
export function executePlan(
  cwd: string,
  plan: PlannedAsset[],
  adapter: EngineAdapter,
  config: NavoriConfig,
  options: { dryRun?: boolean; repoRoot?: string },
): ProseEngineResult
```

Responsabilidades (portadas del bloque más maduro de cada una):
1. Por asset: `adapter.place()` → `renderManagedFile`/`injectManagedSection` → pending/skipped por status (incluye `user-modified-skipped` y `downgrade-skipped` — el anti-retroceso #79 vive AQUÍ, no por engine).
2. `adapter.extraFiles()` al final del plan.
3. Backup una sola vez sobre `adapter.backupTargets` + `purgeOldBackups`.
4. Escritura atómica con orden estable (rule-doc al último — regla actual de codex `:180-184`) + chmod + `RenderWriteError` con hint de backup.
5. Poda de huérfanos: archivos `navori:managed` presentes en disco cuyo destino ya no está en el plan (generaliza `collectOrphanedManagedFiles` y la poda de Claude `:716-898`), respetando `isRemovableNavoriFile` (no tocar lo escrito por un navori más nuevo).
6. Idempotencia: segundo run sin cambios → `unchanged`, cero writes.

---

## 3. Decisiones (DT)

### DT-1 — Claude NO migra en la primera ola
El engine Claude (2297 LOC) es la referencia madura con features que el modelo debe absorber con calma (settings.json con coexist-detection, bloques CLAUDE.md vía `computeRenderPlan`, monorepo per-workspace, prompts-loader, frontmatter-merge). Migrarlo primero es riesgo máximo por ahorro mínimo. **Orden: prose engines → codex → (evaluar) claude.** Si Claude nunca migra, la duplicación igual muere: codex + todos los futuros comparten el spine, y Claude queda como único caso especial documentado.

### DT-2 — Regla de tres: la extracción se ejecuta cuando haya compromiso real con un proveedor #3, O cuando un bug de divergencia muerda
Con 2 implementaciones la abstracción se adivina; con 3 se factoriza contra casos reales. Excepción: si antes aparece un bug del tipo "fix aplicado a un engine y olvidado en el otro" (§1.2), eso adelanta la ejecución — es la prueba empírica de que la duplicación ya cobra intereses. Mientras tanto, esta spec ES el contrato documentado.

### DT-3 — El contrato `EngineAdapter` se congela en esta spec
Cualquier engine nuevo que se escriba ANTES de la extracción debe estructurarse internamente como si el contrato existiera (tabla de placement separada de la fontanería), para que la migración posterior sea mecánica.

### DT-4 — `resolveHarnessPlan` se valida por equivalencia, no por reescritura
Al extraerla, un test de paridad (M1) compara su output contra el inventario que HOY emite cada engine sobre configs representativas. La extracción no puede cambiar ni un archivo emitido.

---

## 4. Fases de implementación (cuando se apruebe ejecutar)

### Fase A — Capa 1 + test de paridad de inventario (riesgo ~0)
1. Crear `shared/harness-plan.ts` extrayendo `collectSkillSources`/`collectAgentSources` de codex + lista de hooks.
2. Codex consume `resolveHarnessPlan` (borra sus resolvers). Claude NO se toca.
3. Test de paridad M1 (ver §5).

**VERIFICAR**: `cd packages/cli && pnpm build && pnpm test` verde; render e2e sobre repo de prueba produce byte-a-byte lo mismo que antes (diff vacío contra un render pre-refactor).

### Fase B — Capa 3 + migrar prose engines y codex
1. Crear `shared/execute-plan.ts` portando el pipeline de codex (el más limpio) + la poda generalizada.
2. `agents-md`/`cursor`/`copilot` → adapters de una fila. `codex/index.ts` → adapter declarativo + `buildCodexConfigToml` en `extraFiles`.
3. Borrar `collectPlan`/`planRawManagedFile`/`planManagedAsset`/`collectOrphanedManagedFiles` de codex.

**VERIFICAR**: suite verde; e2e codex idéntico byte-a-byte; jscpd sin duplicación nueva; `codex/index.ts` < 150 LOC.

### Fase C — (opcional, evaluar tras B) Claude sobre el spine
Solo si el balance riesgo/beneficio lo justifica en ese momento. `settings.json`, coexist y monorepo entran por `extraFiles` + hooks del ejecutor. Requiere su propia ronda de VERIFICAR contra los 15 repos Bonum (doctor.ok en todos).

---

## 5. Mejoras adicionales para ambos proveedores (y el N+1)

Catálogo priorizado; cada una es independiente y commiteable por separado.

| # | Mejora | Detalle | Prioridad |
|---|---|---|---|
| **M1** | **Test de paridad de inventario entre engines** | Test que corre `resolveHarnessPlan` (o, pre-extracción, ambos engines) sobre configs representativas y verifica que Claude y Codex emiten el MISMO conjunto semántico de agents/skills/hooks (ids, no rutas). Detecta divergencia silenciosa — el riesgo #1 de §1.2 — sin esperar el refactor. **Se puede escribir HOY.** | 🔴 Alta |
| **M2** | **Resolver la colisión de managed-id `navori-agents`** | `codex/index.ts:260` reusa el id del engine `agents-md`. Con `engines: ["agents-md", "codex"]` ambos pelean por el mismo bloque de AGENTS.md (last-writer-wins por orden de dispatcher). Fix barato: `doctor` + `render` emiten warning y documentan "codex supersede a agents-md"; fix completo: dedupe en el dispatcher (si codex está activo, saltar agents-md). | 🔴 Alta |
| **M3** | **Mapa de modelos configurable** | `CODEX_MODEL_BY_CLAUDE_TIER` (`codex/index.ts:37-41`) está hardcodeado a `gpt-5.6-*`. OpenAI renombra modelos más rápido que los releases de navori. Agregar override opcional en config: `models.codexMap: { opus?: string, sonnet?: string, haiku?: string }` con fallback al mapa fijo + warning si el hardcode quedó obsoleto (modelo no listado en `codex doctor`/models_cache). | 🟡 Media |
| **M4** | **Sandbox por agente al catálogo, no hardcodeado** | La lista `["reviewer","researcher","ticket-audit","explorer","auditor"] → read-only` vive inline en `planAgentFile` (`codex/index.ts:378`). Ese dato es semántico del ROL, no de Codex: moverlo a `CORE_AGENTS[i].sandbox` en `shared/harness-assets.ts`. Claude puede consumirlo a futuro (p.ej. `permissions` por subagente) y el proveedor #3 lo hereda gratis. | 🟡 Media |
| **M5** | **Doctor checks específicos de Codex** | Hoy doctor valida markers/drift pero no la salud Codex: (a) `.codex/config.toml` parsea como TOML; (b) hooks con bit ejecutable; (c) `codex --version` ≥ 0.145.0 si el binario está en PATH (warning no-bloqueante); (d) hint del hook-trust (Fase 0: Codex no dispara hooks sin confianza persistida — silenciosamente). El (d) evita el modo de fallo más traicionero: harness renderizado que parece activo pero no protege. | 🟡 Media |
| **M6** | **Paridad de eventos de hook ampliada** | El spike Fase 0 confirmó que Codex soporta `SessionStart`, `UserPromptSubmit`, `Stop` además de `PreToolUse`. Claude usa SessionStart para engram (session-start.sh). Oportunidad: emitir el hook de arranque de engram también en Codex → misma memoria inyectada en ambos proveedores. Requiere spike corto del payload de `SessionStart` en Codex. | 🟡 Media |
| **M7** | **Consolidar (o sellar) el split-root de skills** | Skills en `.agents/skills/`, resto en `.codex/` (ambas rutas funcionan nativamente, per Fase 0). Decidir: (a) consolidar todo bajo `.codex/` — una raíz, un gitignore, mental model simple; o (b) sellar `.agents/` como decisión (es la ubicación cross-tool que otros agentes también leen — apunta a compartir skills con el proveedor #3 sin re-render). Recomendación: **(b) sellar**, porque `.agents/skills/` es justamente el seam multi-proveedor gratis; documentarlo en README del engine y en el gitignore de los repos destino. | 🟢 Baja |
| **M8** | **Inventario de paridad en `doctor --json`** | Exponer el inventario (agents/skills/hooks por engine) en la salida machine-readable. Permite a CI de los repos Bonum afirmar "Claude y Codex tienen el mismo harness" tras cada `render --all`. Se apoya en M1/Capa 1. | 🟢 Baja |
| **M9** | **Guía "cómo agregar un proveedor"** | `packages/cli/src/engines/README.md` con el contrato de §2.2, el checklist de spike (los 4 unknowns de la Fase 0 de Spec 0004: payload de hooks, discovery de skills, config location, mapa de modelos) y el criterio DT-2. Convierte esta spec en documentación operativa para el proveedor #3 (Gemini CLI, Amazon Q, etc.). | 🟢 Baja |

### Secuencia recomendada de mejoras (independiente del refactor grande)
1. **M1 + M2 ahora** (baratas, matan los dos riesgos activos: divergencia silenciosa y colisión de managed-id).
2. **M4 + M5** en la siguiente iteración de calidad.
3. **M3, M6** cuando haya señal real (rename de modelos OpenAI / demanda de memoria en Codex).
4. **M7 decidir + M9 escribir** antes de que alguien pregunte por el proveedor #3. M8 cuando exista Capa 1.

---

## 6. Riesgos

- **R1 — Refactor prematuro (el meta-riesgo).** Mitigado por DT-2: no se ejecuta hasta proveedor #3 o bug de divergencia. Esta spec fija el diseño para que la espera no cueste re-descubrimiento.
- **R2 — El ejecutor compartido no absorbe una rareza de Claude.** Mitigado por DT-1 (Claude al final y opcional) + `extraFiles`/hooks del contrato como válvulas de escape.
- **R3 — Byte-drift en la migración.** Mitigado por el criterio de VERIFICAR de Fases A/B: diff vacío contra render pre-refactor, no solo "tests verdes".
- **R4 — El contrato se queda corto para el proveedor #3.** Aceptado: el contrato se ajusta CON el proveedor #3 en la mano (para eso es la regla de tres); lo congelado es la forma (3 capas), no cada firma.

## 7. Estimación

- Fase A: ~1 día (extracción mecánica + test de paridad).
- Fase B: ~2-3 días (ejecutor + 4 adapters + verificación byte-a-byte).
- Fase C: ~3-5 días, solo si se decide.
- Mejoras M1+M2: ~medio día. M4+M5: ~1 día. Resto: incremental.
