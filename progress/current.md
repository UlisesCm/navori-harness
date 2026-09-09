# Sesión actual

**Estado:** `main` en `910f3e1`, limpio y sincronizado. **npm sigue en 0.8.0** — el fix de
entrega vive en `main` y **no está publicado**. 0 PRs propios abiertos. 2 issues abiertos:
#625 y #626, los dos sobre skills, ninguno de esta jornada.

## Jornada: el CI ambiental, y la escalera que por fin llega

### El CI estaba rojo por un repo de terceros (#629)

`main` y los dos PRs abiertos, tres rojos con **una sola causa ajena al código**:
`apt-get update` sale con exit 100 si CUALQUIER fuente configurada falla, y la imagen del
runner trae el repo apt de Google Chrome, cuyo índice sirvió un `Hash Sum mismatch`. No era
transitorio: el rerun falló idéntico, y en la corrida ya verde el mismatch seguía ahí.

El fix deja que el `update` reporte una fuente rota y mueve la garantía a `zsh --version`.
Un `|| true` a secas habría dejado de instalar zsh en silencio, y la mitad zsh de las suites
de hooks (#391) habría desaparecido sin avisar — el mismo "check que se salta a sí mismo" de
#421/#504.

### Spec 0019 — la escalera de ruteo llega (#630 spec, #631 implementación)

**La spec se reescribió a v2 durante su propia implementación.** La v1 modeló "un bloque
gordo contra el git log" y eso resultó falso. Dos hallazgos lo tumbaron:

1. **El canal estaba sobre-suscrito y el perdedor lo decidía el alfabeto.**
   `.claude/context/` lleva CUATRO archivos; el hook los recorre con un glob, que expande
   alfabéticamente. `orquestacion.md` quedaba último **por empezar con "o"**, y los otros
   tres gastaban 5,562 del presupuesto de 8,000 antes de que le tocara. Prueba de que
   recortar no bastaba: con el bloque ya en 4,757 **seguía cayendo a puntero**. Y la
   intención de prioridad ya existía — `CORE_MANAGED_ASSETS` declara `orquestacion` primero
   (`render-plan.ts:105`); se perdía en el nombre del archivo. Ahora el orden viaja EN el
   nombre (`10-`, `20-`, `30-`, `40-`, paso de 10).

2. **La tabla señal→mecanismo no puede salir del bloque.** `analysis-cascade-wiring.test.ts`
   (#379 B) lo impide con mejor razón: la decisión se toma **mientras se lee la tarea**, no
   después de decidir delegar. Se revirtió el cambio, no el test.

Medición real, corriendo el hook: **8,424 bytes** contra los 10,441 del corte mínimo
observado. Escalera y catálogo como **cuerpo**; arranque, cierre, git log y resume con
puntero accionable. El git log pasó a `add_bounded` — con la olla por fin llena puede ser él
quien la desborde, y es lo más reconstruible del canal.

El bloque bajó de 12,728 a **6,495** chars. Cuatro cláusulas existían SOLO ahí (worktree,
ancestría tras squash-merge, load-bearing claims, cap de 2 ciclos) y se injertaron en
`leader.md` **antes** de retirarlas.

**Un bug que el arnés atajó**: la doctrina enseñaba a detectar el cross-review con
`grep -n codex-cross-review .claude/agents/leader.md`. Al mudar ese párrafo DENTRO de
leader.md el grep habría acertado siempre — falso positivo en todo repo que solo renderiza
Claude. Lo cazó `render-engine.test.ts`, que usa ese token como prueba de ausencia.

## Lo que sigue

1. **Publicar y hacer rollout.** El fix está en `main` y **no en npm**: ningún repo del
   parque lo tiene todavía. Ojo, el cambio **renombra archivos renderizados**
   (`context/<id>.md` → `context/NN-<id>.md`), así que el rollout migra, no solo actualiza —
   el render retira el nombre viejo en el mismo apply, pero conviene verificarlo en uno
   antes de los 18.
2. **El A/B de activación** ya no mide un harness roto contra sí mismo. **Pero el banco
   commiteado mide H4** (`--permission-mode auto` vs `acceptEdits`), no el cambio que
   acabamos de shippear. El A/B que mediría ESTO es harness-viejo (npm 0.8.0) contra
   harness-nuevo (local), misma fixture y mismo prompt — barato de construir sobre el mismo
   banco, porque `AB_NAVORI` ya es un parámetro.
3. **Implementar la spec 0018** (6 tareas en 3 lotes). Su rollout BORRARÁ ~38 archivos en
   moonar y ~57 en navori-health.
4. **#625 y #626**, ambos sobre skills.
5. **T10 de la spec 0017** sigue sin marcar.
6. **El drift de bonum-webapp**: un mes sin commitear, con el 0.8.0 encima.

## Notas de método

**Cuando el arnés frena un cambio, el guardián suele tener mejor razón que el cambio.** 15
suites fallaron al recortar el bloque; ninguna se reescribió para que el cambio pasara. Cada
una se re-ancló (el hecho sobrevive, cambia de dirección) o se revirtió el cambio que la
rompía. Las dos peores habrían sido pérdidas silenciosas de doctrina.

**Un puntero no puede vivir dentro del archivo que enseña a grepear.**

**El guard de aislamiento de `~/.navori` sigue dando falso positivo determinista** mientras
haya sesiones de Claude Code vivas en otros repos. Verificado dos veces hoy por mtime.

**`.claude/.managed-drift-stamp` está en `.gitignore:20` pero sigue trackeado**, así que se
ensucia en cada sesión y bloquea `git pull`. Se limpia con `git rm --cached`. Papercut
conocido, no atendido.
