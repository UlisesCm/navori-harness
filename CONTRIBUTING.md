# Cómo contribuir a navori

**Lee primero [`docs/DIRECTION.md`](docs/DIRECTION.md)** — es la fuente de verdad del objetivo,
metas, no-metas e invariantes de navori. Aplica a humanos **y** agentes de IA: si tu idea
contradice un invariante o reabre una no-meta, abre/edita una spec en `specs/` antes de tocar
código; no la metas en un PR suelto.

## Antes de codear

1. Lee `docs/DIRECTION.md`, luego `docs/architecture.md` (cómo funciona el render y las 5 capas)
   y la(s) spec(s) del área que vas a tocar (`specs/000X-*.md`). Respeta el `Status` de cada
   spec (`proposed` / `planning only — NO implementar` / `EJECUTADA`).
2. Pregúntate: ¿es lo más simple? ¿legible en 6 meses? ¿mantiene el patrón existente?
   Simplicidad > cleverness.

## Quality gate (obligatorio antes de cerrar cambios en `packages/cli`)

Es lo que valida el job `quality` de CI; si no pasa, el PR falla:

1. `cd packages/cli && pnpm test` — suite vitest.
2. `cd packages/cli && pnpm lint` — oxlint.
3. **Desde la raíz del monorepo**: `pnpm format:check` — biome (el paso que más se olvida; NO
   está bajo `packages/cli`). Si falla, corre `pnpm format` antes de commitear.
4. **Si tocaste cualquier cosa que alimente el render**: `pnpm check:render` desde la raíz. Este
   repo se auto-hospeda —`.claude/` y `CLAUDE.md` son salida de `navori render`—, así que el PR
   debe incluir el re-render del espejo (`node packages/cli/dist/index.js render --apply`) o el
   job `quality` queda en rojo (#421). Disparadores; cualquiera de los cuatro obliga al re-render:
   - **assets del core**: `packages/core/core-assets/**`.
   - **assets de un plugin**: `packages/plugins/*/{managed,scripts,skills,hooks}/**` y el
     `plugin.json` que los declara. El build los empaqueta igual que los del core
     (`packages/cli/scripts/copy-assets.mjs`) y renderizan bloques dentro de `CLAUDE.md` y
     archivos bajo `.claude/`. **Por aquí se coló #429**: tocó un asset de plugin, no del core, y
     el espejo quedó desfasado un día.
   - **el bump de versión de `packages/cli/package.json`**: el marcador de cada bloque managed
     estampa `readCliVersion()`, así que subir la versión desfasa el espejo **entero** — medido en
     0.6.0 → 0.6.1: **30 archivos** `updated`, 16 bloques de `CLAUDE.md`. Un commit
     `chore(release)` NO es una excepción; ver "Releases" en el `README.md`.
   - **el `navori.config.json`** de este repo, que define qué se renderiza.

   El check rebuildea antes de renderizar a propósito: `dist/assets/` es una copia del core y de
   los plugins hecha en build, y renderizar con un `dist` viejo compara contra los assets
   anteriores y pasa en silencio.

CI corre además `pnpm --filter navori build` y `check:size` (guard de bundle size). Cambios
**doc-only** (.md): basta `pnpm lint` + `pnpm format:check`; no necesitas la suite completa.

## Commits y PRs

- Commits: Conventional, español MX, atómicos (`feat|fix|chore|docs(scope): mensaje`).
- Cada ticket en branch nueva con base `main`. **Este repo mergea a `main`** (excepción a la
  regla Bonum de mergear a `develop`).
- No commitees el harness local (`CLAUDE.md`, `.claude/`) de un repo `/bonum`.
