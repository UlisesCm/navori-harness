# Sesión actual

**Estado:** **navori 0.7.0 publicado en npm** y los cuatro repos de `navori/` actualizados.
Cero issues abiertos. Queda una cosa pendiente y es de commit, no de trabajo.

## PENDIENTE INMEDIATO (necesita shell)

El commit de cierre de esta jornada — `progress/current.md` + `progress/history.md`. Se quedó sin
hacer porque **el clasificador de auto mode se cayó** (sobrecarga transitoria) y en ese modo cada
comando de shell necesita ese viaje. Dos salidas: esperar, o salir de auto mode con Shift+Tab
(`acceptEdits`/`default`), donde las reglas `allow` resuelven sin clasificador.

## SIGUIENTE PASO REAL: medir

La medición que valida —o refuta— dos días de trabajo: **una sesión con fan-out, con
`navori audit --start <id>` desde el primer minuto**, en un repo ya en 0.7.0. Contesta de una:

1. ¿arranca la escalera de búsqueda? (`codegraph_explore > 0`, hoy 0 en todas las sesiones)
2. ¿se agrupan los comandos? (llamadas Bash por turno)
3. ¿cuánto bajó el arranque por subagente? (27,787 → ~23,600 esperado)

Con el corte por modo (#584) el resultado se lee sin la ambigüedad de hoy: sabremos qué pasó en
`auto` y qué en el resto, en vez de un solo montón.

## Lo que se cerró en esta jornada

**13 issues**, todos con PR mergeado: #563, #561, #559, #560, #557, #556, #555, #574, #575, #579,
#573, #572, #584. Más las specs 0014 (harness ajeno) y 0015 (la orquestación fuera del always-on).

Los que cambian comportamiento observable:

- **La doctrina de orquestación salió del `CLAUDE.md`.** Cuatro bloques (`orquestacion`,
  `arranque-sesion`, `cierre-sesion`, `agentes-disponibles`) se renderizan a `.claude/context/` y
  los entrega el hook de `SessionStart`, que llega al agente principal y no a los subagentes —
  ninguno declara la tool `Agent`, así que no podían actuar sobre ellos. Lo que navori renderiza
  en el `CLAUDE.md` bajó de 381 a **187 líneas**, bajo el objetivo documentado de 200.
- **Siete de los ocho agentes alcanzan MCP** (antes tres), por el mecanismo que ya existía:
  `withAgentMcpTools` concede la familia del plugin que le inyecta prosa al agente.
- **El harness reconoce los seis modos de permiso**, y `doctor` avisa del único que no soporta.
- **El histograma de tools se corta por modo** — atribución posicional, porque los eventos
  `permission-mode` no traen timestamp.

## Estado del rollout

| repo | harness | nota |
|---|---|---|
| `navori-harness` | 0.7.0 | publicado en npm |
| `alertaciudadana_app` | 0.7.0 | sin commitear |
| `alertaciudadana_backend` | 0.7.0 | sin commitear |
| `alertaciudadana_backend_dev` | 0.7.0 | **sin git** — solo el backup de navori |
| `navori-dashboard-template` | 0.7.0 | sin commitear, incluye 41 archivos de un render previo |

Por decisión del usuario **no se commiteó el harness en ninguno**. Los backups viven en
`~/.navori/backups/`. Los otros tres directorios de `navori/` no tienen `navori.config.json`.

## Deuda / gotchas vigentes

- **Decisión de producto abierta**: `Skills disponibles` (570 tok) puede ser copia del listado que
  Claude Code ya inyecta. Dato que la refuerza: 36 skills declaradas y 0 usadas en
  `alertaciudadana_app`, 15 de 17 sin usar aquí.
- **La dieta rinde menos de lo que sugiere el titular**: los 4 bloques son 15% del arranque de un
  subagente pero solo 6.5% del orquestador, y 3 de 4 sesiones auditadas no lanzaron ninguno.
- **El guard `~/.navori` (#404/#424) dio falso positivo toda la jornada** por otra sesión de Claude
  Code viva en `alertaciudadana_app`. En CI siempre pasa.
- **Cuidado con la rama base**: dos veces cometí encima de una rama de PR en vez de `main`. Antes de
  commitear: `git branch --show-current`.
- **Un PR apilado contra una rama que no es la default NO enlaza su issue**, aunque el keyword esté
  en inglés. `closingIssuesReferences` sale vacío hasta reapuntarlo a `main`. Límite del fix de #563.
- **Los inventarios escritos a mano no crecen solos.** Rompieron cuatro veces: el conteo de assets
  de `render-engine`, la lista de archivos del e2e de engram, `EXPECTED_PROMPTS`, y el conteo de
  `preset-extras`. Cuando un test liste archivos a mano, evalúa derivarlo.
- **`.claude/worktrees/ks8-preset/`** es un worktree ajeno (de #581) con 35 archivos aún en 0.6.5.
  El render lo salta a propósito. Si su PR ya mergeó, se puede reclamar con `git worktree remove`.
