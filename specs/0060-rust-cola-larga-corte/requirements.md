# Migración a Rust, fase 4: cola larga, activaciones, distribución y corte — Requirements

**Estado:** borrador · **Fecha:** 2026-10-28 · **Base:** `migration/rust` en `b0b64ddd` (#1442). E1–E5
abren su PR contra `migration/rust`; solo E6 (el corte) llega a `dev`.

## Contexto

Esta spec es la fase 4, y última, del programa de migración descrito en `specs/0057-migracion-rust/`
(§ "Fases del programa" de `requirements.md`). Hereda sin cambios las decisiones D1–D17 de 0057,
D18–D27 de 0058 y D28–D39 de 0059, y los requisitos vigentes de las tres fases.

Alcance, según la tabla del programa y las decisiones del 2026-10-28:

- **Cola larga:** los 15 hooks de `core-assets` que ninguna fase anterior porta y los comandos de
  `cli.ts` que siguen en TS al cerrar 0058 y 0059.
- **Activaciones:** todos los hooks portados pasan a `active` en un solo PR, con la sombra acumulada
  desde que cada uno entró en `shadow`. Incluye lo que movieron las fases anteriores: T27 y A10 de
  0057, E1 de 0058 (Q14) y E3 de 0059 (Q19).
- **Distribución y corte:** binarios para macOS y Linux, TS congelado en las demás plataformas y un
  solo PR de `migration/rust` a `dev`.

**Forma de la fase (decisiones del usuario, 2026-10-28).**
- La fase queda en una sola spec con seis entregas, por encima del máximo de cuatro del programa
  (Q20 de `design.md`).
- La cola larga se entrega en **vertical slices**: cada entrega porta un área funcional completa
  (sus hooks, los subcomandos que esos hooks invocan y los comandos de usuario del área) y la deja
  usable en Rust de punta a punta, en lugar de repartir por capas (hooks, comandos de lectura,
  comandos de escritura) (Q21). Dentro de cada entrega, cada milestone es a su vez un slice con un
  entregable observable; los dos primeros son slices de referencia que fijan el patrón (Q25).

**Puerta de entrada.**
- E1 empieza ya con sus dos slices de referencia (M1 y M2), que no dependen de 0059. Sus milestones
  siguientes reutilizan la base compartida de hooks de 0059 E1 (ejecutor del `navori` de `PATH` y
  condición de versión), y el PR de E1 se integra después de 0059 E1.
- E2 empieza cuando E1 esté integrada.
- E3 empieza cuando E2, 0058 E3 y 0059 E2 estén en `migration/rust`: reutiliza la capa `Fs`, el
  render multi-engine y los comandos de escritura.
- E4 empieza cuando E1–E3 estén integradas y cada hook haya cumplido su ventana de sombra (R81).
- E5 empieza cuando E4 esté integrada. E6, cuando E5 esté integrada y el usuario apruebe el corte.

**Numeración.** Los `R<n>` siguen la numeración del programa: los nuevos empiezan en R70. R18,
R20–R22 y R24 son requisitos del programa que 0057 no declaró (su texto no está en git); esta spec
los redeclara a partir de la fila de la fase 4 de la tabla del programa y de D17 de 0057. R27–R31
(de 0058) y R60–R61 (de 0059) se redeclaran porque sus tareas se mudaron a esta fase.

## Requirements (EARS)

### Hooks de la cola larga

Los 15 hooks de esta fase son `audit-mode-trigger`, `audit-mode-close`, `bash-outcome-watch`,
`routing-watch`, `stop-verify-reminder`, `master-plan-context`, `master-accept-confirm`,
`implementer-no-markdown`, `role-guard`, `general-purpose-confirm`, `engram-write-guard`,
`comment-draft-confirm`, `pr-publisher-confirm`, `managed-drift-watch` y `worktree-reclaim`.

- **R70** — WHILE uno de los 15 hooks esté en `shadow` o `active`, su implementación Rust, invocada
  por el comando registrado exacto de cada engine donde el hook está registrado y con cada argumento
  de modo de ese registro, SHALL producir el mismo código de salida, stdout, stderr y eventos de
  auditoría que el shell en cada caso del corpus de veredictos y del fuzz.
- **R71** — Antes de que uno de los 15 hooks entre en `shadow`, su corpus de veredictos SHALL tener al
  menos un caso por clase de veredicto y por argumento de modo en cada engine donde está registrado.
- **R72** — WHEN uno de los 15 hooks necesita un subcomando de `navori` que todavía no es nativo, SHALL
  ejecutar el `navori` de `PATH` con el contrato de R52 y R53 de 0059; WHEN ese subcomando es nativo,
  SHALL ejecutarlo en proceso solo bajo la condición de versión de R53.

### Comandos de la cola larga

- **R73** — WHEN `navori-rust` recibe un subcomando con ruta y flags declarados en `crates/ported.json`
  por esta fase, SHALL producir el mismo stdout, stderr, código de salida y efectos en disco que el TS
  en cada fixture del oráculo, con diferencial cero.
- **R74** — Un comando de esta fase que escribe en el repo del usuario o fuera de él SHALL hacerlo por
  la capa `Fs` de 0058 (preview, backup, escritura atómica y poda), y el oráculo de escrituras SHALL
  cubrir cada uno de sus efectos.
- **R75** — Un comando de esta fase que pregunta al usuario SHALL hacer las mismas preguntas, con las
  mismas opciones, en el mismo orden y con los mismos efectos por respuesta que el TS (paridad de
  comportamiento, no visual: D16 de 0057). Sin TTY SHALL comportarse como el TS sin TTY.
- **R76** — Un comando de esta fase que usa la red o un proceso externo (`git`, `gh`, `acli`, el
  registro de npm) SHALL hacerlo a través de un transporte inyectable. El oráculo y CI SHALL usar
  respuestas grabadas, y nunca SHALL tocar la red real. IF el transporte falla THEN el comando SHALL
  reportar el mismo mensaje y código de salida que el TS.

### Vertical slices

- **R77** — WHEN se integra una entrega de la cola larga (E1, E2 o E3), todos los hooks de su área
  SHALL estar en `shadow` y todos los subcomandos y flags de su área en la tabla de `cli.ts` SHALL
  estar en `crates/ported.json`. Un test de inventario por área SHALL fallar si falta alguno.
- **R78** — Una entrega de la cola larga SHALL poder integrarse sin las otras dos: ningún comando o
  hook de un área SHALL depender en nativo de un comando de otra área de esta fase que siga en TS,
  salvo por el ejecutor del `navori` de `PATH` (R72).

### Activación

- **R79** — WHEN un PR cambia un hook de `shadow` a `active` en `crates/ported.json`, el job
  `manifest` SHALL fallar, salvo que la merge-base ya tuviera ese hook en `shadow` y el PR añada una
  línea `activate` para ese id a `crates/ported-history.jsonl` (redeclara R27 de 0058).
- **R80** — IF un hook activo produce una divergencia confirmada THEN SHALL volver a `shadow` con un
  evento `deactivate` en `crates/ported-history.jsonl` antes de cualquier otro cambio en su
  implementación (redeclara R31 de 0058).
- **R81** — El PR que activa hooks SHALL adjuntar, por cada hook que activa: replay a cero, fuzz local a
  cero (100 000 entradas para un hook con compuerta, 20 000 para uno advisory) y un resumen de sombra
  con cero divergencias y al menos el umbral de su clase de evento en cada engine donde está
  registrado, dentro de una ventana de 14 días o más. Además SHALL tener la aprobación explícita del
  usuario en el PR (redeclara R28 de 0058 y R60 de 0059 con el umbral por clase de D35 de 0059).
- **R82** — IF un hook no alcanza el umbral de su clase en 30 días de sombra THEN su activación SHALL
  exigir además el corpus completo por clase y modo (R71 o su equivalente de fase), el fuzz de R81 y
  la aprobación explícita del usuario para ese hook, registrada en la línea `activate` con el motivo.
- **R83** — WHILE un hook esté en `active`, el hook invocado por su comando registrado exacto SHALL
  dar en cada engine el mismo veredicto que el shell. Ante una salida anómala del binario SHALL caer al
  shell o emitir el veredicto seguro, y un hook con compuerta nunca SHALL resolver en permitir
  (redeclara R30 de 0058).

### Distribución y corte

- **R21** — El release SHALL incluir binarios para darwin arm64 y x64 y para linux arm64 y x64; en
  Linux, un binario musl estático por arquitectura.
- **R22** — IF el paquete `navori` se instala en una plataforma sin binario THEN SHALL ejecutar el
  TS congelado: el `dist/` exacto del último `navori` TS publicado, verificado con su `integrity`.
  IF el `postinstall` no corre en una plataforma con binario THEN el lanzador SHALL ejecutar el
  binario a través de Node, sin cambio de comportamiento.
- **R84** — Antes del corte, una sonda por plataforma con binario SHALL instalar el paquete con npm,
  pnpm y bun (con y sin scripts) y SHALL comprobar que `navori --version` y un hook registrado
  responden con el binario o, sin `postinstall`, con el binario a través de Node.
- **R85** — WHEN el corte se integra, los comandos nativos SHALL mostrar el aviso de actualización
  y el de versión de herramientas en los mismos casos, con el mismo texto y el mismo plazo que el TS,
  consultando el registro por el transporte de R76. WHILE la migración esté abierta, SHALL omitirlo
  (Q6 de 0058).
- **R18** — Tras el corte, el gate full (`check:post-cutover`: cargo, el oráculo congelado de hooks,
  las suites de artefacto y los checks de docs y render, sin la suite TS) SHALL tardar ≤ 5 minutos en
  reposo en la máquina de referencia, medido en `migration/rust` antes del corte.
- **R20** — El corte SHALL ocurrir solo con `cutover:check` en verde (todo subcomando y flag de
  `cli.ts` y todo hook o bloque de `core-assets` y de los plugins en el manifiesto, ningún hook en
  `shadow`, ningún despoteo abierto, R17 y R18 cumplidos) y con la aprobación explícita del usuario.
- **R24** — La integración a `dev` SHALL ser un solo PR de `migration/rust` a `dev`, con el gate full
  en verde, que re-apunta `rust.yml` a `dev`, agrega el release, el empaquetado y el TS congelado, y
  elimina la delegación al TS y el oráculo TS.

## Requisitos heredados que esta fase vuelve a ejercer

- **R5, R7 y R9:** cada comando y hook portado entra al manifiesto por ruta y flags, con diferencial
  cero en todos sus fixtures.
- **R10:** un cambio TS que llegue por merge de `dev` y altere un comando o hook portado pone CI en
  rojo.
- **R11–R13:** contrato de salidas, fail-closed y fallback al shell para los 15 hooks. T27 de 0057
  (`subagent-no-background` en `active`) se cumple en E4 con R81.
- **R14 y R43–R49:** escrituras por la capa `Fs`, backup, poda y oráculo de escrituras.
- **R15–R17:** barra de calidad Rust y presupuesto de latencia de `bench:hooks`.
- **R29 (0058) y R54 (0059):** corpus por clase de veredicto antes de activar `guard-destructive` y
  los hooks de sesión; E4 los verifica de nuevo antes de medir la sombra.
- **R50–R53 (0059):** contrato de los hooks de sesión, que E4 activa.
- **R61 (0059):** queda sustituido por R82: ningún hook puede quedarse en `shadow` al corte (R20).
