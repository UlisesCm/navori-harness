# Sesión actual

**Estado: idle.** Programa de 22 issues de la auditoría de 6 harnesses (2026-09-15, #804–#825)
en ejecución — 1 PR por issue, ciclo `implementer → reviewer → commit-pr-pilot`. **15 de 22
cerrados** (mergeados o PR abierta y aprobada). Ver `progress/history.md` para el detalle completo
de la sesión.

## Mapeo issue → PR

**Fase 0 — seguridad/doctrina en área crítica (los 4, mergeados):**
#804→#827 · #806→#828 · #807→#829 · #805→#830

**Fase 1 — higiene barata (los 4, mergeados):**
#822→#831 · #817→#832 · #810→#833 · #824→#834

**Fase 2 — poda de `CLAUDE.md` (7 de 8):**
#816→#835 (mergeado) · #811→#836 (mergeado) · #813→#837 (mergeado) · #814→#841 (mergeado,
2 rebases + 3 rondas de review) · #812→#842 (abierta, aprobada) · #808→#843 (abierta, aprobada) ·
#818→#844 (abierta, aprobada — **auto-verificada**: el propio ciclo reviewer/commit-pr-pilot
recortado se usó para revisar y commitear su propio PR, sin encontrar carencias)

**Pendiente, sin empezar:**
- **#815** (gate de techo de palabras) — va DESPUÉS de la poda, que ya terminó. Es el siguiente
  natural.
- **Fase 3**: #820 (partir `qualityGate` por superficie), #819 (gate de enlaces muertos — mejor
  después de #820).
- **Fase 4**: #809 (Auto Memory vs engram — **necesita decisión del usuario**, no autoasignable),
  #823 (paths/disable-model-invocation/when_to_use en skills, spec 0025), #821 (registro de
  capacidades por motor), #825 (política de retiro de `.claude/progress/`).

## Hallazgo sin resolver, fuera de alcance de esta sesión

**#838 revirtió la retirada de tgrep/codegraph de #803**, mergeado a mitad de esta sesión. Esto
deja **desactualizados** dos PRs ya mergeados de este mismo programa:
- **#822** (`docs/DIRECTION.md`) documentó tgrep/codegraph como "retirados permanentemente" en su
  tabla de superficie — ya no es cierto.
- **#824** (`structural-search.md`) escribió la doctrina de fallback asumiendo que tgrep/codegraph
  no existen.

Ninguno de los dos se corrigió en esta sesión (fuera de alcance de los issues que los originaron).
**Recomendación**: abrir un issue nuevo, o un PR de ajuste directo sobre ambos docs, antes de que
alguien más cite la tabla de retirados como vigente.

## Otras notas para retomar

- **El binario `navori` global instalado es v0.8.7 obsoleto.** Para cualquier cambio self-hosted en
  este repo, usar el build local: `pnpm --filter navori build && node packages/cli/dist/index.js
  <comando>`.
- **`docs/recipes/skill-authoring.md`** todavía documenta el formato de frontmatter viejo
  (top-level `type`/`maxWords`) tras #810 (que lo movió a `metadata:`) — seguimiento pendiente,
  señalado en el PR #833.
- **`gh-protocol`** (y posiblemente `skills-index`) son candidatos a migrar a skill si `CLAUDE.md`
  vuelve a crecer sobre 200 líneas — señalado en #808/PR #843, no ejecutado (refactor no trivial).
- **Riesgo de concurrencia confirmado**: los subagentes (`implementer`/`reviewer`/
  `commit-pr-pilot`) comparten el mismo working directory que la sesión principal — durante #814 un
  `git stash`/`reset --hard` de un subagente casi pisa el trabajo de otro (nada se perdió,
  recuperado vía `git stash list`/reflog). Además hay OTRA sesión activa en este mismo repo dejando
  un archivo sin trackear (`docs/research/propuesta-simplificacion-agentes.md`) — no tocarlo, no es
  de este programa.
- **`main` se movió muy rápido durante toda la sesión** (PRs mergeándose en minutos) — 4 de los 11
  issues cerrados necesitaron rebase a mitad de ciclo, dos de ellos con conflicto real de merge
  resuelto por el implementer con criterio (nunca a mano por el orquestador).

## Próximo paso explícito

1. Confirmar merge de #842/#843/#844 (o revisar si hay feedback).
2. Seguir con **#815** (gate de techo de palabras), luego Fase 3 y Fase 4 en el orden del plan
   original.
3. Decidir si se abre el issue de seguimiento por el hallazgo de #838 vs #822/#824.
