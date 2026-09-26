idle

Siguiente paso: al migrar repos a la versión con #1066, actualizar jscpd a >= 5.1.1 en cada máquina
(`pnpm add -g jscpd@^5.1.1`) antes de re-renderizar, o los commits con TS quedan bloqueados.

Último ciclo (2026-09-25): 7 PRs post-0.10.1 (ver `progress/history.md`). Reportes en
`.claude/progress/` (gitignored).

## Abiertos

- **Worktree que se borra solo con un handoff de solo `markdownRequests`** — sin issue; se pierde
  `impl_*.json` y el handoff queda apuntando a una ruta muerta. Proponer issue.
- **Desfase de `bun.lock`** (0.9.0 → 0.10.1) — sin issue; cada `bun install` lo ensucia. Un PR de
  `chore` lo resuelve.
- **Check mecánico del cuerpo del PR** (opción 3 de #1028) — sin issue; pendiente de decisión.
- **#1046** (nivel 2, 0.11), **#1022**, **#1019**, **#993**, **#985**, **#947** (bloqueado ~2026-09-30).
- **#1064/#1065** (spec 0034, master plan) — los lleva otra sesión.

## Gotchas operativos (siguen vigentes)

- **Sincronizar en cada tick**: `main` avanza varias veces por hora. `receipt sign` y el reviewer se
  niegan si la rama quedó detrás.
- **Escritores en paralelo → `isolation: "worktree"`**, rama cortada de `origin/main`. Tope: 2
  implementers.
- **Cuerpo del PR**: escribirlo a partir del diff y pasarlo como `--body-file` para que el publisher lo
  publique tal cual.
- **`receipt check` desde un worktree** siempre con `--dir .claude/progress` y ejecutado dentro del
  worktree.
- **Prosa managed**: antes de proponer texto, buscar con `git grep` los literales que fijan los tests y
  respetar ≥5% de holgura (`doc-budgets-check.test.ts`).
- **Upgrade, no solo onboarding fresco**: un cambio a listas que generan bloques managed se prueba desde
  la versión publicada.
- **Conflicto en un marcador managed**: tomar cualquier lado y regenerar con `bun run render:apply`.
- **Sin atribución de IA** en commits, PRs ni código.
