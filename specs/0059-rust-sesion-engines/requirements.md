# Migración a Rust, fase 3: hooks de sesión y engines restantes — Requirements

**Estado:** borrador · **Fecha:** 2026-10-27 · **Base:** `migration/rust` en `702be44f`. Cada
entrega abre su propio PR contra `migration/rust`; nada de esta fase llega a `dev` ni a npm.

## Contexto

Esta spec es la fase 3 del programa de migración descrito en `specs/0057-migracion-rust/`
(§ "Fases del programa" de `requirements.md`). Hereda sin cambios las decisiones D1–D17 de 0057 y
D18–D27 de 0058, y los requisitos vigentes de ambas fases.

Alcance, según la tabla del programa: la ruta caliente de sesión (los hooks que pagan el arranque del
CLI TS en cada sesión, turno, despacho o tool call) y los engines que 0058 deja fuera: Codex,
agents-md, cursor, copilot y Pi. Al cerrar la fase, `navori-rust render`, `sync`, `remove --yes` y
`adopt` son nativos para cualquier combinación de engines sin workspaces de monorepo, que es la
forma de este mismo repo (`claude`, `codex`, `pi`).

**Cambio respecto al programa.** La fila de la fase 3 incluía "el refactor de la extensión en
`dev`" (E-Pi, D11 de 0057). Esta spec lo sustituye por un asset derivado del CLI TS construido, que
vive solo en `migration/rust` (D29 de `design.md`). La fase queda sin ningún PR contra `dev`.

**Puerta de entrada.**
- E1 empieza cuando #1432 (`guard-destructive` en `shadow`, T28 de 0057) esté en `migration/rust`:
  los hooks de esta fase reutilizan su extracción de payload, la resolución del worktree de destino
  y el trinquete de `progress/`.
