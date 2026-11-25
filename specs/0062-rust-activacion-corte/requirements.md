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
en Codex. Al retomar la migración, el código Rust de esos cuatro ya portados
(`master-plan-context`, `master-accept-confirm`, `role-guard` y `engram-write-guard`) sale del
manifiesto y del binario junto con `master` (enmienda de 0060). Extender `PERMANENT_DELEGATION` y
`cutover:check` a hooks y a motores es parte de T10.

**Delegación transitoria (enmienda de R20 y T10, 23 nov 2026; decisiones-ulises/2026-11-23-t10-alcance).**
R20 se lee además "... o en la **delegación transitoria** de `rust-areas.mjs`". Es la lista
`TRANSITIONAL_DELEGATION`, separada de `PERMANENT_DELEGATION`, con un motivo por entrada. Reúne lo
que el corte de 0.13.0 deja en el TS congelado (los comandos y banderas sin portar, que se portan por
demanda según el inventario post-0.13) o en `shadow` (los hooks que solo corren en Claude, si no
tuvieron tráfico de Claude en la ventana R81; se activan en 0.13.x). Es deuda, no una decisión
permanente: ninguna entrada repite la lista permanente ni los hooks shell permanentes.
`cutover:check` no bloquea por ella, pero la lista aparte como `transitional`. Es solo datos: el
cierre de la ventana ajusta los hooks de la lista (deja los de Claude sin tráfico y quita los que se
activan) sin rehacer T10.

**Estimado restante** (LOC; referencia gruesa).

| Entrega | Estimado original | Restante antes | Restante después |
|---|---|---|---|
| E1 | 3 000 | ≈1 000 (T3, T5; 22 hooks en tres motores) | ≈800 (15 hooks en Claude y Pi) |
| E2 | 3 500 | 0 (T6–T9 hechas) | 0 |
| E3 | 2 000 | ≈2 000 | ≈2 200 (más hooks shell permanentes y motores del corte en `cutover:check`) |

## Enmienda de R22 (2026-11-20, decisión de Ulises): el TS congelado se publica aparte

**Por qué no sirve el último TS publicado.** Se probó el binario de `migration/rust` (a313f2d5) con
`navori@0.12.5` como `legacy/`, en 23 pasos (los comandos nativos y toda la delegación permanente)
y 5 configs (sin `claudePlugins`, válido, vacío, id inválido y valor no booleano). 0.12.5 trae sus
propios assets, no los del TS congelado:

- sobre un proyecto al día, `workspace render --apply` reescribe 11 archivos: quita el bloque
  `navori:native-runtime` de los 8 hooks portados, vuelve `publisher.md` e `idioma-rol` a
  "Spanish MX" y reescribe `.claude/settings.json`; el siguiente render nativo los vuelve a escribir;
- `doctor --json` informa `renderPending: 11` (0 con el TS congelado del checkout);
- con `claudePlugins` válido, `workspace render --apply` borra el `enabledPlugins` del render nativo;
- con `claudePlugins` inválido sale 0 e ignora la clave, donde el TS congelado sale 1 con el error
  de schema.

**Qué se decide (opción E).** El TS congelado se construye desde el commit anterior al PR de corte
(T10 borra `packages/cli/src`) y se publica como paquete aparte con la versión del release. El
nombre sale de la constante `LEGACY_PACKAGE` de `scripts/js/dist-assemble.mjs`: `@navori/legacy`
si existe la org `navori`, `navori-legacy` si no. `packaging/legacy.json` fija `version`,
`integrity` y `commit`, y el ensamblado lo baja de npm y verifica la `integrity` antes de
desempacarlo, como antes.

**Hallazgo al implementarla.** Aun con el TS correcto, fuera del layout del checkout el TS no carga
`crates/ported.json` (`packages/cli/src/lib/render/native-hook.ts:42-60`) y renderiza hooks shell:
`renderPending: 8` sobre un proyecto al día. Por eso el paquete replica el layout del checkout (D53).
Con el paquete nuevo, `scripts/js/dist-legacy-smoke.mjs` repite la prueba: 115 pasos, 0 fallos.

## Nota sobre el registro de la activación (2026-11-24)

Los cuatro lotes se activaron el **24 nov 2026**, por orden explícita de Ulises, antes de que
cerrara la ventana R81 nueva: lote C en #1811, guard en #1823, lote B en #1825 y lote D en #1826.
La activación salió de esa orden, no del cierre de la ventana que prevén R81 y R82.

