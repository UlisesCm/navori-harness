# Migración a Rust, fase 5: activación, distribución y corte — Requirements

**Estado:** aceptada para desarrollo · **Fecha:** 2026-10-31 · **Base:** `migration/rust`. E1 (en
dos lotes) y E2 abren su PR contra `migration/rust`; E3 (el corte) es el único PR contra `dev`.

## Enmienda de alcance (2026-11-02): lo congelado en `dev` no se activa ni se porta

**Origen.** El inventario de limpieza de `dev` (`docs/cleanup-inventory.md`), las decisiones del
2026-11-02 en #1484 y #1502 congelan partes de navori: siguen en TS detrás de su flag, sin funciones
nuevas y sin puerto a Rust. La enmienda de alcance de 0060 saca de la cola `master` completo,
`audit`, `bench`, `codex`, `workspace`, `ticket` y `registry`, y los hooks `master-plan-context`,
`master-accept-confirm`, `audit-mode-trigger`, `audit-mode-close` y `stop-verify-reminder`. Esta
enmienda ajusta la activación y el corte a esa salida y a las decisiones del usuario en #1503. No
reescribe la spec: en `tasks.md` lo que sale queda marcado "Fuera de alcance (2026-11-02)" y se
conserva.

**Motores del corte.** Claude y Pi. Codex queda por delegación al TS y no bloquea el corte: su
render nativo (0059 E2) se queda como está, sin trabajo nuevo, y un camino de Codex sin paridad
delega (D48). R81 y R82 se exigen solo en Claude y Pi; en Codex los hooks corren su cuerpo shell.

**Qué sale.**
- **Activación (E1).** Los hooks que se activan pasan de 22 a 15. No se activan los cinco hooks
  congelados, ni `role-guard` y `engram-write-guard`, que solo se registran en Codex. Su replay,
  su fuzz y su ventana de sombra en T3 y T5 quedan fuera de alcance.
- **Delegación permanente (R20, R22, R24; D50).** La lista de `scripts/js/rust-areas.mjs` deja de
  estar vacía: suma `master`, `audit`, `codex`, `workspace`, `ticket` y `registry`, con el motivo
  "congelado en dev (#1484)". El TS congelado de `legacy/` los atiende como a cualquier delegación
  permanente.

**Hooks shell permanentes (enmienda de R20).** R20 se lee "todo hook o bloque de `core-assets` y de
los plugins en el manifiesto **o en la lista de hooks shell permanentes** de `rust-areas.mjs`, y
ningún hook en `shadow` en los motores del corte". Un hook de esa lista corre su cuerpo shell en
todos los engines, como hoy sin binario (D53), y los subcomandos que invoca van al TS congelado por
R72 de 0060 y D50. La lista son los cinco hooks congelados, más `role-guard` y `engram-write-guard`
en Codex. Al retomar la migración, el código Rust de `master-plan-context` y `master-accept-confirm`
sale del manifiesto y del binario (enmienda de 0060). Extender `PERMANENT_DELEGATION` y
`cutover:check` a hooks y a motores es parte de T10.

**Pendiente.** Si el código Rust ya portado de `role-guard` y `engram-write-guard` se conserva sin
activar o se retira del binario.

**Estimado restante** (LOC; referencia gruesa).

| Entrega | Estimado original | Restante antes | Restante después |
|---|---|---|---|
| E1 | 3 000 | ≈1 000 (T3, T5; 22 hooks en tres motores) | ≈800 (15 hooks en Claude y Pi) |
| E2 | 3 500 | 0 (T6–T9 hechas) | 0 |
| E3 | 2 000 | ≈2 000 | ≈2 200 (más hooks shell permanentes y motores del corte en `cutover:check`) |

## Contexto

Esta spec nace de partir la fase 4 (`specs/0060-rust-cola-larga-corte/`) en dos (decisión del
usuario, 2026-10-31): 0060 se queda con la cola larga de comandos y hooks, y esta spec con la
activación de los hooks, el ensayo de distribución y el corte. Hereda D1–D17 de 0057, D18–D27 de
0058, D28–D39 de 0059 y D40–D48 de 0060, y la política de velocidad de D47 de 0060.

Reúne lo que las fases anteriores movieron a la activación: T27 y A10 de 0057, E1 de 0058 (Q14) y E3
de 0059 (Q19), además de E4–E6 de la versión anterior de 0060.

**Cambios de alcance (decisiones del usuario, 2026-10-31).**
- La activación ya no exige el umbral por clase de evento y engine de D35 de 0059 ni 14 días de
  sombra. Basta la evidencia de R81 (replay y fuzz en cero y 7 días de sombra sin divergencias), y
  un hook advisory se activa solo con replay (Q27).
- El corte ya no exige el 100 % del inventario nativo. Un subcomando o flag puede quedar como
  **delegación permanente** al TS congelado, declarada en `scripts/js/rust-areas.mjs` (D48 de
  0060). Ningún hook puede quedar en `shadow` al corte (Q28).

