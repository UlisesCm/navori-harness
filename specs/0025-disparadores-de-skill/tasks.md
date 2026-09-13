# Disparadores de skill — Tasks

Esta spec entrega un **instrumento y una moratoria de secuencia**, no un
mecanismo: #758 no se construye todavía, y la condición que levanta la moratoria
está en `design.md` § *Condición de reevaluación*. Ninguna tarea toca
`packages/core/core-assets/`, `.claude/`, el schema de config ni el render: eso
es R6, y la tarea T5 es el cable que lo mantiene cierto.

## Batch 1 — el minero

- [ ] **T1** (R1, R3) — `scripts/mine-skill-triggers.py`: recorre los transcripts
  bajo una raíz (`--root`, por defecto `~/.claude/projects`), agrega por sesión
  uniendo el transcript del orquestador con los de `subagents/agent-*.jsonl`, y
  evalúa las candidatas declaradas en el propio script por las dos vías —patrón
  sobre el texto de los prompts del hilo principal, y patrón sobre las rutas que
  la sesión tocó—. La vía de archivo extrae rutas del `file_path` nativo **y** del
  `command` de `Bash`. Publica por candidata y por ancho de patrón: sesiones que
  disparan, de ésas cuántas invocaron el slug, y el denominador de sesiones
  activas. Bandera `--json` para una salida estable de máquina.

  · test: `packages/cli/src/__tests__/skill-triggers-miner.test.ts`::`"el embudo publica disparo, conversión y denominador"` con `// Covers: R1`
  · test: mismo archivo::`"cuenta un toque a commands/*.ts que llegó por Bash"` con `// Covers: R3`
  · test: mismo archivo::`"cuenta la invocación que vive solo en el transcript de un subagente"` con `// Covers: R1, R3`

- [ ] **T2** (R2, R4, R5) — Las tres declaraciones que acompañan a todo número
  que el minero imprime: (a) la salvedad de **cota inferior** con su causa
  (`anthropics/claude-code#24858`) en la misma sección que cualquier porcentaje
  cuyo numerador sean invocaciones; (b) las sesiones sin prompt ni archivo quedan
  fuera del denominador y su conteo se imprime; (c) la línea base pre-registrada
  —H₀ = 0 con el denominador de cada candidata y la ventana del corpus— se
  imprime junto a la medición fresca. Imprime además el total bruto de usos de la
  herramienta `Skill`, para que un cero estructural se distinga de un cero de
  conversión (§ *Failure modes*).

  · test: `skill-triggers-miner.test.ts`::`"no publica un porcentaje de invocación sin la salvedad de cota inferior"` con `// Covers: R2`
  · test: mismo archivo::`"excluye las sesiones vacías del denominador y declara cuántas"` con `// Covers: R4`
  · test: mismo archivo::`"imprime la línea base pre-registrada junto a la medición fresca"` con `// Covers: R5`

## Batch 2 — el test del minero y su corpus sintético

- [ ] **T3** (R1, R2, R3, R4, R5) — `packages/cli/src/__tests__/skill-triggers-miner.test.ts`:
  construye un corpus JSONL sintético en un directorio temporal —una sesión que
  dispara y convierte, una que dispara y no, una cuyo único toque llega por
  `Bash`, una cuya invocación vive solo en `subagents/`, una vacía, y un
  transcript con una línea corrupta—, corre el minero con `--root <tmp> --json` y
  afirma sobre la salida. Dos corridas consecutivas producen bytes idénticos
  (determinismo de R1). El corpus vive en `fixtures/`, junto a los que ya usa
  `packages/cli/src/__tests__/`.

  El test hace `skip` —no `fail`— cuando no hay `python3` en el PATH: la suite no
  puede volverse roja por una dependencia que el repo no declara en su
  `package.json`. CI corre en `ubuntu-latest`, que trae `python3`, así que el
  camino real siempre se ejecuta allí.

  · test: es el archivo mismo; los seis casos que T1 y T2 enumeran llevan ahí sus
  comentarios `// Covers: R1`, `R2`, `R3`, `R4` y `R5`.
  · test: `skill-triggers-miner.test.ts`::`"dos corridas sobre el mismo corpus dan la misma salida"` con `// Covers: R1`
  · test: mismo archivo::`"una línea JSONL corrupta no aborta la corrida"` con `// Covers: R1`

## Batch 3 — el pre-registro y el cable que impide construir lo que está en moratoria