- E2 empieza cuando 0058 E3 (render Claude con escrituras, #1434) esté en `migration/rust`.
- E3 (activación) pasa a la fase 4 (0060) por decisión del usuario (Q19 de `design.md`,
  2026-10-28), con R60 y R61, que 0060 redeclara.

**Numeración.** Los `R<n>` siguen la numeración del programa: los nuevos empiezan en R50. R19 es un
requisito del programa que 0057 no llegó a declarar (su texto no está en git, como pasó con R14 en
0058). Esta spec lo redeclara a partir de la fila de la fase 3 y de D9, D11 y T11 de 0057. R18,
R20–R22 y R24 siguen en el programa: los redeclara la fase 4 (0060).

## Requirements (EARS)

### Hooks de sesión

Los cinco hooks de esta fase son `quality-gate-pre-commit`, `plan-gate`, `session-start-context`,
`subagent-stop-handoff` y `model-advisor`.

- **R50** — WHILE uno de los cinco hooks esté en `shadow` o `active`, su implementación Rust,
  invocada por el comando registrado exacto de cada engine donde el hook está registrado y con cada
  argumento de modo que pasa ese registro, SHALL producir el mismo código de salida, stdout, stderr y
  eventos de auditoría que el shell en cada caso del corpus de veredictos y del fuzz.
- **R51** — WHEN un hook nativo recibe un argumento de modo cuyas dependencias esta fase no porta
  (`model-advisor codex-pretool-profile` y `subagent-stop-handoff codex capture-start`), SHALL
  diferir al shell antes de leer stdin.
- **R52** — WHEN una rama de un hook nativo necesita un subcomando de `navori` que esta fase no porta
  en nativo, el hook SHALL ejecutar el `navori` que resuelve `PATH` con los mismos argumentos, stdin,
  entorno y límite de tiempo que el shell, y SHALL interpretar su resultado igual que el shell.
- **R53** — Un hook nativo SHALL ejecutar en proceso un subcomando portado solo cuando el `navori` que
  resuelve `PATH` reporte la misma versión que el TS con el que se compiló el binario. En otro caso
  SHALL ejecutar ese `navori` como en R52. IF no hay `navori` en `PATH` THEN SHALL producir el mismo
  veredicto y mensaje que el shell para ese caso.
- **R54** — Antes de que uno de los cinco hooks entre en `shadow`, su corpus SHALL tener al menos un
  caso por clase de veredicto y por argumento de modo en cada engine donde está registrado. El corpus
  de `model-advisor`, hoy inexistente, SHALL capturarse de invocaciones reales.
- **R55** — WHEN `quality-gate-pre-commit` nativo recibe una llamada Bash que no es `git commit` (ni
  `git push` en la copia Pi), su invocación directa SHALL tener un p95 ≤ 5 ms en `bench:hooks`. Para
  el resto de las ramas y de los hooks, el p95 Rust SHALL ser menor que el p95 shell con los mismos
  payloads.

### Subcomandos de la ruta caliente

- **R56** — `navori-rust` SHALL ejecutar en nativo `plan gate`, `gate probe` (con y sin `--clean`),
  `tools session-context` (con y sin `--notice-reserve`), `tools notice` (con y sin `--ack`) y
  `dominio inject`, con diferencial cero en stdout, stderr, código de salida y árbol de archivos
  (incluidos `.navori/state/` y `~/.navori/`) en cada fixture aplicable.
- **R57** — WHEN `plan gate` nativo evalúa un payload, SHALL leer, consumir y conservar los
  marcadores `dispatch_<feature>.json` con las mismas reglas de vigencia, `sessionId` y consumo que
  el TS, y SHALL dejar el mismo estado en disco para cada caso del corpus de `plan-gate`.
- **R58** — WHEN un subcomando nativo produce un evento de auditoría, SHALL entregarlo por el bridge
  al escritor CLI único (D12 de 0057), solo en los casos en que el TS lo escribe, y nunca SHALL
  escribir el log directamente.
- **R59** — WHEN `tools session-context` o `tools notice` lanza la consulta de versiones en segundo
  plano, la consulta SHALL ejecutarla el CLI TS con el mismo flag privado y el mismo token que lanza
  el TS, y el proceso nativo no SHALL hacer ninguna petición de red.

### Activación de los hooks de sesión

- R60 (→ 0060) — El PR que active hooks de sesión SHALL adjuntar, por cada hook que activa: replay a cero,
  fuzz local a cero (100 000 entradas si tiene compuerta, 20 000 si es advisory) y un resumen de
  sombra con cero divergencias que cumpla, en cada engine donde el hook está registrado, el umbral de
  invocaciones que fija `design.md` para su clase de evento. Además SHALL tener la aprobación
  explícita del usuario en el PR.
- R61 (→ 0060) — IF un hook de sesión no cumple su umbral al abrir el PR de activación THEN SHALL quedarse
  en `shadow` sin bloquear la activación de los demás, y su activación SHALL pasar a la fase 4.

### Engines restantes

- **R62** — `navori-rust render`, en preview y con `--apply`, SHALL ejecutarse en nativo para toda
  config cuyo `engines` sea un subconjunto no vacío de `claude`, `codex`, `agents-md`, `cursor`,
  `copilot` y `pi`, sin workspaces de monorepo, con diferencial cero en stdout, stderr, código de
  salida y árbol en cada fixture aplicable y en `es` y `en`. Fuera de ese conjunto SHALL re-delegar
  antes de cualquier salida o efecto (R39).
- **R63** — Los comandos que 0058 porta con `when.engines = ["claude"]` (`sync`, `remove --yes` y
  `adopt`) SHALL ampliar su `when.engines` al conjunto de R62 con diferencial cero en cada fixture
  aplicable, incluida la matriz anti-rollback.
- **R64** — WHEN varios engines configurados escriben `AGENTS.md`, el render nativo SHALL producir los
  mismos bytes, el mismo dueño del archivo y la misma advertencia de redundancia de `agents-md` que el
  TS, incluidos los bloques de plugins que añade Pi.
- **R65** — IF el guard de propiedad de cualquier engine rechaza un destino en un render con varios
  engines THEN el render nativo SHALL escribir y borrar exactamente lo mismo que el TS (nada, si el TS
  aborta antes de escribir) y reportar el mismo mensaje y código de salida.
- **R66** — El render nativo de Codex SHALL calcular el hash de trust de cada hook con la misma
  `canonicalJson` y el mismo sha256 que `codexHookHash`, SHALL emitir la misma pista de trust que el
  TS, y SHALL leer `~/.codex/config.toml` sin escribirlo nunca.
- **R67** — El `.pi/extensions/navori.ts` que escribe `navori-rust` SHALL ser byte a byte igual al
  del TS del mismo checkout para todo conjunto de plugins MCP habilitados. CI SHALL fallar si el
  asset embebido de la extensión difiere del que genera ese TS.
- **R68** — Rust SHALL negarse a sobrescribir un recurso de `.pi/` en los mismos casos que el TS
  (hash del marker, esquema del manifiesto más nuevo o fuente TypeScript que no parsea), con el mismo
  mensaje.
- **R19** — WHEN `navori-rust` renderiza un repo con Codex o Pi, el árbol SHALL ser idéntico byte a
  byte al del TS en cada dimensión de config que ejercen las suites de aceptación de ese engine
  (paridad y trust de Codex; `first-class-*` de Pi), de modo que sus garantías valgan sobre el árbol
  Rust. La extensión Pi que emite Rust SHALL cargar en el cargador real de Pi, y los hooks invocados
  por su comando registrado exacto SHALL conservar las garantías first-class de cada engine.
- **R69** — El wiring nativo que emite el render Rust para los scripts de hooks de Codex y Pi SHALL
  coincidir byte a byte con el del TS y con `crates/navori-hooks/tests/golden/wiring.snap`, en
  `shadow` y en `active` (extiende R42 a Codex y Pi).

## Requisitos heredados que esta fase vuelve a ejercer

- **R5, R7 y R9:** cada comando y hook portado entra al manifiesto por ruta y flags, con diferencial
  cero en todos sus fixtures.
- **R10:** un cambio TS que llegue por merge de `dev` y altere un comando portado, o la extensión Pi,
  pone CI en rojo.
- **R11–R13:** contrato de salidas, fail-closed y fallback al shell para los cinco hooks.
- **R14 y R43–R49:** las escrituras de Codex, Pi y los engines de prosa pasan por la misma capa `Fs`,
  backup, poda y oráculo de escrituras.
- **R15 y R16:** misma barra de calidad Rust.
- **R17:** se precisa para los hooks de sesión en R55 (ver § "Observaciones" de `design.md`).
- **R27–R31:** transiciones del manifiesto, criterio de activación y regreso a `shadow` ante una
  divergencia confirmada, aplicados a los cinco hooks.
- **R39–R42:** subconjunto portado, preview sin efectos, paridad de salida y wiring.
