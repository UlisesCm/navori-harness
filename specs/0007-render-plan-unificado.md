# Spec 0007 — Render plan unificado: eliminar duplicidad Claude ↔ Codex (runbook ejecutable)

**Status:** partially executed — M1 y Fase A ejecutadas y verdes; Fases B/C gated (DT-2)
**Fecha:** 2026-07-28
**Driver:** Ulises Ciprés
**Depende de:** [Spec 0002](./0002-claude-engine-adapter.md) (engine Claude), [Spec 0004](./0004-codex-engine-adapter.md) (engine Codex, mergeado en rama `codex`), [Spec 0005](./0005-search-efficiency-layer.md)
**Objetivo:** que el proveedor N+1 cueste ~80 LOC de tabla declarativa (no 573 de reimplementación) y que un fix de pipeline llegue a todos los engines a la vez.

> **Cómo leer esta spec (agente ejecutor):** ejecuta SOLO las fases marcadas `EJECUTABLE` en la tabla §2, **en orden**. Cada fase termina con un bloque **VERIFICAR** con comandos exactos; **no avances** hasta que todos pasen. Los diffs se dan con `ANTES` / `DESPUÉS` **literales** — localiza el bloque `ANTES` con grep (NO con número de línea, que puede derivar) y aplica el cambio exacto. Si un comando de VERIFICAR falla, o un bloque `ANTES` no aparece con grep, **detente y reporta** — no improvises. Al terminar cada fase, llena el **Registro de ejecución** al final del archivo.

---

## 1. Problema (medido en el código, no de oído)

`claude/index.ts` (2297 LOC) y `codex/index.ts` (573 LOC) duplican dos categorías de lógica que **no varían por proveedor**:

### 1.1 Resolvers de inventario ("qué emitir")
| Lógica | Claude | Codex |
|---|---|---|
| Skills: core + workflow + preset extras + libraries | loops en `claude/index.ts` (`buildSkillsIndexBody`, emisión `.claude/skills/`) | `collectSkillSources` en `codex/index.ts` |
| Agents: `CORE_AGENTS` × `isAgentEnabled` + preset extras | loop propio en claude | `collectAgentSources` en codex |
| Hooks: guard-destructive siempre; quality-gate si `config.qualityGate.fast` | inline | inline |

Ambos consultan el catálogo compartido (`shared/harness-assets.ts`) — el catálogo NO está duplicado; el **recorrido** sí, con el destino incrustado en el loop.

### 1.2 Pipeline de ejecución ("cómo escribir")
Plan → backup → escritura atómica → chmod → poda de huérfanos → reporte: existe dos veces (inline en claude; `collectPlan`/`planManagedAsset`/`planRawManagedFile`/`collectOrphanedManagedFiles` + bloque de escritura en codex).

