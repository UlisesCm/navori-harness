idle

Siguiente paso: tras mergear #1044, segundo plan en `navori-boilerplate` — borrar el harness viejo, adoptar navori (`init --scan-monorepo`) y crear el preset local con el bloque de stack + skills propias (tokens/tema + `check:ui`, contrato `@navori/backend`).

Último ciclo (2026-09-23): cerró el **plan de proveedores externos** completo (fases 0-3) y la segunda
tanda de issues de la auditoría de search v2. Plan original (fuera del repo):
`/Users/ulisescm/.claude/plans/por-ahora-solo-el-lovely-badger.md`. Reportes en `.claude/progress/`
(gitignored): `audit_ticket_plan-*.md`, `impl_*.md`, `review_*.md`.

## Plan de proveedores externos — cerrado

| Fase | Issues → PR |
|---|---|
| 0 que deje de mentir | #943→#950, #944→#952, #977→#979 (`.mcp.json` coherente; `--strict` falla solo por eso) |
| 1 `add` deja el plugin funcionando | #958, #962, #966, #967→#969, #965→#973, #974→#976 (`add` renderiza inline) |
| 2 descubrimiento | #980→#983 (docs), #981→#988 (`add --suggest`/`doctor` sugieren proveedores), #982→#995 (recipe de setup) |
| 3 `--recommended` vs `--full` | #989→#996 (eje escrito + e2e de los 5 diferenciales) |

Decisiones de Ulises que no se re-litigan: D04 (`--recommended` no habilita tgrep/codegraph);
un binario ausente nunca gatea `--strict` (hecho por máquina); sugerencias sin mecanismo de silencio
en el primer corte; recipe solo en `docs/recipes/`, puntero por i18n (no campo de manifest).

## Abiertos

- **#978** — versión del binario contra un pin en el manifest (diferido de 0.3; necesita campo nuevo).
- **Flakes de la suite completa bajo carga** (sin issue): tres corridas locales fallaron con
  AssertionError en archivos fuera del diff (`cli.e2e` doctor `--json` ok=false, `global-render`,
  `audit` ×7); pasan aislados y en CI. No son timeouts: apunta a estado compartido entre suites
  (HOME / `~/.navori`) bajo concurrencia. Vale auditoría + issue.
- **#894** — fase 1 hecha (#986); el resto (`primitives/`) dependía de #970, ya cerrado (#975).
- **#947** — D19, bloqueado por decisión hasta ~2026-09-30.
- **#985, #993** — del ciclo paralelo (Spec 0031, admisión de agentes).
- `postInstall` sin TTY (#969) sigue saliendo 0 en el escenario CI que #965 quería marcar —
  tensión consciente, documentada en #973.

## Gotchas operativos (siguen vigentes)

- **Sincronizar en cada tick**: `main` avanza varias veces por hora (hay otra sesión en paralelo).
  `receipt sign` se niega si la rama quedó detrás; tras rebasar sobre un commit que toca infra de
  tests o mueve `lib/`, re-correr tests y revisar `vi.mock`.
- **Escritores en paralelo → `isolation: "worktree"`**, rama cortada de `origin/main` (no de la base
  del worktree). Tope: 2 implementers.
- **Tests sensibles a CI**: picocolors emite ANSI con `CI=true` → `stripVTControlCharacters`; nada
  de asserts que dependan de qué binarios tiene la máquina.
- **Conflicto en un marcador managed** (`AGENTS.md`, hash): tomar cualquier lado y regenerar con
  `bun run render:apply`, nunca a mano.
- **Sin atribución de IA** en commits, PRs ni código (#990/#991).
