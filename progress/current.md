# Sesión actual

**Estado:** `main` en `8499f7d`, limpio y sincronizado. **npm en 0.7.7** (publicado por Ulises).
0 issues abiertos de esta jornada salvo #604; 0 PRs abiertos en navori-harness.

## Jornada: auditoría del audit, release 0.7.7 y rollout completo

El encargo fue "revisa mis audits, ya hay más referencias". Con `--days 3` no aparecía nada nuevo;
a **7 días** la muestra pasó de 5 a **13 sesiones en 5 repos** — y ahí estaban los brazos
`acceptEdits` y `default` que la Fase 0 de la spec 0016 daba por inexistentes.

### Lo que la data dijo

- **La versión del harness NO predice la mezcla de herramientas.** La 0.7.5, con la doctrina nueva
  ya rendereada, dio CERO lecturas nativas; la 0.7.0 dio 117. Correlaciona el tipo de tarea, no la
  doctrina. Eso deja mal especificado el criterio de salida de la Fase 2, que compara porcentajes
  entre tareas distintas.
- La única sesión `acceptEdits`-dominante tiene el share nativo más alto de la muestra (61%),
  contra 0-50% dentro de `auto`. El mode-blind de `tool-mix` sobrevive, pero matizado: el cero
  absoluto solo aparece en `auto`.

### Lo que se arregló (2 PRs, 5 issues)

| PR | Cierra | Qué |
|---|---|---|
| #608 | #603, #605, #607 | `tool-mix` mide la vía de lectura (umbral 20% del valle de una distribución bimodal medida); `unreachable-instructions` cruza sección↔servidor con la misma función que la ficha por agente; el reporte gana modelo del orquestador, `sealed`, `navoriAtStop`, `generatedAt` y `unused-skills` por procedencia. `schemaVersion` 4. |
| #609 | #606 | `subagent-stop-handoff` acota su revisión a 48h. Validaba el historial entero de `.claude/progress/`: el veredicto `clean` era **inalcanzable en los cuatro repos medidos** y cada aviso arrastraba rutas de agosto. Verificado contra los archivos reales: el hook viejo emitía 18 rutas en app, el nuevo calla. |

Ningún umbral se eligió a ojo: la ventana de 48h sale de que los PRs de Ulises mergean en <10h
(p90 8.5h), y la subida del tripwire del bundle a 1000KB de que `main` solo ya buildeaba a 900.

### Release y rollout

- **0.7.7 publicado.** npm saltó 0.7.5 → 0.7.7 (el 0.7.6 quedó taggeado y nunca publicado).
- **20 repos en 0.7.7**: los 5 propios con commit (app `a692257` en qa, backend `51cc02f` en dev,
  dashboard-template PR #99 → `ef7ad5a`, moonar `daa21df`, health `271bbff`) y los **15 de Bonum**
  renderizados sin commit, porque ahí el harness es gitignored.

## Pendientes

1. **#604 — los tres campos que el config declara y el render no honra** (`agentAssignments`,
   `commits`, `version`). Decisión abierta: honrar o quitar. Empezar por `agentAssignments`:
   preguntárselo al usuario en el wizard y descartarlo es la peor de las opciones.
2. **Mitad B de #606** — retención de `.claude/progress/` archivando (no borrando) a
   `archive/YYYY-MM/`. Ventanas calibradas con Ulises: **3 días** para `impl_*`/`review_*`, **14**
   para `audit_*`/`solution_*`/`explore_*`/`research_*`/`plan_*`. Sin urgencia desde #609.
3. **`bonum-webapp`**: es el único repo Bonum con el harness trackeado y sigue sin commitear.
   Está parado en la branch de ticket `fix/BT-1442-…` con trabajo en `src/`, así que necesita
   branch propia desde su base y sin sesión activa encima.
4. **`branchBase: "develop"` en alertaciudadana_app** cuando su casa real es `qa`: con la doctrina
   de parqueo (#601), el cierre lo manda a la rama equivocada.
5. `navori-dashboard-template`: cerrar el **PR #98** (obsoleto, su 0.7.2 ya entró por `c0607e2`) y
   tirar su `stash@{0}`.

## Deuda previa vigente

- **CI de Navori-Technologies en rojo por BILLING**, no por contenido: los jobs no arrancan
  ("recent account payments have failed"). Confirmado otra vez en el PR #99.
- El guard de aislamiento de `~/.navori` da falso positivo cuando hay sesiones vivas en otros
  repos: sus hooks escriben en `~/.navori/audits/*/session-*.log` mientras corre la suite. Se
  distingue porque los archivos son de OTROS repos y el conjunto cambia entre corridas.
- Las sesiones abiertas durante un rollout siguen con el harness viejo en contexto y su registro de
  hooks queda partido — hay que reabrirlas para que tomen la versión nueva.
