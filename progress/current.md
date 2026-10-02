# Current — Spec 0039 publication

## Goal
Publicar los pendientes implementados de Spec 0039 hacia dev y preparar T44.

## Instructions
- Sincronizar dev antes de cada trabajo; PRs hacia dev.
- Gate local rápido; cobertura completa solo en CI de main (#1171).

## Discoveries
- Dev3f069fd7 incluye #1169 de presupuesto, #1170 corregido y #1171 de gates. La integración fue fast-forward sin perder cambios.
- T44 exige comparar con la instantánea T9 usando mismo minero/audit.mode; éxito de cache read necesita n >=100 lanzamientos por ventana y banda de ruido de dos ventanas base. No inferir éxito por muestras menores.

## Accomplished
- T37 mergeada en #1167; PR1170 corregido y mergeado, CI rápido verde.
- T34 aprobada sobre dev3f069fd7: siete rutas, scout WebFetch/WebSearch, notas author-agent, Pi intacto, 145 pruebas y fast/render/budgets verdes, receipt ok/fresh.
- T23/T24 implementadas y serializadas sobre la misma base: 392 pruebas enfocadas verdes; revisión final en curso.

## Next Steps
- Publicar T34 y finalizar revisión/publicación T23/T24. Esperar integración antes de T44.
- Medir T44 sin alterar criterios registrados; conservar worktrees por sesiones concurrentes.

## Relevant Files
- packages/core/core-assets/agents/scout.md — acceso web acotado.
- .claude/skills/author-agent/SKILL.md — admisión/retiro y excepción architect.
- packages/core/core-assets/hooks/bash-outcome-watch.sh — advisory de fallos.
- docs/native-overlap.md — matriz generada.
- specs/0039-claude-first/tasks.md — tareas.
