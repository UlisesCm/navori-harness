# Spec 0001 — Render por workspace en monorepos

**Status:** proposed
**Date:** 2026-06-09
**Driver:** Ulises Ciprés
**Validation case:** `~/Documents/dev/moonar/moonar-medusa-monorepo` (pnpm + turbo, `apps/backend` Medusa + `apps/storefront` Next.js)

## Problema

`navori` ya detecta monorepos (`detect.ts:288-309`) y el schema reserva el slot:

```ts
monorepo: {
  enabled: boolean,
  tool: "pnpm" | "turbo" | "nx" | "rush" | "lerna" | "npm",
  workspaces: Array<{ name, path, preset?, qualityGate? }>
}
```

Pero `render.ts:26` solo escribe **un** `CLAUDE.md` en el root:

```ts
const claudeMdPath = `${cwd}/CLAUDE.md`;
```

Las apps internas no reciben `.claude/`, ni `CLAUDE.md` propio, ni se diferencian por preset. En la práctica los usuarios mantienen `apps/*/CLAUDE.md` a mano (caso moonar) y pierden el modelo managed.

## Diseño propuesto

### Modelo de cascada

| Nivel | Ámbito | Source of truth |
|-------|--------|-----------------|
| Root | `engines`, `language`, `branchBase`, `commits`, `plugins`, `harness`, `models`, `sdd`, `agentAssignments` | `navori.config.json` |
| Workspace | `preset`, `qualityGate` (override puntual) | `monorepo.workspaces[i]` |

El workspace **hereda todo** del root y solo puede overridear `preset` y `qualityGate` (los dos campos que ya están en el slot). Esto deja la decisión de "estructura" en el root y la decisión "técnica del stack" por app.

### Comportamiento de `render`

```
if config.monorepo?.workspaces?.length > 0:
  render root (managed blocks + .claude/ compartido)
  for each ws in workspaces:
    render at <root>/<ws.path>/
      CLAUDE.md   ← managed blocks específicos del preset del ws
      .claude/    ← agents/skills/hooks (opcional override sobre root)
else:
  render root only  ← back-compat con repos single-app
```

Si un workspace no declara `preset`, hereda el del root. Si declara uno distinto (`medusa`, `nextjs-app`, `astro`), se renderiza con los managed assets de ese preset.

### Nuevos comandos / flags

| Comando | Propósito |
|---------|-----------|
| `navori init --scan-monorepo` | Lee `pnpm-workspace.yaml` / `package.json#workspaces` / `turbo.json`, expande globs, popula `monorepo.workspaces[]` con prompts (preset por app). |
| `navori scan` | Re-detecta apps nuevas en el monorepo y propone agregarlas al config. |
| `navori render --workspace <name>` | Renderiza solo un workspace (para iteración rápida). |
| `navori sync --workspace <name>` | Sync acotado a un workspace. |

### Comportamiento de `sync`

Mismo modelo actual (managed blocks managed, lo demás del usuario), pero acotado al `CLAUDE.md` del workspace que toque. Idempotente por workspace.

## Componentes a tocar

- `packages/cli/src/commands/render.ts` — iterar `workspaces[]`, llamar a `computeRenderPlan` por path.
- `packages/cli/src/lib/render-plan.ts` — aceptar `baseDir` y `presetOverride` como param (no asumir cwd ni preset del root).
- `packages/cli/src/lib/bundled-assets.ts` — index de presets por nombre con sus managed assets, hoy implícito.
- `packages/cli/src/commands/init.ts` — flag `--scan-monorepo` + prompts UI con `@clack/prompts`.
- `packages/cli/src/lib/detect.ts` — expandir globs de `pnpm-workspace.yaml` (`apps/*` → `apps/backend`, `apps/storefront`).
- `packages/cli/src/commands/sync.ts` — soporte `--workspace`.
- **Nuevo**: `packages/core/core-assets/presets/` con presets por stack de app (`medusa.json`, `nestjs.json`, `nextjs-app.json`, `astro.json`) — define qué managed assets se aplican.
- Tests: workspace iteration, cascada, back-compat con monorepos sin `workspaces[]` declarado.

## Open questions

1. **Back-compat sin `workspaces[]`**: si el repo es monorepo pero el config no declara workspaces, ¿qué hacer?
   - **Propuesta**: render solo root, warn en `doctor` "monorepo detectado pero workspaces[] vacío — corre `navori scan`".

2. **`engines` per-workspace**: ¿permitirlo? Caso: backend solo Claude, frontend Claude+Cursor.
   - **Propuesta v1**: no permitirlo. Engines comunes a todo el monorepo simplifica el modelo. Revisable en v2 si hay demanda.

3. **`.claude/` compartido vs per-app**: ¿el root tiene `.claude/` y los apps lo heredan via symlink? ¿O cada app tiene su propio `.claude/` rendered?
   - **Propuesta**: render full `.claude/` por app (más simple, mayor footprint). El "compartido" se logra con presets que definen el mismo set base.

4. **Plugins per-workspace**: ¿plugin `acli` solo en backend? El schema actual solo permite plugins a nivel root.
   - **Propuesta v1**: plugins solo root (común a todo el monorepo). Mover a per-workspace si el caso aparece.

5. **Quality gate per-workspace**: ¿el comando `quality-gate fast/full` se ejecuta desde root con `pnpm -F` o desde el workspace?
   - **Propuesta**: el quality gate declarado per-workspace se ejecuta `cd <workspace.path> && <quality.full>`. El root tiene un quality gate "all" que itera workspaces.

## Caso de validación: moonar-medusa-monorepo

Config target después de implementación:

```json
{
  "name": "moonar-medusa-monorepo",
  "engines": ["claude"],
  "preset": "monorepo-turbopnpm",
  "language": "es",
  "monorepo": {
    "enabled": true,
    "tool": "turbo",
    "workspaces": [
      {
        "name": "backend",
        "path": "apps/backend",
        "preset": "medusa",
        "qualityGate": { "fast": "pnpm -F backend lint", "full": "pnpm -F backend test" }
      },
      {
        "name": "storefront",
        "path": "apps/storefront",
        "preset": "nextjs-app",
        "qualityGate": { "fast": "pnpm -F storefront lint", "full": "pnpm -F storefront test" }
      }
    ]
  }
}
```

`render` produce:

```
/CLAUDE.md                     ← managed blocks del root (idioma, rol, branching)
/.claude/agents/...            ← agents compartidos
/.claude/skills/...
/apps/backend/CLAUDE.md        ← managed con preset medusa
/apps/backend/.claude/         ← skills de medusa (database migrations, etc)
/apps/storefront/CLAUDE.md     ← managed con preset nextjs-app
/apps/storefront/.claude/      ← skills de Next (RSC, app router, etc)
```

## Plan de implementación (fases)

1. **Fase 1 — Iteración**: refactor `render.ts` para iterar `workspaces[]` con `baseDir` parametrizado. Sin presets nuevos: cada workspace usa el preset del root como override default.
2. **Fase 2 — Presets de app**: crear presets `medusa`, `nextjs-app`, `nestjs-app`, `astro` en `@navori/core/core-assets/presets/`. Cada uno declara su set de managed assets.
3. **Fase 3 — Discovery**: `--scan-monorepo` en init + comando `scan`. UX con prompts para elegir preset por app detectada.
4. **Fase 4 — Sync acotado**: `--workspace` en render y sync para iteración rápida.

Cada fase es PR independiente. Fase 1 desbloquea moonar a usar navori mínimamente; Fase 2+ refina.