**Puerta de entrada (en paralelo con 0059 y 0060).** E1 empieza ya: sus herramientas no dependen
de ningún hook, y activa en dos lotes, primero los hooks con 7 días o más en `shadow` y después los
que traen 0060 E1 (T13, T14), E2 y E3. E2 empieza ya, en paralelo con E1. E3 espera a que 0059 y
0060 cierren, E1 y E2 estén integradas y el usuario apruebe.

**Numeración.** Sigue la del programa. R79–R85, R18, R20–R22 y R24 se mudan desde 0060 sin cambio de
número; R81, R82 y R20 cambian de texto por las decisiones de arriba. R60 y R61 de 0059 quedan
sustituidos por R81 y R82.

## Requirements (EARS)

### Activación

- **R79** — WHEN un PR cambia un hook de `shadow` a `active` en `crates/ported.json`, el job
  `manifest` SHALL fallar, salvo que la merge-base ya tuviera ese hook en `shadow` y el PR añada una
  línea `activate` para ese id a `crates/ported-history.jsonl` (redeclara R27 de 0058).
- **R80** — IF un hook activo produce una divergencia confirmada THEN SHALL volver a `shadow` con un
  evento `deactivate` en `crates/ported-history.jsonl` antes de cualquier otro cambio en su
  implementación (redeclara R31 de 0058).
- **R81** — El PR que activa un hook con compuerta SHALL adjuntar, por hook: replay nativo del corpus
  a cero, fuzz local a cero (100 000 entradas) y un resumen de sombra sin divergencias en una ventana
  de 7 días o más en cada engine donde está registrado. Un hook advisory SHALL adjuntar solo el
  replay a cero. El PR SHALL tener la aprobación explícita del usuario.
- **R82** — IF un hook con compuerta no registra invocaciones en la sombra de un engine durante su
  ventana THEN su activación en ese engine SHALL exigir la aprobación explícita del usuario para ese
  hook, registrada en la línea `activate` con `reason: "no-shadow-traffic"`.
- **R83** — WHILE un hook esté en `active`, el hook invocado por su comando registrado exacto SHALL
  dar en cada engine el mismo veredicto que el shell. Ante una salida anómala del binario SHALL caer al
  shell o emitir el veredicto seguro, y un hook con compuerta nunca SHALL resolver en permitir
  (redeclara R30 de 0058).

### Distribución

- **R21** — El release SHALL incluir binarios para darwin arm64 y x64 y para linux arm64 y x64; en
  Linux, un binario musl estático por arquitectura.
- **R22** — IF el paquete `navori` se instala en una plataforma sin binario THEN SHALL ejecutar el
  TS congelado: el `dist/` exacto del último `navori` TS publicado, verificado con su `integrity`.
  IF el `postinstall` no corre en una plataforma con binario THEN el lanzador SHALL ejecutar el
  binario a través de Node, sin cambio de comportamiento. El TS congelado SHALL atender también las
  delegaciones permanentes de R20.
- **R84** — Antes del corte, una sonda por plataforma con binario SHALL instalar el paquete con npm,
  pnpm y bun (con y sin scripts) y SHALL comprobar que `navori --version` y un hook registrado
  responden con el binario o, sin `postinstall`, con el binario a través de Node.
- **R85** — WHEN el corte se integra, los comandos nativos SHALL mostrar el aviso de actualización
  y el de versión de herramientas en los mismos casos, con el mismo texto y el mismo plazo que el TS,
  consultando el registro por el transporte de R76 de 0060. WHILE la migración esté abierta, SHALL
  omitirlo (Q6 de 0058).

### Corte

- **R18** — Tras el corte, el gate full (`check:post-cutover`: cargo, el oráculo congelado de hooks,
  las suites de artefacto y los checks de docs y render, sin la suite TS) SHALL tardar ≤ 5 minutos en
  reposo en la máquina de referencia y ≤ 10 minutos en el runner de CI (`ubuntu-latest`), medido en
  `migration/rust` antes del corte (enmienda del 2026-11-02, D52).
- **R20** — El corte SHALL ocurrir solo con `cutover:check` en verde (todo subcomando y flag de
  `cli.ts` en el manifiesto o en la lista de delegación permanente de `scripts/js/rust-areas.mjs`,
  todo hook o bloque de `core-assets` y de los plugins en el manifiesto, ningún hook en `shadow`,
  ningún despoteo abierto, R17 y R18 cumplidos) y con la aprobación explícita del usuario.
- **R24** — La integración a `dev` SHALL ser un solo PR de `migration/rust` a `dev`, con el gate full
  en verde, que re-apunta `rust.yml` a `dev`, agrega el release, el empaquetado y el TS congelado, y
  elimina el oráculo TS. La delegación al TS SHALL quedar solo para las entradas de la lista de
  delegación permanente.

## Requisitos heredados que esta fase vuelve a ejercer

- **R10–R13:** contrato de salidas, fail-closed y fallback al shell de los 22 hooks al activarse.
- **R29 (0058) y R54 (0059):** corpus por clase antes de activar `guard-destructive` y los hooks de
  sesión; se verifica de nuevo con el replay de R81.
- **R70–R72 (0060):** paridad y contrato de los 15 hooks de la cola larga, que E1 activa.
