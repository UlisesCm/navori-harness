# Sesión actual

**Estado:** `main` en `6f32a00` (0.8.3 publicado y taggeado). **2 PRs abiertos** —#644 y
#645, los dos de la revisión del parque— y **3 issues** en navori-harness: #646, #647, #648.

## Dónde quedó todo

Ver `progress/history.md`, entradas del 2026-09-10. No se repite aquí.

Resumen de una línea: **el 0.8 cumple su propósito en los 20 repos del parque** —la escalera
de ruteo llega como cuerpo en todos, verificado uno por uno— y **lo que falta es medirlo**.

## Lo primero al retomar

1. **Mergear #644 y #645.** Los dos salieron de revisar el parque repo por repo: un falso
   positivo del check de harness congelado, y un mensaje de `doctor` que ofrecía el formato
   plano de skills como arreglo. Ninguno urge, los dos son correctos.
2. **Con eso mergeado hará falta un 0.8.4** para que esos dos fixes lleguen al parque. Son de
   `doctor` y de prosa, así que no corre prisa — se pueden acumular con lo que venga.

## Lo único que corre solo: la medición (#648)

El brazo "después" de la tasa de activación se acumula con el uso normal de
`moonar-medusa-monorepo` y `navori-health`, que ya corren 0.8.3. Cuando haya sesiones
suficientes: `python3 scripts/mine-activation.py <ids>` y comparar contra la tabla de
`docs/research/activacion-subagentes-y-skills.md`.

**Regla que ese documento ya se puso:** el resultado se escribe aunque salga nulo o inverso.
Y si el número no se mueve, la respuesta **no** es escribir más prosa — dos veces en este
proyecto la conclusión fácil fue "falta doctrina" y las dos veces el dato dijo otra cosa.

## Issues abiertos

- **#646** — `.managed-drift-stamp` gitignoreado pero trackeado. Ensucia cada sesión y bloquea
  `git pull`. Toca el guard anti-rollback, por eso no se hizo al vuelo.
- **#647** — un check transversal para doctrina que afirma algo falso sobre el host. **Cinco
  defectos de esta jornada tienen esa firma** y ninguno se detectó por un mecanismo. Conviene
  diseñarlo antes de codearlo: puede que la respuesta sea extender `hook-claims-vs-scripts`.
- **#648** — cerrar la medición de activación.

Y en repos del usuario: `navori-dashboard-template#100` y `alertaciudadana_app#251`, por las
skills en formato plano que nunca han cargado.

## Deuda conocida, con su razón

- **`scripts/` fuera del recorte por workspace.** Los que ya están en un workspace se
  escribieron sin marcador y bajo `minimal` no se re-escriben, así que nunca lo ganan.
  `doctor` los reporta; la limpieza de una vez es del usuario.
- **El guard de aislamiento `~/.navori`** da falso positivo determinista con sesiones
  concurrentes en otros repos.
- **`.atl/` en 4 repos**: NO se toca. Investigado — 185 transcripts, cero lecturas como guía;
  es dot-directory, fuera de toda búsqueda de contenido.
- **Los working trees de moonar y navori-health** cargan el harness 0.8.3 sin commitear,
  duplicando lo que ya va en sus PRs (#130 y #39). Se limpian con
  `git checkout -- .claude CLAUDE.md .mcp.json` **después** de mergearlos.
- **Worktrees sin reclamar** en esos dos repos: había sesiones vivas dentro, así que no se
  tocaron.

## Notas de método que costaron

**Un hook no se verifica por lo que emite, sino por lo que sobrevive al corte del host** — y
hay 4 `SessionStart`; mirar solo el primero da un falso negativo.

**Revisar el parque repo por repo encuentra lo que las suites no.** Los dos fixes de hoy
salieron de ahí, no de un test.

**Cuando el arnés frena un cambio, el guardián suele tener mejor razón que el cambio.**

**No usar `git add -u` en un repo con otra sesión viva.** El método correcto es re-renderizar
en un **worktree aislado desde `main`** y abrir PR desde ahí.

**"Conservador" no es "estable".** Conservar-y-reportar parecía deuda crónica y no lo era.

**Un puntero no puede vivir dentro del archivo que enseña a grepear.**
