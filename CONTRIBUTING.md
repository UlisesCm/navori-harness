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

CI corre además `pnpm --filter navori build` y `check:size` (guard de bundle size). Cambios
**doc-only** (.md): basta `pnpm lint` + `pnpm format:check`; no necesitas la suite completa.

## Commits y PRs

- Commits: Conventional, español MX, atómicos (`feat|fix|chore|docs(scope): mensaje`).
- Cada ticket en branch nueva con base `main`. **Este repo mergea a `main`** (excepción a la
  regla Bonum de mergear a `develop`).
- No commitees el harness local (`CLAUDE.md`, `.claude/`) de un repo `/bonum`.