**El riesgo real es la divergencia silenciosa:** un fix en la poda de huérfanos de un engine (p.ej. #105) no llega solo al otro. Dos pipelines = dos superficies de bugs para el mismo contrato.

### 1.3 Lo que YA está compartido (preservar, no tocar)
`shared/harness-assets.ts` (catálogo), `shared/prose-harness.ts` (`buildHarnessProse`), `injectManagedSection`/`renderManagedFile`/`parseAsset`/`interpolate` (mecánica de markers).

---

## 2. Estado y gates de ejecución por fase

| Fase | Qué | Estado | Gate |
|---|---|---|---|
| **M1** | Test de paridad de inventario | ✅ **EJECUTADA 2026-07-28** — 3/3 verde | — |
| **A** | Extraer `resolveHarnessPlan` a shared | ✅ **EJECUTADA 2026-07-28** — build+test verde, V-BYTE idéntico | ninguno; riesgo ~0 |
| **B** | `executePlan` compartido + codex como adapter | 🔒 **GATED** | requiere aprobación explícita de Ulises (DT-2: proveedor #3 comprometido O bug de divergencia) |
| **C** | Claude sobre el spine | 🔒 **GATED** | se especifica en spec propia al aprobarse; NO está en este runbook |
| M3-M9 | Mejoras independientes (§9) | 🟡 backlog | aprobación por mejora |

---

## 3. Diseño: resolver una vez → mapear declarativo → ejecutar una vez

```
┌─────────────────────────┐   ┌──────────────────────────────┐   ┌───────────────────────────┐
│ CAPA 1: resolveHarness- │   │ CAPA 2: EngineAdapter        │   │ CAPA 3: executePlan       │
│ Plan (shared)           │──▶│ (por engine, ~80 LOC c/u)    │──▶│ (shared)                  │
│ config+preset+libraries │   │ tabla: asset → destino+forma │   │ backup/write/chmod/poda/  │
│ → HarnessPlan           │   │ + extraFiles (settings/toml) │   │ idempotencia/reporte      │
└─────────────────────────┘   └──────────────────────────────┘   └───────────────────────────┘
```

- **Capa 1** no conoce rutas de destino ni formatos: solo "qué existe y su metadata".
- **Capa 2** es lo ÚNICO que define un proveedor: dónde aterriza cada kind y cómo se serializa (+ archivos propios como `settings.json`/`config.toml` vía `extraFiles`).
- **Capa 3** es la fontanería una sola vez: el anti-retroceso (#79), `user-modified-skipped`, backup, escritura atómica, poda respetando `isRemovableNavoriFile`, idempotencia byte a byte.

---

## 4. Decisiones (DT)

### DT-1 — Claude NO migra en la primera ola
Orden: codex (Fase B) → evaluar claude (Fase C). Si Claude nunca migra, la duplicación igual muere: codex + futuros comparten el spine; Claude queda como único caso especial documentado. Los prose engines (`agents-md`/`cursor`/`copilot`) **no migran**: ya comparten su propio spine (`renderProseFile`) y son wrappers de ~40 LOC — migrarlos es churn sin ganancia.

### DT-2 — Regla de tres: Fase B se ejecuta con proveedor #3 comprometido O al morder un bug de divergencia
Con 2 implementaciones la abstracción se adivina; con 3 se factoriza contra casos reales. Un bug del tipo "fix aplicado a un engine y olvidado en el otro" adelanta la ejecución (es la prueba de que la duplicación ya cobra intereses). Mientras tanto: M1 vigila la divergencia de inventario en cada `pnpm test`.

### DT-3 — El contrato `EngineAdapter` (§7.1) se congela en esta spec
Todo engine nuevo escrito ANTES de la Fase B debe estructurarse internamente como si el contrato existiera (tabla de placement separada de la fontanería), para que su migración sea mecánica.

### DT-4 — Toda migración se valida byte a byte, no solo con tests verdes
Procedimiento V-BYTE (§5). La extracción no puede cambiar ni un byte de lo emitido.

### DT-5 — La colisión de `AGENTS.md` entre `agents-md` y `codex` YA está resuelta (verificado)
El dispatcher (`commands/render.ts`, función `renderNonClaudeEngines`) salta `agents-md` con warning cuando `codex` está activo, y codex reusa el managed-id `navori-agents` para hacer upgrade in place del bloque. **No hay fase que ejecutar aquí.** (Esto corrige la "M2" de la versión anterior de esta spec, que la daba por pendiente.)

---

## 5. Procedimiento V-BYTE (compartido por Fases A y B)

Congela un baseline ANTES de editar y compara al final. Ejecutar desde la raíz del repo navori.

```bash
# ── PASO 0 (ANTES de editar nada): baseline ──
TMP=$(mktemp -d) && mkdir -p "$TMP/repo"
cat > "$TMP/repo/navori.config.json" <<'EOF'
{ "name": "byte-diff-check", "version": "1.0.0", "preset": "nextjs", "engines": ["codex"], "language": "es",
  "qualityGate": { "fast": "pnpm test", "full": "pnpm test" },
  "plugins": { "engram": { "enabled": true } } }
EOF
(cd packages/cli && pnpm build)
node packages/cli/dist/index.js render --cwd "$TMP/repo" --apply
cp -R "$TMP/repo" "$TMP/before"
echo "BASELINE OK en $TMP"   # ANOTA la ruta $TMP — la necesitas al final de la fase

# ── PASO FINAL (tras aplicar los cambios de la fase): comparar ──
(cd packages/cli && pnpm build)
rm -rf "$TMP/repo" && mkdir -p "$TMP/repo" && cp "$TMP/before/navori.config.json" "$TMP/repo/"
node packages/cli/dist/index.js render --cwd "$TMP/repo" --apply
diff -r "$TMP/before" "$TMP/repo" && echo "OK: byte-idéntico"
```

Si `diff` imprime CUALQUIER diferencia: **detente y reporta** el diff completo.

---

## 6. Fase M1 — Test de paridad de inventario ✅ EJECUTADA

**Archivo:** `packages/cli/src/engines/__tests__/engine-parity.test.ts` (commiteado; 3/3 verde el 2026-07-28).

Qué garantiza: para un mismo config, Claude y Codex emiten el MISMO conjunto semántico de skills (`.claude/skills/*.md` ↔ `.agents/skills/*/`), agents (`.claude/agents/*.md` ↔ `.codex/agents/*.toml`, excluyendo `leader` — diff intencional: el hilo principal de Codex encarna al leader) y hooks (`.claude/hooks/*.sh` ↔ `.codex/hooks/*.sh`). Un asset cableado en un engine y olvidado en el otro revienta la suite, no producción.

**Regla de mantenimiento (para ejecutores futuros):** si este test falla, NO lo maquilles agregando a `AGENT_KNOWN_DIFFS` — una falla es una divergencia real. Repórtala al driver; solo se agrega a `KNOWN_DIFFS` con su aprobación y con el porqué comentado en el código.

**VERIFICAR (ya pasado, re-ejecutable):**
```bash
cd packages/cli && npx vitest run src/engines/__tests__/engine-parity.test.ts   # 3 passed
```

---

## 7. Fase A — Capa 1: `resolveHarnessPlan` ✅ EJECUTADA

Extrae los resolvers duplicados a `shared/`. Codex la consume; Claude NO se toca (DT-1). **Ejecuta el PASO 0 de V-BYTE (§5) antes de editar.**

### A.1 — NUEVO archivo `packages/cli/src/engines/shared/harness-plan.ts` (contenido completo)

```ts
import { basename, join } from "node:path";
import type { NavoriConfig } from "../../lib/config.ts";
import { librarySkillById } from "../../lib/library-skills.ts";
import type { loadPreset } from "../../lib/presets.ts";
import {
  CORE_AGENTS,
  CORE_SKILLS,
  WORKFLOW_SKILLS,
  extraConditionMet,
  isAgentEnabled,
} from "./harness-assets.ts";

/**
 * Provider-agnostic harness inventory (Spec 0007, Capa 1). Resolves WHICH
 * agents/skills/hooks a render must materialize from config + preset +
 * detected libraries. Knows nothing about destinations or formats — those
 * belong to each engine adapter (Capa 2).
 */

export interface PlannedAgent {
  id: string;
  assetPath: string;
  /** Key into config.models / config.effort for per-role assignment. */
  modelKey?: keyof NonNullable<NavoriConfig["models"]>;
}

export interface PlannedSkill {
  id: string;
  assetPath: string;
  managedId: string;
}

export interface PlannedHook {
  /** Basename without extension; engines derive `<dir>/<id>.sh`. */
  id: string;
  assetPath: string;
  managedId: string;
}

export interface HarnessPlan {
  agents: PlannedAgent[];
  skills: PlannedSkill[];
  hooks: PlannedHook[];
}

export function resolveHarnessPlan(
  config: NavoriConfig,
  coreAssets: string,
  preset: ReturnType<typeof loadPreset>,
  options: { includeLeader?: boolean } = {},
): HarnessPlan {
  const agents: PlannedAgent[] = [];
  for (const agent of CORE_AGENTS) {
    // Engines whose main thread embodies the leader (Codex) leave this off.
    if (agent.id === "leader" && options.includeLeader !== true) continue;
    if (!isAgentEnabled(config, agent.harnessKey)) continue;
    agents.push({
      id: agent.id,
      assetPath: join(coreAssets, `agents/${agent.id}.md`),
      modelKey: agent.harnessKey,
    });
  }
  for (const extra of preset?.def.extras.agents ?? []) {
    if (!extraConditionMet(extra, config)) continue;
    agents.push({
      id: basename(extra.destRelPath).replace(/\.md$/, ""),
      assetPath: join(preset!.assetRoot, extra.relPath),
    });
  }

  const skills: PlannedSkill[] = [
    ...CORE_SKILLS.map((id) => ({
      id,
      assetPath: join(coreAssets, `skills/${id}.md`),
      managedId: `${id}-base`,
    })),
    ...WORKFLOW_SKILLS.map((id) => ({
      id,
      assetPath: join(coreAssets, `skills/${id}.md`),
      managedId: id,
    })),
  ];
  const seen = new Set(skills.map(({ id }) => id));
  for (const extra of preset?.def.extras.skills ?? []) {
    if (!extraConditionMet(extra, config)) continue;
    const id = basename(extra.destRelPath).replace(/\.md$/, "");
    if (seen.has(id)) continue;
    seen.add(id);
    skills.push({ id, assetPath: join(preset!.assetRoot, extra.relPath), managedId: extra.id });
  }
  for (const id of config.project?.libraries ?? []) {
    if (seen.has(id) || !librarySkillById(id)) continue;
    seen.add(id);
    skills.push({ id, assetPath: join(coreAssets, `lib-skills/${id}.md`), managedId: id });
  }

  const hooks: PlannedHook[] = [
    {
      id: "guard-destructive",
      assetPath: join(coreAssets, "hooks/guard-destructive.sh"),
      managedId: "guard-destructive-base",
    },
  ];
  if (config.qualityGate?.fast) {
    hooks.push({
      id: "quality-gate-pre-commit",
      assetPath: join(coreAssets, "hooks/quality-gate-pre-commit.sh"),
      managedId: "qg-pre-commit-base",
    });
  }

  return { agents, skills, hooks };
}
```

### A.2 — `packages/cli/src/engines/codex/index.ts`: imports

```
ANTES:   import { basename, dirname, join, relative, resolve } from "node:path";
DESPUÉS: import { dirname, join, relative, resolve } from "node:path";
```
```
ANTES:   import { librarySkillById } from "../../lib/library-skills.ts";
DESPUÉS: (línea eliminada)
```
```
ANTES:
import {
  CORE_AGENTS,
  CORE_SKILLS,
  WORKFLOW_SKILLS,
  extraConditionMet,
  isAgentEnabled,
} from "../shared/harness-assets.ts";
DESPUÉS:
import { resolveHarnessPlan, type PlannedAgent } from "../shared/harness-plan.ts";
```

### A.3 — call sites del cuerpo de `renderCodexEngine`

```
ANTES:   const agentSources = collectAgentSources(config, coreAssets, preset);
DESPUÉS:
  const plan = resolveHarnessPlan(config, coreAssets, preset);
  const agentSources = plan.agents;
```
```
ANTES:   const skillSources = collectSkillSources(config, coreAssets, preset);
DESPUÉS: const skillSources = plan.skills;
```

### A.4 — bloque de hooks (reemplazo completo)

`ANTES` (localizar con `grep -n "hooks/guard-destructive.sh" packages/cli/src/engines/codex/index.ts` — es el bloque de DOS `collectPlan(...)` consecutivos dentro de `renderCodexEngine`):

```ts
  collectPlan(
    planManagedAsset({
      cwd,
      config,
      assetPath: join(coreAssets, "hooks/guard-destructive.sh"),
      destRelPath: ".codex/hooks/guard-destructive.sh",
      managedId: "guard-destructive-base",
      commentStyle: "shell",
      chmodExec: true,
    }),
    pending,
    skipped,
  );
  if (config.qualityGate?.fast) {
    collectPlan(
      planManagedAsset({
        cwd,
        config,
        assetPath: join(coreAssets, "hooks/quality-gate-pre-commit.sh"),
        destRelPath: ".codex/hooks/quality-gate-pre-commit.sh",
        managedId: "qg-pre-commit-base",
        commentStyle: "shell",
        chmodExec: true,
      }),
      pending,
      skipped,
    );
  }
```

`DESPUÉS`:

```ts
  for (const hook of plan.hooks) {
    collectPlan(
      planManagedAsset({
        cwd,
        config,
        assetPath: hook.assetPath,
        destRelPath: `.codex/hooks/${hook.id}.sh`,
        managedId: hook.managedId,
        commentStyle: "shell",
        chmodExec: true,
      }),
      pending,
      skipped,
    );
  }
```

### A.5 — set de hooks deseados en la poda de huérfanos

```
ANTES:
        new Set([
          ".codex/hooks/guard-destructive.sh",
          ...(config.qualityGate?.fast ? [".codex/hooks/quality-gate-pre-commit.sh"] : []),
        ]),
DESPUÉS:
        new Set(plan.hooks.map(({ id }) => `.codex/hooks/${id}.sh`)),
```

### A.6 — borrar código muerto en `codex/index.ts`
1. Borrar la interface `AgentSource` completa (grep `interface AgentSource`).
2. En `planAgentFile`, cambiar el tipo del parámetro: `source: AgentSource` → `source: PlannedAgent`.
3. Borrar la función `collectAgentSources` completa (grep `function collectAgentSources`).
4. Borrar la función `collectSkillSources` completa (grep `function collectSkillSources`).

**VERIFICAR Fase A:**
```bash
# cero referencias muertas:
grep -rn "collectAgentSources\|collectSkillSources\|AgentSource" packages/cli/src && echo "FALLA: quedan referencias" || echo "OK limpio"
cd packages/cli && pnpm build && pnpm test        # suite completa verde (incluye engine-parity 3/3)
cd ../..
# PASO FINAL de V-BYTE (§5) con el $TMP anotado en el PASO 0 → "OK: byte-idéntico"
```

---

## 8. Fase B — Capa 2 + Capa 3 🔒 GATED (NO ejecutar sin aprobación explícita de Ulises)

> El código de esta fase es el **punto de partida congelado** (DT-3). El repo habrá derivado cuando se apruebe: si el build falla por drift, ajusta SOLO imports/tipos, nunca la lógica, y reporta cada ajuste en el Registro.

### 8.1 Contrato `EngineAdapter` (congelado)

```ts
/** One file the engine wants on disk, fully placed (output de la Capa 2). */
export interface PlacementRequest {
  /** Managed asset rendered from a source file (renderManagedFile path)… */
  assetPath?: string;
  /** …or a raw body already serialized by the adapter (config.toml, agent .toml). */
  body?: string;
  destRelPath: string;
  managedId: string;
  commentStyle: "html" | "shell";
  chmodExec?: boolean;
  /** Written before/after the managed block only the FIRST time the file is created. */
  firstRenderSeed?: { header?: string; trailer?: string };
}

export interface OrphanScan {
  /** Dir to scan, relative to cwd (e.g. ".codex/agents"). */
  dir: string;
  /** File filter (e.g. name => name.endsWith(".toml")). */
  match: (name: string) => boolean;
  /** Desired rel paths that must NOT be removed. */
  desired: ReadonlySet<string>;
  /** "file" removes the file; "skill-dir" removes `<dir>/<name>` when SKILL.md is its only child. */
  shape: "file" | "skill-dir";
}

export interface EngineAdapter {
  id: string;
  /** Placement de cada asset del HarnessPlan; null = este engine no lo emite. */
  placeAgent(a: PlannedAgent, ctx: AdapterCtx): PlacementRequest | null;
  placeSkill(s: PlannedSkill, ctx: AdapterCtx): PlacementRequest | null;
  placeHook(h: PlannedHook, ctx: AdapterCtx): PlacementRequest | null;
  /** Archivos que no derivan 1:1 de un asset (settings.json / config.toml / AGENTS.md). */
  extraFiles(ctx: AdapterCtx): PlacementRequest[];
  orphanScans(plan: HarnessPlan, ctx: AdapterCtx): OrphanScan[];
  backupTargets: string[];
  engineWarnings?(ctx: AdapterCtx): string[];
}
// AdapterCtx = { cwd, config, repoRoot, isWorkspace, coreAssets, preset, plugins }
```

### 8.2 — NUEVO `packages/cli/src/engines/shared/execute-plan.ts`
Porta el pipeline de `codex/index.ts` (el más limpio) UNA sola vez. Fuente de cada pieza (localizar por nombre de función, no por línea):
1. Acumulación pending/skipped por status → portar `collectPlan` tal cual.
2. Render de asset managed → portar `planManagedAsset` / `planRawManagedFile` (el executor decide por `assetPath` vs `body` del `PlacementRequest`; `firstRenderSeed` reproduce el seeding de `planAgentsMd`/`planCodexConfig`).
3. Poda → generalizar `collectOrphanedManagedFiles` + `isRemovableNavoriFile` + `readDirSafe` iterando `OrphanScan[]` (las tres pasadas actuales de codex se vuelven 3 entradas de datos).
4. Backup + orden estable (rule-doc/AGENTS.md al final) + escritura atómica + chmod + `RenderWriteError` con hint → portar el bloque `if ((pending.length > 0 || removals.length > 0) && !dryRun)` completo.
5. Reporte `{ written, skipped, warnings, backupPath }` → portar el `return` final.

Además: `git mv packages/cli/src/engines/claude/render-managed-file.ts packages/cli/src/engines/shared/render-managed-file.ts` y actualizar TODOS los imports (`grep -rn "render-managed-file" packages/cli/src`).

### 8.3 — `codex/index.ts` → adapter declarativo
Mapa call-site → contrato (todo el código citado ya existe en el archivo; se mueve, no se reescribe):
| Hoy en codex | Va a |
|---|---|
| `planAgentFile` (serialización .toml + inyecciones de plugins + sandbox + `CODEX_MODEL_BY_CLAUDE_TIER`) | `placeAgent` (devuelve `body`) |
| loop de `skillSources` | `placeSkill` (devuelve `assetPath` + dest `.agents/skills/<id>/SKILL.md`) |
| loop de `plan.hooks` (Fase A) | `placeHook` |
| `planAgentsMd` + `planCodexConfig` + `buildCodexConfigToml` | `extraFiles` |
| `collectOrphanedManagedFiles` (3 pasadas) | `orphanScans` (3 entradas de datos) |
| array de `createBackup` | `backupTargets` |
| warning de versión mínima / hook-trust | `engineWarnings` |

**VERIFICAR Fase B:** `grep` cero referencias a los helpers borrados de codex · `pnpm build && pnpm test` verde (incluye `engine-parity` y `render-codex` intactos) · V-BYTE completo (§5) → "OK: byte-idéntico" · `wc -l packages/cli/src/engines/codex/index.ts` < 250.

---

## 9. Mejoras independientes (backlog priorizado; aprobación por mejora)

| # | Mejora | Detalle | Prioridad |
|---|---|---|---|
| ~~M2~~ | ~~Colisión managed-id `navori-agents`~~ | **RESUELTA** — ver DT-5 (verificada en el dispatcher) | — |
| **M3** | Mapa de modelos configurable | `CODEX_MODEL_BY_CLAUDE_TIER` hardcodea `gpt-5.6-*`; OpenAI renombra más rápido que los releases. Agregar override `models.codexMap: { opus?, sonnet?, haiku? }` en el schema con fallback al mapa fijo. | 🟡 Media |
| **M4** | Sandbox por rol al catálogo | La lista `["reviewer","researcher","ticket-audit","explorer","auditor"] → read-only` vive inline en `planAgentFile`. Es semántica del ROL: moverla a `CORE_AGENTS[i].sandbox` en `harness-assets.ts`. El proveedor #3 la hereda gratis. | 🟡 Media |
| **M5** | Doctor checks Codex | (a) `.codex/config.toml` parsea como TOML; (b) hooks con bit ejecutable; (c) `codex --version` ≥ 0.145.0 si está en PATH (warning); (d) hint de hook-trust — el modo de fallo más traicionero: harness renderizado que parece activo pero Codex no dispara hooks sin confianza persistida (hallazgo Fase 0 de Spec 0004). | 🟡 Media |
| **M6** | Hook SessionStart de engram en Codex | Fase 0 confirmó eventos `SessionStart`/`UserPromptSubmit`/`Stop` en Codex. Emitir el arranque de engram también ahí → misma memoria en ambos proveedores. Requiere spike corto del payload de `SessionStart`. | 🟡 Media |
| **M7** | Sellar el split-root de skills | Skills en `.agents/skills/` (cross-tool, otros agentes también la leen) + resto en `.codex/`. Recomendación: **sellar** (es el seam multi-proveedor gratis), documentarlo en el README del engine y en el gitignore de repos destino. | 🟢 Baja |
| **M8** | Inventario en `doctor --json` | Exponer agents/skills/hooks por engine en salida machine-readable para que CI de los repos afirme paridad tras `render --all`. | 🟢 Baja |
| **M9** | `engines/README.md` — "cómo agregar un proveedor" | El contrato §8.1 + checklist de spike (los 4 unknowns de Fase 0 de Spec 0004: payload de hooks, discovery de skills, ubicación de config, mapa de modelos) + criterio DT-2. | 🟢 Baja |

**Secuencia sugerida:** M4+M5 en la próxima iteración de calidad · M3/M6 cuando haya señal real · M7+M9 antes de que aparezca el proveedor #3 · M8 tras Fase B.

---

## 10. Riesgos
- **R1 — Refactor prematuro.** Mitigado por los gates de §2 + DT-2. M1 (ya activa) vigila la divergencia mientras tanto.
- **R2 — El executor no absorbe una rareza de Claude.** Mitigado por DT-1: Claude al final y opcional; `extraFiles`/`engineWarnings` como válvulas.
- **R3 — Byte-drift en la migración.** Mitigado por V-BYTE (§5) como gate duro, no solo tests.
- **R4 — El contrato se queda corto para el proveedor #3.** Aceptado: se ajusta CON el proveedor #3 en la mano; lo congelado es la forma (3 capas), no cada firma.
- **R5 — Drift del repo vs los diffs de esta spec.** Mitigado: los `ANTES` se localizan por grep, no por línea; si un `ANTES` no aparece, la regla es detenerse y reportar.

## 11. Estimación
Fase A: ~medio día (extracción mecánica + V-BYTE). Fase B: ~2-3 días. Fase C: se estima al especificarse. M4+M5: ~1 día.

---

## Registro de ejecución (el ejecutor llena esto)

| Fecha | Fase | Resultado | Notas |
|---|---|---|---|
| 2026-07-28 | M1 | ✅ 3/3 verde a la primera | Paridad real confirmada: skills idénticos, agents idénticos (excepto `leader`, intencional), hooks idénticos. Archivo commiteado en `engines/__tests__/engine-parity.test.ts`. |
| 2026-07-28 | A | ✅ verde a la primera | `resolveHarnessPlan` extraído a `shared/harness-plan.ts` (113 LOC); codex lo consume. Borrados `AgentSource`/`collectAgentSources`/`collectSkillSources`; `codex/index.ts` 573→486 LOC. Grep de referencias muertas limpio (solo un comentario en engine-parity.test.ts actualizado). `pnpm build && pnpm test` → 72 files/1108 passed. V-BYTE (§5) → byte-idéntico. Sin cambios de comportamiento (DT-4). |
| | B | | |
