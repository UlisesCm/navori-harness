# Sesión actual

**Estado:** `main` en `40b57f8`, limpio. **npm en 0.8.1**; hay **dos fixes en `main` sin
publicar** (#633 y #634). 0 PRs propios abiertos. **0 issues abiertos** — #625 y #626
cerrados hoy.

## Jornada: el CI ambiental, la escalera que llega, y dos bugs de skills

### El CI estaba rojo por un repo de terceros (#629)

Tres rojos —`main` y dos PRs— con **una sola causa ajena al código**: `apt-get update` sale
con exit 100 si CUALQUIER fuente falla, y el runner trae el repo apt de Chrome con un
`Hash Sum mismatch`. No era transitorio: el rerun falló idéntico. La garantía se movió a
`zsh --version`; un `|| true` a secas habría matado la mitad zsh de las suites en silencio.

### Spec 0019 — la escalera de ruteo llega (#630, #631)

**La spec se reescribió a v2 durante su propia implementación.** Dos hallazgos la falsificaron:

1. **No era tamaño, era el alfabeto.** `.claude/context/` lleva cuatro archivos y el hook los
   recorre con un glob que expande alfabéticamente. `orquestacion.md` quedaba último **por
   empezar con "o"**. Prueba: recortado a 4,757 chars *seguía* cayendo a puntero. La
   intención de prioridad ya existía en `CORE_MANAGED_ASSETS`; se perdía en el nombre del
   archivo. Ahora el orden viaja EN el nombre (`10-`, `20-`, `30-`, `40-`).
2. **La tabla señal→mecanismo no podía moverse** (#379 B): la decisión se toma mientras se
   lee la tarea. Se revirtió el cambio, no el test.

De 15 suites que fallaron, **ninguna se reescribió para que el cambio pasara**.

### Release 0.8.1 + rollout 20/20

Patch y no minor por decisión de Ulises, con mejor razón que la propuesta: el 0.8.0 shippeó
ese feature a la mitad, así que esto lo termina. Rollout a 20 repos, 0 conflictos, 6
entradas fantasma podadas. PRs de harness en los dos repos vivos: moonar #123 y
navori-health #30, **ambos mergeados**.

### #625 — doctor avisa de índices de skills ajenos muertos (#633)

Cuatro repos traen commiteado un `.atl/skill-registry.md` de gentle-ai: 22, 27, 21 y 48
skills indexadas, **cero** rutas existentes. Detectar y reportar, nunca tocar. La propiedad
que lo hace usable: solo reporta si ninguna ruta resuelve — con una viva, calla.

### #626 — el formato de skills, y navori era el outlier (#634)

El issue decía que la doctrina *afirma* algo falso. Peor: `resolveLocalSkillPath` resolvía el
plano **primero** y le ganaba al directorio, así que navori publicaba en `CLAUDE.md` skills
que Claude Code nunca carga. Verificado en tres fuentes: la tabla oficial (5 ubicaciones,
todas `<skill-name>/SKILL.md`), gentle-ai (`registry.go:286`, "the Agent Skills layout") y
superpowers (cero `.md` sueltos). El plano existe, pero para `.claude/commands/`.

## Lo que sigue

1. **Release 0.8.2 + rollout.** #633 y #634 están en `main` y no en npm. El #634 cambia
   doctrina renderizada, así que hasta que no se publique los 20 repos siguen diciendo que
   un `.md` plano es una skill válida.
2. **El A/B de activación.** El banco commiteado mide **H4** (modo de permisos), no lo que
   shippeamos. El brazo que mediría ESTO es harness 0.8.0 (npm) contra 0.8.1+ (local), misma
   fixture y prompt — barato de construir porque `AB_NAVORI` ya es parámetro. Es la pregunta
   que abrió #622 (activación al 2%) y por fin es medible.
3. **Implementar la spec 0018** (6 tareas, 3 lotes). Borrará ~38 archivos en moonar y ~57 en
   navori-health.
4. **T10 de la spec 0017** sigue sin marcar.
5. **Limpiar `.atl/`** en los 4 repos (`git rm -r --cached .atl` + `.gitignore`). Fuera del
   alcance de #625 a propósito.

## Notas de método

**Tres bugs de hoy son la misma familia**: doctrina que afirma algo falso sobre cómo se
comporta el host. #623 (el corte del contexto), #626 (el formato de skills) y el `grep`
autocumplido del cross-review. Un check transversal podría tener sentido.

**Revisar las inspiraciones antes de decidir una convención vale la pena.** En #626 dieron la
respuesta en 10 minutos y confirmaron que el bug era nuestro — y superpowers aportó un caso
que no habría considerado: los `.md` DENTRO de una skill son material de apoyo legítimo, así
que marcarlos habría convertido el check en ruido.

**Cuando el arnés frena un cambio, el guardián suele tener mejor razón que el cambio.**

**No usar `git add -u` en un repo con otra sesión viva.** Costó: barrió archivos de un
refactor en vuelo en navori-health, y al deshacerlo con `reset --soft` quedaron en el índice
—estado compartido— donde la otra sesión los commiteó. Nada se perdió; el PR salió limpio
re-renderizando en un **worktree aislado desde `main`**, que es el método a repetir.

**Papercuts vivos:** `.claude/.managed-drift-stamp` está en `.gitignore` pero sigue trackeado
(ensucia cada sesión, bloquea `git pull`); el guard de aislamiento `~/.navori` da falso
positivo determinista con sesiones concurrentes; y el bloque renderizado mide distinto por
repo — bonum-webapp es el más apretado, ~1,000 bytes de margen contra el corte del host.
