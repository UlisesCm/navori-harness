idle

Siguiente paso: `npm publish` de **navori 0.10.1** desde `packages/cli` (lo corre Ulises; el release
#1049 ya está en `main` y el tag `v0.10.1` existe). Tras publicar, `check:assets` deja de avisar que
`navori handoff` falta en la versión publicada.

Después: segundo plan en `navori-boilerplate` — borrar el harness viejo, adoptar navori
(`init --scan-monorepo`) y crear el preset local con el bloque de stack + skills propias
(tokens/tema + `check:ui`, contrato `@navori/backend`).

Último ciclo (2026-09-24): release **0.10.1**. Reportes en `.claude/progress/` (gitignored) y en los
worktrees de cada agente: `workplan_*.json`, `impl_*.json`, `review_*.md`, `audit_ticket_*.md`,
`solution_1027.md`, `challenge_1027.md`.

## Release 0.10.1 — cerrado

| Issue | PR |
|---|---|
| #1025 bug 2 (invariante de semgrep) | #1032 (el Bug 1 lo resolvió #1029) |
| #1023 init avisa binarios faltantes en todo modo | #1033 |
| #1027 regla 6: sin excepción fuera del proyecto, solo mensaje accionable | #1036 |
| #1037 `plan update` con `--progress` repetido | #1040 |
| #1035 regla 6 case-insensitive (APFS) | #1041 |
| #1018 el reporte de stop es la última acción del publisher | #1042 |
| #1034 regla 6 bloquea rutas absolutas dentro del proyecto | #1043 |
| #1028 cuerpo del PR solo con evidencia trazable | #1045 |
| #1024 + #1039 estado efímero fuera de `git status` | #1047 |
| docs y landing | #1048 |
| release | #1049 |

Decisiones de Ulises que no se re-litigan: #1027 sin excepción en la regla 6 (TOCTOU); `maxWords`
de `publisher.md` no se sube (quedó en 3786/3800); `.claude/.gitignore` versionado y escrito en
cualquier modo de `gitignoreHarness`; `.codex/.gitignore` solo con `progress/`; las entradas legacy
`.managed-drift-stamp`/`.routing-watch/` se quedan en `EPHEMERAL_HARNESS_PATHS`.

## Abiertos

- **#1025** — cerrar tras confirmar con `doctor` que #1029 resolvió todo el Bug 1.
- **#1046** — unificar el estado efímero en un directorio neutral de engine (nivel 2, 0.11).
- **Check mecánico del cuerpo del PR** (opción 3 de #1028) — sin issue; el publisher siguió
  inventando datos incluso con la regla nueva. Propuesto, pendiente de decisión.
- **Limitación de #1034**: `"$CLAUDE_PROJECT_DIR/"CLAUDE.md` (comilla cerrada tras la barra) no se
  detecta; el reviewer sugiere quitar comillas antes de comparar. Sin issue.
- **#1031, #1019, #1022** — internos del repo; fuera de 0.10.1.
- **#978, #894, #947 (bloqueado ~2026-09-30), #985, #993** — del ciclo anterior.
- **Flakes de la suite completa bajo carga** (sin issue): `render-provenance.test.ts` hizo timeout
  una vez a 15 s; aislado pasa en 2 s.

## Gotchas operativos (siguen vigentes)

- **Sincronizar en cada tick**: `main` avanza varias veces por hora (hay otra sesión en paralelo).
  `receipt sign` y el reviewer se niegan si la rama quedó detrás: tras cada merge, rebasar las ramas
  en vuelo antes de pedir review o firma.
- **Escritores en paralelo → `isolation: "worktree"`**, rama cortada de `origin/main`. Tope: 2
  implementers. No tocar el checkout principal si otra sesión tiene cambios ahí.
- **Upgrade, no solo onboarding fresco**: un cambio a listas que generan bloques managed o
  `.gitignore` se prueba desde la versión publicada (`npx navori@<última>` + CLI de la rama).
- **Tests que dependen de binarios instalados**: correr también con el binario fuera del PATH.
- **Cuerpo del PR**: revisarlo siempre antes de mergear, o pasarle al publisher un body-file ya
  verificado para que lo publique tal cual.
- **Conflicto en un marcador managed**: tomar cualquier lado y regenerar con `bun run render:apply`.
- **Sin atribución de IA** en commits, PRs ni código (#990/#991).
