# Coherencia de contratos del harness — Requirements

**Status:** borrador · **Fecha:** 2026-09-24 · **Base revisada:** `6edc58b4` · **Issue:** #1016

- **Origen:** `docs/research/auditoria-profunda-agentes-skills-2026-09-23.md`, backlog de la
  sección 11.4, órdenes 1 a 5 (hallazgos F01–F06 más el inventario de capacidades).
- **Alcance elegido por el usuario (2026-09-24):** F01–F06 + inventario. Quedan fuera F07 (piloto
  A/B), la reducción de privilegios de F08 y cualquier experimento de productividad.

## Context

La auditoría encontró que el problema de navori no es la falta de roles, sino que sus contratos
se contradicen o solo se cumplen en un host. Verificado en frío contra `6edc58b4`:

- **F01:** `skills/verify-before-done.md` se contradice. La fila "Zero new errors vs baseline" de
  su tabla dice que una falla fuera de `git diff --name-only` "predates you". La sección
  "Baseline attribution" dice que, sin baseline comparable, esa falla tiene "origin not
  determined". La ubicación de una falla no prueba su causa: un cambio puede romper un
  consumidor que no se editó.
- **F02:** la Iron Law de `verify-before-done` exige correr el gate "THIS TURN", y nombra también
  al `publisher`. El bloque `cierre-sesion` permite citar el Pass-2 del ciclo si no cambió código.
  Una de las dos reglas se incumple siempre.
- **F03:** `project.localSkills` declara `author-agent`, `playwright-cli`, `rebase-rerender` y
  `worktree-hygiene`. Existen en `.claude/skills/`, pero no en `.agents/skills/`. El engine Codex
  solo coloca skills del plan (`engines/codex/index.ts`, `placeSkill`), y su `orphanScans` trata
  como huérfano todo lo que haya en `.agents/skills` fuera del plan (`match: () => true`). Por eso
  copiarlas a mano no es una salida. Navori indexa las skills locales, pero nunca toca su
  contenido (bloque "Skills disponibles").
- **F04:** Claude registra el hook `implementer-no-markdown` (`engines/claude/build-settings.ts`);
  Codex no registra un equivalente (`engines/codex/build-config-toml.ts`). El hook
  `subagent-stop-handoff.sh` es advisory a propósito: no reporta un handoff ausente, y su propio
  encabezado reconoce falsos positivos cuando hay trabajo en paralelo.
- **F05:** `agents/scribe.md` le pide aplicar `markdownRequests` "in the producer's own worktree
  and branch, touching ONLY the listed paths". No hay una comprobación ejecutable de esa
  identidad antes de editar o commitear, y `impl_<feature>.json` no guarda worktree ni rama.
- **F06:** `origin/main` está escrito fijo en `agents/architect.md` (sección "Instructions"), en
  `skills/solution-design.md` y en `skills/scoped-gate.md`. Este último cae en silencio a `main`
  local. El proyecto declara su base en `branchBase`.
