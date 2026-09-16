# Sesión actual

**Estado: idle.**

Última jornada (2026-09-16): auditoría de 6 harnesses de referencia → **PR #826** abierto contra
`main` con tres documentos (`docs/research/ecc-lessons.md`, `docs/research/deepseek-harness-lessons.md`,
`docs/inspiration.md`). CI encolado en el run 35059971057 — si sale rojo, el diagnóstico es de
`babysit-prs`.

Detalle completo en `progress/history.md`.

## Siguiente paso

La fase de poda tiene 22 issues abiertos y dos paraguas:

- **#808** — poda de `CLAUDE.md` (3 355 palabras, 0 enlaces, 240 líneas contra el objetivo oficial
  de 200). Orden: **#816** (el patrón "regla auto-contenida + enlace tipado", que es el habilitador)
  → #813, #814, #811, #812 (las cuatro podas) → **#815** (el techo, al final: ponerlo antes congela
  el estado actual como línea base).
- **#822** — criterio de admisión por superficie (plugin / MCP / skill / bloque managed).

Empezar por **#804**: es un error factual en un bloque managed que viaja a cada repo que navori
genera, y cae en área crítica (`deny/ask rules`).

Antes de construir el techo de #815, correr `/doctor` sobre `CLAUDE.md` — la doc oficial dice que
propone recortes con criterio propio (corta lo derivable del código, conserva pitfalls y rationale).
