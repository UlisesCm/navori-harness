# Estado actual

**idle** — sesión del 2026-09-21 cerrada. El detalle vive en `progress/history.md`.

## Lo que quedó abierto

- **PR #898** — abierto, CI verde, pendiente de merge. `mem_search` compacto, workaround del bug
  de `mem_save` y permisos de engram (`save` en allow, `delete` en deny, `import` en ask).
- **Issue #895** — evaluar un fast QA check (`lint`+`format`+`tsc`) o un agente
  `quality-assurance`. Medido ya: el fast QA cuesta 0.8s en este repo. Falta medirlo en un legacy
  real y decidir dónde vive (config, agente o skill).

## Deuda declarada, sin bloquear

- `docs/research/model-tier-token-savings-proposal.md` entró en `main` colado en #896 (`git add`
  demasiado amplio). Decidir si se queda o sale.
- `.tgrep/` (16 MB) está sin ignorar: la entrada de `.gitignore` se sacó de #898 por alcance y no
  se ha vuelto a meter. Riesgo real de que se cuele en un commit.
- El gate corre `lint` y `typecheck` DESPUÉS de `test:coverage`, así que un error de tipos cuesta
  171s en vez de 3s. Reordenarlo es una línea en `navori.config.json`; falta decidir si va a #895
  o a un issue propio.
- Invariante #68 (engram no se puede remover ni deshabilitar): sigue atando navori a un proyecto
  de dos mantenedores. Convertirlo en el default de un slot de memoria es trabajo de una tarde y
  no se ha abordado.

## Aviso operativo

Había **dos sesiones de Claude sobre este mismo working tree** (ésta y la del ticket #897). Eso
produjo hoy un archivo colado en `main`, un `bun lint` rojo espurio y un rechazo de revisión por
alcance. Si se trabaja en paralelo, cada sesión debe usar su propio worktree.
