# Engines — cómo agregar un proveedor

Un "engine" materializa el harness (agents, skills, hooks + archivos propios) en
el formato de una herramienta concreta: `.claude/` para Claude Code, `.codex/` +
`AGENTS.md` para Codex, `AGENTS.md`/`.cursor/`/`.github/` para los prose engines.

Este documento es el contrato que un proveedor N+1 debe implementar y el checklist
para llegar ahí. Es el resultado de las Specs [0007](../../../../specs/0007-render-plan-unificado.md)
(spine compartido) y [0008](../../../../specs/0008-fase-c-claude-spine.md) (Claude sobre el spine).

## Las 3 capas (todo engine de disco las comparte)

```
resolveHarnessPlan ──▶ EngineAdapter (place*) ──▶ collectPlan ──▶ commitWrites
   (Capa 1, shared)      (Capa 2, por engine)       (Capa 3, shared, escribe una vez)
```

- **Capa 1 — `shared/harness-plan.ts`**: `resolveHarnessPlan(config, coreAssets, preset, { includeLeader })`
  resuelve QUÉ emitir (agents/skills/hooks) desde config + preset + libraries. No
  conoce rutas ni formatos. Es la MISMA para todos; el parity test
  (`__tests__/engine-parity.test.ts`) garantiza que Claude y Codex parten del
  mismo inventario.
- **Capa 2 — el adapter del engine (`<engine>/adapter.ts` o inline)**: lo ÚNICO
  que define un proveedor. Mapea cada asset planeado a un `PlacementRequest`
  (destino + serialización) y declara sus `extraFiles`, `orphanScans`,
  `backupTargets`. ~80 LOC de tabla declarativa.
- **Capa 3 — `shared/execute-plan.ts`**: `collectPlan` (planea sin escribir) +
  `commitWrites` (backup → escritura atómica → chmod → poda → reporte). Se comparte
  una sola vez: un fix de poda/anti-retroceso/backup llega a todos los engines.

## El contrato `EngineAdapter` (congelado — `shared/execute-plan.ts`)

```ts
interface EngineAdapter {
  id: string;
  label?: string;                                    // nombre para el mensaje de error
  placeAgent(a: PlannedAgent, ctx): PlacementRequest | null;   // null = no lo emite
  placeSkill(s: PlannedSkill, ctx): PlacementRequest | null;
  placeHook(h: PlannedHook, ctx): PlacementRequest | null;
  extraFiles(ctx): PlacementRequest[];               // settings.json / config.toml / AGENTS.md
  orphanScans(plan, ctx): OrphanScan[];              // poda de huérfanos managed
  backupTargets: string[];
}
```

Un `PlacementRequest` es o bien un asset (`assetPath`, renderizado por
`renderManagedFile`) o un `body` ya serializado por el adapter (`config.toml`,
`.toml` de agente). `firstRenderSeed` siembra header/trailer solo la primera vez.

### Válvulas para lo que el contrato no modela

- Un engine con archivos propios (settings, scripts, un pipeline como el de
  `CLAUDE.md`) los construye en su función `render<Engine>Engine`, fusiona su
  `pending` con el de `collectPlan`, y llama **un solo** `commitWrites` — así
  comparte backup, orden de escritura y superficie de error. Ver
  `claude/index.ts` como referencia (pipeline CLAUDE.md + reconciliación de 3
  vías Claude-only sobre el spine).
- `commitWrites` parametriza lo que legítimamente varía: `writeLast` (qué archivo
  se escribe al final), `backupTargets`/`backupExclude`, `engineLabel`,
  `removalsBestEffort`, y `skipReason` (prosa de skip localizada) en `collectPlan`.

## Checklist de spike para el proveedor #3 (los 4 unknowns de la Fase 0)

Antes de escribir el adapter, resuelve estos cuatro contra la CLI real (fue el
método de la Spec 0004 §Fase 0 para Codex):

1. **Payload de hooks** — ¿qué recibe un hook y por qué canal (stdin/env/arg)?
   ¿En qué eventos (PreToolUse/SessionStart/Stop…)? ¿Corren en sandbox?
2. **Discovery de skills** — ¿de qué directorio lee las skills la herramienta?
   (Codex: `.agents/skills/<id>/SKILL.md`; Claude: `.claude/skills/<id>/SKILL.md`
   — forma-directorio; Claude Code solo auto-descubre esa forma, no el `<id>.md` plano.)
3. **Ubicación de config** — ¿dónde vive la config del proyecto y en qué formato?
   (Claude: `.claude/settings.json`; Codex: `.codex/config.toml`.)
4. **Mapa de modelos** — ¿cómo nombra sus modelos? Mapea los tiers Claude
   (opus/sonnet/haiku) a ids concretos (ver `CODEX_MODEL_BY_CLAUDE_TIER` +
   override `models.codexMap`, Spec 0007 M3).

## Criterio DT-2 — cuándo factorizar más (regla de tres)

Con 2 implementaciones la abstracción se adivina; con 3 se factoriza contra casos
reales. El spine (Capas 1+3) ya existe porque Codex y Claude lo comparten. El
contrato `EngineAdapter` (Capa 2) se **ajusta con el proveedor #3 en la mano**,
no antes: lo congelado es la forma (3 capas), no cada firma. Un bug de divergencia
("fix aplicado a un engine y olvidado en el otro") también justifica factorizar.

## Skills en split-root (`.agents/skills/`) — sellado (Spec 0007 M7)

Codex descubre skills de repo en `.agents/skills/<id>/SKILL.md`, un directorio
**cross-tool**: otros agentes que respetan la convención `AGENTS.md`/`.agents/`
también las leen. El resto de la config de Codex vive en `.codex/`.

Este split (`.agents/` para skills, `.codex/` para lo demás) está **sellado**: es
el seam multi-proveedor gratis. Un proveedor #3 que también lea `.agents/skills/`
comparte las skills sin re-render. No lo colapses a un único árbol por engine.

**Recomendación para repos destino**: versiona `.agents/skills/` y `.codex/`
(son managed, reconstruibles con `navori render`, pero útiles en el diff del PR);
si prefieres no versionarlos, agrégalos al `.gitignore` del repo destino junto con
`.claude/` — navori no gestiona el `.gitignore` del repo, es decisión del equipo.

> **`.codex/hooks/` y worktrees**: a diferencia de `.claude/`, versionar
> `.codex/hooks/` no es solo cosmético. Si `.codex/` está gitignored/untracked,
> un git worktree recién creado **no lo hereda**; una sesión de Codex abierta
> **dentro** de ese worktree carga su config por raíz-de-proyecto (marcador
> `.git` del worktree), no encuentra `.codex/config.toml` y **no registra los
> hooks** — el guard destructivo queda silenciosamente apagado. Codex corre los
> hooks con el *session cwd* y no expone un env var de raíz de proyecto
> (equivalente a `$CLAUDE_PROJECT_DIR`), así que la resolución vía path no lo
> arregla: la defensa robusta es **trackear `.codex/hooks/` en git** para que
> viaje a cada worktree y clon. `navori doctor` lo advierte si están sin
> versionar (`guardNotVersioned`).

## Prose engines (agents-md / cursor / copilot) — NO usan el spine

Comparten su propio spine (`renderProseFile`) y son wrappers de ~40 LOC. No
emiten agents/skills/hooks por archivo; migrarlos al `EngineAdapter` sería churn
sin ganancia (Spec 0007 DT-1).