- [ ] **T4** (R7, R8) — `docs/research/disparadores-de-skill.md`: el veredicto de
  **moratoria de secuencia** con sus tres motivos acotantes y el Hecho 5 (cero
  mediciones válidas de la palanca) que lo carga; los **dos bloques
  `> Argumento retirado`** —la premisa falsa sobre el payload y el frente de
  Pareto de un solo eje—, escritos para que no vuelvan; y las tablas de
  `design.md` (censo de invocaciones, los siete anchos con su tiempo a 20
  emisiones, timing de la invocación, contraste contra `spec-bootstrap`).

  Más el pre-registro, con **las cuatro declaraciones que R7 manda**: H₀ = 0 con el
  denominador de cada candidata y la ventana del corpus (más la cota superior por
  regla de tres y su debilidad declarada en `citty`), la **declaración de carril
  dominante** (los tres carriles y si el minero los recibe), la **condición de
  reevaluación** con sus dos cláusulas ancladas a #775 y al embudo de 0024, y el
  **criterio de muerte** (cláusula 1 cumplida + medición nula → #758 se cierra
  como el quinto intento refutado). Más el **veredicto por candidata** que R8
  exige. Incluye el comando exacto que reproduce cada tabla.

  · test: `packages/cli/src/__tests__/skill-triggers-miner.test.ts`::`"el pre-registro declara las cuatro secciones que R7 manda"` con `// Covers: R7` — test de presencia por encabezado, no de prosa: H₀, carril dominante, condición de reevaluación **y criterio de muerte**. Las cuatro, porque R7 manda cuatro: el criterio de muerte es la mitad de la puerta (cláusula 1 cumplida + medición nula) y una mitad sin cable es prosa que se descompone en silencio.
  · test: mismo archivo::`"la condición de reevaluación nombra trabajo verificable (#775 o el embudo de 0024)"` con `// Covers: R7` — el cable contra una puerta insatisfacible: la sección debe citar al menos uno de los dos anclajes.
  · test: mismo archivo::`"el pre-registro publica un veredicto por cada candidata"` con `// Covers: R8` — ambas candidatas aparecen con su propia línea de veredicto.

- [ ] **T5** (R6) — `packages/cli/src/__tests__/skill-triggers-absent.test.ts`: el
  cable que sostiene "nada del harness cambió". Afirma que (a) los goldens
  `engines/__tests__/__golden__/claude.snap` y `codex.snap` no ganaron ningún hook
  de `UserPromptSubmit` más allá de `audit-mode-trigger.sh`; (b) un `render` sobre
  una config que trae `skillTriggers` escrito a mano produce exactamente el mismo
  `settings.json` y el mismo `CLAUDE.md` que sin él — `ProjectSchema` es
  `.passthrough()`, así que la config **se acepta** y navori la ignora, y sin este
  test alguien podría concluir de una validación verde que la feature existe.

  · test: `skill-triggers-absent.test.ts`::`"UserPromptSubmit solo registra el recorder de audit"` con `// Covers: R6`
  · test: mismo archivo::`"un skillTriggers en la config no cambia una sola línea del render"` con `// Covers: R6`

## Trazabilidad

| R | tareas | tests |
|---|---|---|
| R1 | T1, T3 | embudo · subagente · determinismo · línea corrupta |
| R2 | T2, T3 | salvedad de cota inferior |
| R3 | T1, T3 | toque por `Bash` · subagente |
| R4 | T2, T3 | sesiones vacías fuera del denominador |
| R5 | T2, T3 | línea base pre-registrada impresa |
| R6 | T5 | `UserPromptSubmit` intacto · `skillTriggers` ignorado |
| R7 | T4 | las **cuatro** declaraciones (H₀ · carril dominante · condición de reevaluación · criterio de muerte) · la condición anclada a trabajo verificable |
| R8 | T4 | veredicto por candidata, `citty` y `babysit-prs` por separado |

## Gate

El de `qualityGate.full` en `navori.config.json`, desde la raíz del monorepo y
paso por paso. Dos avisos para quien implemente:

- `pnpm test:coverage`, no `pnpm test`: el primero corre además
  `check-coverage-floor.mjs`, que caza entradas obsoletas en `KNOWN_ZERO`. Los
  dos archivos de test nuevos son `.ts` y cuentan; el minero es Python y no entra
  a la cobertura del CLI.
- `pnpm format:check` (biome) se corre en la **raíz**, no bajo `packages/cli`, y
  es el paso que más se olvida.
