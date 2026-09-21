# Sesión actual

**Estado: idle — 6 issues abiertos (#889–#894), ninguno arrancado.** No se tocó código en esta
sesión: el trabajo fue triaje e investigación en frío para redactar issues.

## Qué se hizo

Se abrieron 6 issues en `UlisesCm/navori-harness`, cada uno precedido de una investigación en frío
ligera (subagente, externa y/o interna) y con una sección obligatoria **"Investigación requerida al
momento de abordar"** — Ulises pidió explícitamente que cada issue declarara qué falta verificar:

| Issue | Tema | Veredicto de la investigación |
|---|---|---|
| [#889](https://github.com/UlisesCm/navori-harness/issues/889) | biome → oxfmt | Spike, no implementación: oxfmt en **beta**, config separada de oxlint, sin guía de migración desde Biome (solo desde Prettier). No existe `.git-blame-ignore-revs`. |
| [#890](https://github.com/UlisesCm/navori-harness/issues/890) | tsup → tsdown | **Bloqueado**: `splitting: false` se ignora en silencio ([rolldown/tsdown#760](https://github.com/rolldown/tsdown/issues/760)) y el single-file es decisión explícita (`tsup.config.ts:18-20`) de la que dependen `check-bundle-size.mjs` y `bundled-assets.ts:12`. |
| [#891](https://github.com/UlisesCm/navori-harness/issues/891) | política de `progress/` | `progress/` versionado está decidido en `specs/gitignore-harness/design.md:29` (spec cerrada), citado en `tickets.ts:1-23` y en `.gitignore:8-11`. Gitignorearlo supersede 3 decisiones → spec propia. Opción barata: commitear el cierre DENTRO del PR del trabajo. |
| [#892](https://github.com/UlisesCm/navori-harness/issues/892) | spec-bootstrap | `disable-model-invocation: true` borra la skill del contexto; quitarlo **no pierde** `/spec-bootstrap`. No hay gating condicional en frontmatter: el candado va al cuerpo. |
| [#893](https://github.com/UlisesCm/navori-harness/issues/893) | implementer → scribe | Premisa corregida: el ahorro no es bajar de modelo (implementer/auditor/reviewer mezclan juicio y prosa) sino **quitarles la serialización**. Spec 0027: T1 hecho sin marcar, T2/T3/T4 pendientes. Bloqueador: el hook `subagent-stop-handoff` valida `impl_<feature>.md`. |
| [#894](https://github.com/UlisesCm/navori-harness/issues/894) | estructura de carpetas | `src/lib/` = 67 archivos sueltos; **el disco no refleja las 5 capas de `architecture.md`** (Workspace y Project config no tienen carpeta). 17 archivos >500 líneas. Coverage anclada a `"src/lib/**"` y a `"src/lib/args.ts"` en `KNOWN_ZERO`. |

## Decisiones que quedaron pendientes de Ulises

- **#891**: ¿el dolor es "menos PRs sueltos" (opción A, barata) o "el estado de sesión no pertenece
  a git" (opción B, spec propia y decisión también para los repos consumidores)?
- **#892**: quitar el flag cambia una garantía dura (imposible por construcción) por una guarda que
  depende de que el modelo la respete.
- **#894**: elegir criterio de éxito antes de mover un archivo; recomendación del issue es
  **A + C** (alinear `lib/` con las capas + higiene) descomponiendo los archivos gigantes en el
  mismo trabajo.

## Ojo al arrancar la próxima sesión

1. **El working tree viene sucio de la sesión anterior**, en `fix/engram-grants-proporcionales`:
   24 archivos modificados (agentes Claude/Codex, `agent-mcp-tools.ts`, `plugins.ts`, goldens,
   plugin engram) + 3 sin trackear (`docs/research/context-resident-token-reduction-plan.md`,
   `docs/research/model-tier-token-savings-proposal.md`,
   `packages/plugins/engram/skills/engram-subagent-readonly.md`). **Nada de eso es de esta sesión**
   y no se commiteó. Decidir si se retoma o se descarta antes de abrir branch nueva.
2. **Tres worktrees vivos** bajo `.claude/worktrees/`: `agent-a656ffb48a8c09b14`,
   `agent-ae2a936ecf4f32f42`, `feat-search-v2`. Pueden ser la única copia de lo que guardan.
3. **No se parkeó en `main`**: el tree está sucio y hay trabajo sin commitear. Parking queda para
   Ulises.
4. Ningún issue se puede arrancar sin antes correr su sección "Investigación requerida al momento
   de abordar" — ese es el contrato de cada uno.
