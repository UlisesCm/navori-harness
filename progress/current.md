# Sesión actual

**Estado:** `main` en **0.7.4** (tag `v0.7.4`, npm `latest: 0.7.4`), 0 issues, 0 PRs. Los 15
repos Bonum renderizados a 0.7.4 con drift 0. La spec 0016 tiene TODO lo implementable por
código hecho y mergeado.

## Lo que se cerró en esta jornada (sesión `fa4dd30b`, ~9h en auto mode con audit)

**Rollout + auditoría de migraciones** → 2 issues [ALTO] (#588 update pisaba decisiones,
#589 registry congelaba el name) → **resueltos en #590** → release **0.7.3**.

**Spec 0016 (paridad de modos) — 6 PRs, todos mergeados:**

| PR | Lote | Lo esencial |
|---|---|---|
| #591 | L1 | dev-loop directo en allow (con tabla por PM); `Bash(rg:*)` RECHAZADO (`--pre` ejecuta) |
| #592 | L4 | `classifier-round-trips` por tramo de modo; señal nueva `tool-mix` (85%, ciega al modo) |
| #593 | L3 | guard: token `git` → `commit\|push`, −70% en la familia más frecuente |
| #594 | T3.2b | gate-trigger: fork por segmento → fast-path por tokens, costo plano ~15ms |
| #595 | L0/auto | brazo auto documentado: el host SÍ manda shell para todo (ambas variantes de T2.1 refutadas) |
| #596 | T2.3 | researcher + structural-search citan el costo medido (post-0.7.4, sin publicar) |

Release **0.7.4** publicado (verificado contra tarball) + rollout 15/15 a Bonum.

## Lo que sigue — EN ORDEN

**1. Los 2 brazos de L0 (T0.1) — sesiones de Ulises.** Protocolo para que salgan comparables:

- **Tarea**: un ticket chico real, EL MISMO en ambas sesiones (idealmente uno con
  búsqueda + edición + gate; ~30-60 min).
- **Repo**: cualquiera de Bonum (ya en 0.7.4) o este. Sesión nueva por brazo, una en
  `acceptEdits` y una en `default`.
- **Arranque**: `navori audit --start <sessionId>` (o dejar que el hook lo marque).
- **Cierre**: terminar la sesión normal; luego `navori audit --session <id>` y comparar
  contra el brazo auto (`session-fa4dd30b`, documentado en la spec §Fase 0).
- **Qué mirar**: % nativas+MCP del orquestador, si `tool-mix` dispara, búsquedas
  shell/hora. Bonus: lanzar un `researcher` en una de las dos — sus fichas por agente
  contestan si el mandato de shell les llega a los subagentes (pregunta abierta).

**2. T2.1 (doctrina de auto mode)** — con las respuestas de L0. Ya replanteado: resolver
la tensión mandato-del-host vs costo, no asumir que el mandato desapareció.

**3. Re-auditoría §6** — sobre sesiones post-0.7.4; el instrumento (L4) ya existe.

**4. Siguiente release** — T2.3 + lo que salga de T2.1 (no amerita 0.7.5 solo).

## Deuda fuera de la spec (decisiones de Ulises, sin bloquear)

- `bonum-webapp`: harness 0.7.4 SIN commitear (~40 archivos; es el repo que SÍ versiona).
- `bonum-ai-coach-frontend/.codex/` muerto en disco (el rm lo bloqueó el clasificador).
- 13 repos con líneas de `.gitignore` sin commitear (protección solo local).
- `navori update --yes` por repo Bonum adoptaría `packageManager` + libs de test — seguro
  desde 0.7.4 (#588), pero es diff de config.
- 4 worktrees de webapp en 0.5.1 a propósito (heredan al rebasear).
- Spec 0015 T8 abierto: la medición de arranque por subagente nunca se registró.