- **Inventario:** `engines/shared/engine-capabilities.ts` (`ENGINE_CAPABILITIES`, #821) ya lista
  por engine las superficies que no se renderizan, cada una con su razón. `lib/plan/gate-support.ts`
  y `navori doctor` ya reportan que `planTiers` se degrada fuera de Claude. Lo que falta es declarar
  cada **control** (no cada superficie) como enforced, advisory o unsupported, y probar que esa
  declaración coincide con lo que de verdad se renderiza.

Restricción heredada de la auditoría: no convertir en bloqueante un hook de matching heurístico
sin resolver antes sus falsos positivos. La validación de handoffs se hace donde se consume el
handoff (R12–R15), no endureciendo `subagent-stop-handoff.sh`.

## Requirements (EARS)

### Atribución de fallas del gate (F01)

- **R1** — `verify-before-done` DEBERÁ clasificar el origen de toda falla del gate en exactamente
  uno de tres estados: *introducido demostrado*, *preexistente demostrado* u *origen no
  determinado*.
- **R2** — SI la única evidencia sobre una falla es su ubicación respecto de
  `git diff --name-only <base>` (dentro o fuera del diff), ENTONCES la falla DEBERÁ clasificarse
  *origen no determinado*.
- **R3** — Una falla DEBERÁ clasificarse *preexistente demostrado* o *introducido demostrado* solo
  cuando el mismo comando se ejecutó sobre la base comparable y sobre el cambio, sin `git stash`
  sobre el árbol compartido, y el resultado distingue ambos casos.
- **R4** — Ningún asset renderizado (skills, agentes, bloques managed) DEBERÁ contener una regla
  que asigne origen a una falla solo por su ubicación en el diff. Además de `verify-before-done`,
  esto alcanza a `implementer`, `reviewer` y `review-diff`.

### Validez de la evidencia (F02)

- **R5** — navori DEBERÁ definir en un solo lugar cuándo una evidencia de gate sigue vigente:
  cuando coinciden el árbol verificado (commit o hash del diff), el comando exacto y los inputs
  que declara relevantes (lockfile y configuración del gate). El árbol se identifica por el
  contenido de los archivos del diff: un rebase que no los cambia no vence la evidencia.
- **R6** — CUANDO el `publisher` o el cierre de sesión tengan un receipt vigente según R5, DEBERÁN
  verificar ese receipt en vez de volver a ejecutar el gate.
- **R7** — SI cambió el árbol, el comando o un input relevante desde que se generó la evidencia,
  ENTONCES la evidencia DEBERÁ tratarse como vencida y el gate DEBERÁ volver a ejecutarse.
- **R8** — `verify-before-done`, el bloque `cierre-sesion` y los agentes que citan la frescura de
  la evidencia (`implementer`, `reviewer`, `publisher`) DEBERÁN enunciar la regla de R5–R7 sin
  contradecirse. "Este turno" deja de ser el criterio universal.

### Skills locales en cada host (F03)

- **R9** — DONDE esté configurado un engine con descubrimiento nativo de skills distinto de
  Claude (hoy `codex`), cada id de `project.localSkills` que exista en `.claude/skills/<id>/`
  DEBERÁ quedar descubrible por ese host después de `navori render`, sin mantener una copia a mano.
- **R10** — navori NO DEBERÁ modificar `.claude/skills/<id>/`, que sigue siendo la única fuente.
  CUANDO esa fuente cambie, el preview de `navori render` y `bun run check:render` DEBERÁN
  detectar que el destino del otro host quedó desactualizado.
- **R11** — SI un id declarado en `project.localSkills` no existe en `.claude/skills/`, ENTONCES
  `render` y `doctor` DEBERÁN nombrarlo como faltante, y `render` NO DEBERÁ crear un destino con
  contenido inventado. `.claude/skills/<id>/` es la única fuente también en repos sin el
  engine `claude`; ahí `doctor` DEBERÁ sugerir mover la skill a esa ruta.
- **R12** — La poda de huérfanos de un engine NO DEBERÁ borrar ni reportar como huérfano el
  destino que corresponde a una skill local declarada. SI el id deja de estar declarado, ENTONCES
  su destino DEBERÁ podarse con las mismas reglas de backup que el resto de los huérfanos.

### Consumo de handoffs e identidad del productor (F04, F05)

- **R13** — El productor de `impl_<feature>.json` DEBERÁ registrar la identidad del trabajo que
  entrega: feature, ruta del worktree, rama y commit HEAD al terminar. Hoy ya registra los tres
  primeros (el hook `subagent-stop-handoff` los exige); falta `head`.
- **R14** — ANTES de despachar al siguiente rol de la cadena (scribe o reviewer) sobre un
  feature, el orquestador DEBERÁ comprobar que `impl_<feature>.json` existe, se parsea y
  corresponde al feature despachado. SI falla alguna de las tres, ENTONCES NO DEBERÁ despachar y
  DEBERÁ reportar cuál falló.
- **R15** — Un handoff de otro feature, aunque sea válido y esté presente, NO DEBERÁ satisfacer
  el contrato de R14.
- **R16** — ANTES de editar o commitear, el `scribe` DEBERÁ comprobar con un comando ejecutable
  que su checkout y su rama coinciden con los registrados por R13, y que cada `path` de
  `markdownRequests` es relativo al repo, no sale del repo (sin `..` ni rutas absolutas) y no es
  un archivo de estado de sesión. SI alguna comprobación falla, ENTONCES DEBERÁ reportar
  `BLOCKED` sin escribir nada.
- **R17** — La validación de R14–R16 DEBERÁ funcionar igual en todo engine que renderice el
  flujo implementer→scribe→reviewer. No debe depender de un hook exclusivo de Claude. La paridad
  que se prueba es la del render (la instrucción de invocar la validación está en cada engine);
  la invocación misma sigue siendo advisory en todos, igual que hoy.
- **R24** — DONDE `harness.scribeOwnsMarkdown` sea `false`, R14 DEBERÁ aplicarse sobre
  `impl_<feature>.md`, ligado al feature por el nombre del archivo, y R16 no aplica.

### Base del proyecto (F06)

- **R18** — Los assets que contrastan una afirmación o acotan un comando contra la rama base
  (`architect`, `solution-design`, `scoped-gate` y la skill de preset `turbo-workspaces`) DEBERÁN
  usar la base declarada en `branchBase`, no `origin/main` literal.
- **R19** — SI la referencia remota de la base no existe o no se pudo refrescar, ENTONCES el agente
  DEBERÁ declarar qué referencia usó o marcar la afirmación como *no verificada*, nombrando la
  causa. NO DEBERÁ presentarla como verificada contra la base.

### Inventario de controles por engine (backlog 5)

- **R20** — navori DEBERÁ declarar, en un único registro de código, el estado de cada control del
  harness en cada engine: `enforced`, `advisory` o `unsupported`, con su razón. Como mínimo cubre
  el gate de planificación, el ownership del Markdown, la forma del handoff, la validación del
  consumidor de R14, las tools de escritura de los roles analíticos y el descubrimiento de skills
  locales.
- **R21** — `navori doctor` DEBERÁ listar, para los engines configurados, cada control que no esté
  `enforced`, con su estado y su razón. El reporte existente de `planTiers` DEBERÁ salir de ese
  registro, no de una lista aparte.
- **R22** — Un test DEBERÁ fallar cuando el estado declarado de un control no coincida con el
  render efectivo del engine. Por ejemplo: `enforced` sin el hook registrado, o un hook registrado
  para un control declarado `unsupported`.
- **R23** — Para cada rol analítico (`auditor`, `scout`, `reviewer`, `architect`) y cada engine, el
  inventario DEBERÁ registrar las tools de escritura efectivas en el render, y el test de R22
  DEBERÁ compararlas. Esta spec solo las declara; no cambia privilegios.

## Fuera de alcance

- F07: piloto A/B y ablaciones de la cadena implementer→reviewer (sección 11.2 de la auditoría).
- F08: reducir privilegios de escritura de los roles analíticos. R23 solo los hace visibles.
- Volver bloqueante `subagent-stop-handoff.sh`.
- Adaptador nativo de DeepSeek, detección de bibliotecas en monorepos y los punteros de
  `check:doc-budgets` (oportunidades condicionadas de la auditoría).
