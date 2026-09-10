# Sesión actual

**Estado:** `main` en `44065d0`, limpio. **0 issues abiertos, 0 PRs abiertos.**
npm en **0.8.2**; `main` tiene dos cosas **sin publicar**: la spec 0018 y el #641.

## Lo que quedó cerrado

Ver la entrada del 2026-09-10 en `progress/history.md` — no se repite aquí.

## Lo único en curso: la medición

El brazo "después" de la tasa de activación se acumula **solo**, con el uso normal de
`moonar-medusa-monorepo` y `navori-health`. Los dos corren ya 0.8.2 con los archivos de
contexto prefijados, así que sus próximas sesiones sí reciben la escalera como cuerpo.

Cuando haya sesiones suficientes: correr `scripts/mine-activation.py` sobre ellas y comparar
contra la tabla de `docs/research/activacion-subagentes-y-skills.md`. **No hace falta el A/B
sintético** de `scripts/ab-activation/`.

**Reserva de método, deliberada:** no rodar más specs a esos dos repos mientras se acumula la
data. La 0018 solo cambia monorepos —o sea exactamente esos dos— y metería una segunda
variable justo donde se quiere aislar una. Por eso el **0.8.3 está retenido a propósito**, no
olvidado.

## Cuando la medición cierre

1. **Release 0.8.3** con la spec 0018 y el #641, y rollout. Ojo: el #641 cambia los bytes de
   **todo** script de plugin del parque — conviene leer el diff en un repo antes de los 20.
2. El primer rollout de la 0018 a los monorepos borra ~40 archivos en moonar y ~60 en
   navori-health. Es el momento de leer el reporte de conservados; en la medición de campo
   ambos dieron **0 conservados**.

## Deuda conocida, con su razón

- **`scripts/` fuera del recorte por workspace.** Los que ya están en un workspace se
  escribieron sin marcador y bajo `minimal` no se re-escriben, así que nunca lo ganan.
  Reincorporarlos devolvería el aviso irresoluble que la 0018 quitó a propósito. `doctor` los
  reporta; la limpieza de una vez es del usuario.
- **`.claude/.managed-drift-stamp`** está en `.gitignore` pero sigue trackeado: ensucia cada
  sesión y bloquea `git pull`. Se limpia con `git rm --cached`.
- **El guard de aislamiento `~/.navori`** da falso positivo determinista mientras haya sesiones
  de Claude Code vivas en otros repos. Verificado tres veces hoy por mtime.
- **`.atl/` en 4 repos**: NO se toca. Se investigó y no interfiere — es un dot-directory, fuera
  de toda búsqueda de contenido. `doctor` lo reporta como higiene.

## Notas de método que costaron

**Un hook no se verifica por lo que emite, sino por lo que sobrevive al corte del host** — y
tiene 4 `SessionStart`; mirar solo el primero da un falso negativo.

**Cuando el arnés frena un cambio, el guardián suele tener mejor razón que el cambio.** 15
suites fallaron al recortar el bloque de orquestación; ninguna se reescribió para que el cambio
pasara.

**Revisar las inspiraciones antes de decidir una convención.** En #626 dieron la respuesta en
10 minutos y superpowers aportó un caso que no se habría considerado.

**No usar `git add -u` en un repo con otra sesión viva.** Barrió archivos de un refactor en
vuelo; el método correcto es re-renderizar en un **worktree aislado desde `main`**.

**"Conservador" no es "estable".** Conservar-y-reportar parecía deuda crónica y no lo era:
bajo `minimal` navori no reescribe esos archivos, así que se borran una vez y el aviso calla.
