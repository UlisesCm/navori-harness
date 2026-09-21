# Sesión actual

**Estado: PR abierto, esperando CI/merge.** Release 0.9.0 (spec `specs/0029-skills-security-quality`)
publicado en PR [#887](https://github.com/UlisesCm/navori-harness/pull/887) (`feat/harness-release-0.9.0`
→ `main`, commit `c102bc13`). El branch anterior (`feat/main-session-model-advisor`) quedó obsoleto:
su único commit propio ya estaba mergeado a `main` como PR #886 antes de arrancar esta sesión.

## Qué entró al PR #887

Spec 0029 completa (T1-T4, R1-R8): 2 skills nuevas (`secure-by-design`, `quality-attributes`),
corrección de provenance/versiones en 14 skills existentes, render del harness self-hosted a 0.9.0,
`docs/references/skills-security-quality.md` (piloto fixture-only de skills OpenAI).

## Cómo se cerró (para que la próxima sesión no repita la duda)

El trabajo de implementación ya estaba hecho al arrancar esta sesión — la sesión anterior se quedó
sin tokens justo después del `render --apply` de T4, antes de correr el gate. `bun check` dio 20
tests rojos en 11 archivos: mezcla de conteos/constantes desactualizados (10→12 skills core, 38→40
total) y regresiones de contenido reales que el render introdujo sin querer. Circuito
implementer→reviewer, 3 rondas:
- Ronda 1: implementer reconcilió las 20 fallas. Reviewer marcó CHANGES_REQUESTED — al agregar el
  "activation trigger" a la descripción de 3 skills (`debug-failure`, `review-diff`, `citty`) se
  había *reemplazado* la descripción completa en vez de añadírselo, perdiendo capacidad real.
- Ronda 2: implementer restauró `review-diff` y confirmó que `citty` (en `lib-skills/`, no
  `skills/`) ya estaba bien — citty 0.1.6 no soporta `enum`, no había que agregarlo de vuelta — pero
  reportó falsamente que `debug-failure.md` ya coincidía con HEAD. El reviewer lo detectó con
  `git diff HEAD -- <archivo>` literal.
- Ronda 3: fix puntual de una línea (`description:` exacta de HEAD) + reviewer confirmó
  `git diff HEAD` vacío en las 3 ubicaciones (`core-assets`, `.claude/skills`, `.agents/skills`).
  APPROVED.

**Lección para subagentes futuros**: pedirle a un implementer "restaura X a su versión de HEAD" no
es suficiente — pedir explícitamente que pegue el `git diff HEAD -- <archivo>` literal en su reporte
(vacío = correcto). Un resumen en prosa de "ya coincide" no es evidencia.

## Deuda conocida, sin issue abierto

- **Presupuesto de `CLAUDE.md` subió de 2500→2550** (`packages/cli/scripts/doc-budgets.manifest.json`)
  para acomodar el índice de las 2 skills nuevas. Revisar margen real tras el merge con
  `node packages/cli/scripts/check-doc-budgets.mjs --list` — probablemente vuelve a quedar ajustado.
- **`docs/research/context-resident-token-reduction-plan.md` y
  `docs/research/model-tier-token-savings-proposal.md`** siguen untracked en el working tree,
  ajenos a este release — decidir si se retoman o se descartan.
- **`.pnpm-store/` untracked** — no se tocó, pero conviene confirmar que está en `.gitignore` para
  que no vuelva a aparecer en cada `git status`.
- Deuda heredada de la sesión del 17-sep (fixtures de #868 en árbol fuente, carrera latente en
  `sweepRetiredNames`, nota temporal de #872 en CLAUDE.md atada al subcomando `receipt`) sigue sin
  issue — nada de esto se tocó en este ciclo.

## Próximo paso explícito

Revisar CI del PR #887 y mergear si pasa. Después, confirmar si el margen de `CLAUDE.md` quedó
demasiado ajustado otra vez antes de agregar más doctrina.
