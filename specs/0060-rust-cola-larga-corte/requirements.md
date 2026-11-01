# Migración a Rust, fase 4: cola larga — Requirements

**Estado:** aceptada; reestructurada el 2026-10-31 · **Fecha:** 2026-10-28 · **Base:** `migration/rust`
en `b0b64ddd` (#1442). Sus tres entregas abren su PR contra `migration/rust`.

**Reestructuración (decisiones del usuario, 2026-10-31; Q26–Q29 en `design.md`).** La fase 4 se
parte en dos: esta spec se queda con la cola larga (E1–E3) y `specs/0062-rust-activacion-corte/`
toma la activación, la distribución y el corte, con R18, R20–R22, R24 y R79–R85, que salen de este
documento sin cambio de número. Las tres specs abiertas (0059, 0060, 0062) siguen la política de
velocidad de D47; R73 y R77 admiten la delegación permanente de caminos raros de D48.

## Contexto

Esta spec es la fase 4, y última, del programa de migración descrito en `specs/0057-migracion-rust/`
(§ "Fases del programa" de `requirements.md`). Hereda sin cambios las decisiones D1–D17 de 0057,
D18–D27 de 0058 y D28–D39 de 0059, y los requisitos vigentes de las tres fases.

Alcance, según la tabla del programa y las decisiones del 2026-10-28:

- **Cola larga:** los 15 hooks de `core-assets` que ninguna fase anterior porta y los comandos de
  `cli.ts` que siguen en TS al cerrar 0058 y 0059.
- **Activaciones, distribución y corte:** se movieron a `specs/0062-rust-activacion-corte/`
  (2026-10-31).

**Forma de la fase.**
- La cola larga se entrega en **vertical slices**: cada entrega porta un área funcional completa
  (sus hooks, los subcomandos que esos hooks invocan y los comandos de usuario del área) y la deja
  usable en Rust de punta a punta (Q21). La versión inicial tenía seis entregas en una sola spec
  (Q20); desde el 2026-10-31 son tres aquí y tres en 0062 (Q26).

**Puerta de entrada.**
- E1 está en curso (1a mergeada); lo que queda entra por los PRs abiertos y un PR final.
- E2 puede empezar ya: sus archivos no chocan con lo que queda de E1.
- E3 empieza cuando 0059 E2 esté en `migration/rust` (render multi-engine); lo que no dependa del
  render puede empezar antes.

**Numeración.** Los `R<n>` siguen la numeración del programa: los nuevos empiezan en R70. Los
requisitos del programa que esta spec redeclaraba para la activación, la distribución y el corte
(R18, R20–R22, R24 y R79–R85; R79–R83 redeclaraban R27–R31 de 0058 y R60–R61 de 0059) viven ahora en
0062.

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
  en cada fixture del oráculo, con diferencial cero, o delegar al TS antes de su primera salida o
  escritura en un camino declarado de delegación permanente (D48).
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
  estar en `crates/ported.json` o en la lista de delegación permanente de
  `scripts/js/rust-areas.mjs` (D48). Un test de inventario por área SHALL fallar si falta alguno.
- **R78** — Una entrega de la cola larga SHALL poder integrarse sin las otras dos: ningún comando o
  hook de un área SHALL depender en nativo de un comando de otra área de esta fase que siga en TS,
  salvo por el ejecutor del `navori` de `PATH` (R72).

### Activación, distribución y corte

R18, R20–R22, R24 y R79–R85 se movieron, con el mismo número, a
`specs/0062-rust-activacion-corte/requirements.md` (2026-10-31).

## Requisitos heredados que esta fase vuelve a ejercer

- **R5, R7 y R9:** cada comando y hook portado entra al manifiesto por ruta y flags, con diferencial
  cero en todos sus fixtures.
- **R10:** un cambio TS que llegue por merge de `dev` y altere un comando o hook portado pone CI en
  rojo.
- **R11–R13:** contrato de salidas, fail-closed y fallback al shell para los 15 hooks. T27 de 0057
  (`subagent-no-background` en `active`) se cumple en 0062 con R81.
- **R14 y R43–R49:** escrituras por la capa `Fs`, backup, poda y oráculo de escrituras.
- **R15–R17:** barra de calidad Rust y presupuesto de latencia de `bench:hooks`.
- **R29 (0058) y R54 (0059):** corpus por clase de veredicto antes de activar `guard-destructive` y
  los hooks de sesión; 0062 los verifica de nuevo con el replay de R81.
- **R50–R53 (0059):** contrato de los hooks de sesión, que 0062 activa.
- **R61 (0059):** queda sustituido por R82 de 0062: ningún hook puede quedarse en `shadow` al corte
  (R20 de 0062).
