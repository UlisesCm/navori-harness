# Gestión del `.gitignore` del harness — Design

## Approach

Reutilizar íntegra la maquinaria de bloques managed existente en vez de reinventar el escritor de la rama stale. El flavor `"shell"` de `marker.ts` (`# navori:managed start id=…`) produce líneas que git trata como comentarios válidos en `.gitignore`, y `injectManagedSection` ya resuelve create / update / unchanged / user-modified-skip / downgrade-skip preservando el contenido del usuario fuera del bloque. El precedente exacto es `.codex/config.toml`, un archivo `#`-comment que navori ya crea-o-reconcilia vía `collectExtraFile` + `firstRenderSeed`.

El bloque se deriva **en cada render** desde `(modo, config.engines)`, por lo que la reconciliación (quitar `.codex/`/`AGENTS.md` al remover el engine codex, p.ej.) sale gratis: el cuerpo se recalcula y `injectManagedSection` reescribe solo su región.

Trade-off descartado: el diseño binario + texto-plano + solo-en-`init` de `a92cdea`. No reconcilia, no distingue machine-local de harness-versionable, y su header hardcodeado en español ignora `language`. Se toma como referencia negativa, no como base.

## Components

- **`packages/cli/src/engines/shared/gitignore-harness.ts`** (nuevo) — responsabilidad única: dado `(config)`, devolver el cuerpo del bloque (lista de entradas) según el modo. Exporta:
  - `CUBO_A_ENTRIES: readonly string[]` — machine-local/runtime (constante). Cubre R3.
  - `buildGitignoreBody(config): string | null` — `null` si modo `off`; si `local`, solo Cubo A; si `full`, Cubo A + Cubo B. El Cubo B se calcula filtrando `ENGINE_OUTPUTS` por `config.engines` y colapsando con `engineOwnedPaths()` (reusa el helper de `health.ts`). Cubre R3, R4, R8.
- **`packages/cli/src/lib/schema.ts`** — agregar `gitignoreHarness: z.enum(["off","local","full"]).default("off")` a nivel raíz de `NavoriConfigSchema` (junto a `branchBase`), con comentario de bloque JSDoc. Cubre R1.
- **Enganche en el flujo de render** — en `render.ts`, tras `renderClaudeEngine`/`renderNonClaudeEngines` y antes de reportar, un paso engine-agnostic que: lee el `.gitignore` existente (`""` si no existe), llama `buildGitignoreBody(config)`, y si no es `null` invoca `collectExtraFile` (o `injectManagedSection` directo) con `destRelPath: ".gitignore"`, `commentStyle: "shell"`, `managedId: "gitignore-harness"`, `firstRenderSeed`. El resultado entra al array de writes/preview con su status. Respeta `--force` para R7 y `dryRun` para R9. Cubre R2, R5, R6, R7, R9.
- **`packages/cli/src/commands/doctor.ts`** — extender el scan para, cuando `modo ≠ off`, comparar el hash del bloque managed en `.gitignore` (vía `computeManagedHash`/`extractManagedContent`) contra `buildGitignoreBody(config)` y reportar drift/ausencia. Reusa `isGitWorkTree`. Cubre R10.
- **`packages/cli/src/lib/i18n.ts`** — strings del header del bloque y del reporte (ES/EN). Cubre R11.
- **`packages/cli/scripts/gen-schemas.mjs`** (ejecutar, no editar) — `pnpm gen:schemas` regenera los 4 JSON Schema publicados; sin esto `schema-publish.test.ts` falla. Cubre R11.

## Decisions

- **Enum tri-estado, default `off`** — decisión de producto del usuario. `off` = back-compat exacto (R8); `local` = subconjunto de `full` (Cubo A siempre incluido). Un boolean no expresaba el modo self-hosted "versiona el harness pero ignora lo local".
- **Marcadores managed, no texto plano** — única vía para reconciliar de forma segura (R5) y detectar drift (R10). El flavor `shell` no se infiere por la extensión `.gitignore` → se pasa `commentStyle: "shell"` explícito (igual que `config.toml`).
- **Escritura engine-agnostic a nivel `render.ts`, una sola vez** — el `.gitignore` es del repo, no de un engine. Se escribe una vez aunque haya varios engines; el Cubo B se deriva de `config.engines`, no del engine que corre. Evita duplicar el bloque por-engine.
- **Cubo A vs Cubo B derivados, no hardcodeados en bloque** — el Cubo B sale de `ENGINE_OUTPUTS`/`engineOwnedPaths` (single source of truth), así que si un engine agrega outputs en el futuro, el bloque los recoge sin tocar esta feature. El Cubo A sí es una constante local (no es derivable de outputs: es runtime/machine-local).
- **Outputs extra no-managed (`.mcp.json`)** — `ENGINE_OUTPUTS` solo lista archivos marker-managed/prose (para el scan de drift), así que `.mcp.json` (JSON generado por el engine Claude, presente en su `backupTargets`) no está ahí. Se agrega vía un mapa local `ENGINE_EXTRA_OUTPUTS = { claude: [".mcp.json"] }` para que el modo `full` sí lo ignore. En cambio `navori.config.json` NUNCA entra al bloque en ningún modo: es el source of truth checked-in y se versiona incluso en modo `full` (de él reconstruye `render`).
- **`progress/` (raíz) NO se ignora** — solo `.claude/progress/` es efímero. `progress/current.md`/`history.md` son git-persisted por diseño. El Cubo A lista `.claude/progress/`, nunca `progress/`.
- **Migración de los `.gitignore` hand-written fuera de scope** — al activar la flag, el bloque managed se inserta; las líneas hand-written equivalentes quedan fuera del bloque (git dedupe patrones idénticos, inofensivo). Limpiar el bloque manual viejo es una tarea de roll-out por-repo, no de esta feature. Se documenta, no se automatiza aquí.