Las 11 líneas `activate` de `crates/ported-history.jsonl` (líneas 37-47) no dicen eso. Se
escribieron para el plan anterior y llevan `"date":"2026-11-26"`, `"pr":1527` y motivos como
"ventana R81 del 19 al 26 nov sin divergencias" o, en el lote C, "ventana R81 desde el 19 nov sin
divergencias". No se corrigen porque el historial es de solo agregar: `checkHistory` de
`scripts/js/rust-manifest-check.mjs:109-115` rechaza cualquier cambio a una línea existente. Para
esos 11 hooks, esta nota manda sobre la fecha, el PR y el motivo que dicen esas líneas.

## Enmienda del corte (2026-11-24, decisión de Ulises): T10 sin borrar el TS (opción C)

Ulises eligió la opción C del diseño del corte, con las condiciones del desafío del auditor
(decisiones-ulises/2026-11-24-t10-opcion-c). El PR de corte hace del binario el `navori` de `dev`,
re-apunta los workflows de Rust a `dev` y `main`, pone el gate de Rust dentro del status requerido
`checks`, fija el legacy y marca `packages/cli` como privado. **No borra `packages/cli/src` ni el
oráculo diferencial**: los dos borrados pasan a un PR posterior (0.13.x o 0.14), con el ensayo del
árbol cortado como aceptación. Motivo: borrar en 0.13.0 obligaría a mantener una rama de legacy
aparte, porque `dist-assemble.mjs legacy --from <sha>` necesita un commit con el TS y el
`crates/ported.json` de cada release (D53). Esa rama es posible, pero cara (desafío, punto 1), y
publicar 0.13.0 no depende del borrado.

Con esto se leen así:
- **R22, nota de la opción E:** el `dist/` publicado sale del commit anterior al PR de corte, pero
  el PR de corte no borra `packages/cli/src`.
- **R24:** "elimina el oráculo TS" pasa al PR de borrado; la delegación al TS queda para la lista
  permanente **y** para `TRANSITIONAL_DELEGATION` (la enmienda del 23 nov de R20 y T10 alcanza a
  R24).
- **T10:** "borra `packages/cli/src` salvo las suites de artefacto y elimina el oráculo TS" pasa al
  PR de borrado.
- **D50:** el binario sigue pudiendo delegar al `dist/` del checkout (orden de `delegate.rs`:
  `NAVORI_TS_CLI`, el legacy empaquetado, el `dist/` del checkout); en el paquete publicado responde
  `legacy/`.
- **docs/DIRECTION.md, "Rust migration":** las reglas de convivencia ("npm and `dev` stay
  TypeScript-only") se reemplazan por las reglas posteriores al corte.

## Enmienda de R17 (2026-11-24, decisión de Ulises): deuda de latencia declarada

Decisión de Ulises, tomada por S2 por delegación (decisiones-ulises/2026-11-24-r17-deuda). R17
(`specs/0057-migracion-rust/requirements.md`) pide p95 ≤ 5 ms por hook portado. Sobre H
(`997128b9f`), R18 queda en verde (run 45532690023, host `ci`, 508 s contra 600 s). R17 no: la
corrida comparable (run 45535565662, carga inicial 1,50) deja 9 celdas por encima de 5 ms:
`session-start-context` en `SessionStart`, que corre una vez por sesión y no por herramienta, y
`guard-destructive` con comandos largos (6k y 40k, con y sin `grep`) en Claude y en Pi, deuda
conocida de 0059 T8 cuya re-firma de latencia va en 0.13.1 (decisión del 19 nov).

**Qué se decide.** No se suben los umbrales ni se toca el bench. Esas celdas se declaran como deuda
en `R17_DEBT` de `scripts/js/cutover-check.mjs`, con el mismo patrón que `TRANSITIONAL_DELEGATION`:
una entrada por celda (engine, escenario y hook exactos), con su motivo y su techo `maxMs` (el p95
medido × 1,5, redondeado hacia arriba). `cutover:check` las lista aparte como `r17-debt` y no
bloquea por ellas.

Con esto, en R20 "R17 cumplido" se lee así: ninguna celda supera 5 ms salvo las declaradas en
`R17_DEBT`, y ninguna declarada supera su techo. Sigue bloqueando todo lo demás de R17: la falta de
reporte, un reporte no comparable, `navori-rust --version` por encima de 10 ms, una celda no
declarada y una declarada por encima de su `maxMs`, para que la deuda no crezca sin que se note. La
spec de 0.13.x suma una rebanada para bajar esas latencias y vaciar la lista.

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
  TS congelado: el `dist/` del commit anterior al PR de corte, publicado como paquete aparte
  (`@navori/legacy`, o `navori-legacy` si no hay org) con la versión del release y verificado con
  su `integrity` (enmienda del 2026-11-20).
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
