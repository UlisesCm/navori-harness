# Migración a Rust, fase 5: activación, distribución y corte — Design

**Estado:** aceptada (Q26–Q29 resueltas por el usuario el 2026-10-31; Q24 sigue abierta) · **Fecha:**
2026-10-31 · **Base:** `migration/rust` en `e8859f49` (merge de #1465).

**Alcance del documento:** activación de los 22 hooks, ensayo de distribución y corte. Sale de E4–E6
de la versión anterior de 0060. Reutiliza D1–D48; las decisiones nuevas siguen la numeración (D49 en
adelante), igual que los modos de falla (F44 en adelante). Aplica la política de velocidad de D47 de
0060.

## Approach

Tres entregas y cuatro PRs. E1 y E2 corren en paralelo entre sí y con 0059 y 0060; E3 va al final:

| Entrega | PR | Entregable |
|---|---|---|
| E1 | dos, contra `migration/rust` | Los 22 hooks deciden en Rust (`active`), en dos lotes: primero los que llevan 7 días o más en `shadow`, después los de la cola larga |
| E2 | contra `migration/rust` | El paquete instala y responde en macOS y Linux, sin publicar; `cutover:check` existe y está en verde |
| E3 | contra `dev` | `navori` es el binario Rust en `dev`, con el TS congelado como respaldo y para las delegaciones permanentes |

**Por qué así.** La activación se desacopla del calendario de la cola larga: un hook en `shadow`
desde hace 7 días con replay y fuzz en cero se puede activar aunque su área tenga comandos sin
portar, porque el hook no depende de ellos (R72 de 0060). El corte deja de esperar al último
subcomando raro: el TS congelado ya viaja en el paquete (R22) y atiende las delegaciones
permanentes, así que exigir el 100 % nativo solo retrasaba el corte sin bajar el riesgo.

## Decisions

### D49 — Activación por evidencia mínima, sin umbral por clase (R79–R83; reemplaza D45 de 0060)

- **Evidencia (R81).** `scripts/js/hook-shadow-report.mjs` lee el ledger de `navori tools
  rust-shadow` y reporta, por hook y engine, invocaciones y divergencias dentro de una ventana (7 días
  por defecto). Sale en rojo con cualquier divergencia. No aplica umbrales por clase.
- **Con compuerta:** replay nativo a cero, fuzz de 100 000 entradas a cero (una sola corrida, en
  lote, antes del PR; ver D47 de 0060) y sombra sin divergencias. Sin tráfico en un engine, la
  activación en ese engine necesita la aprobación por hook de R82.
- **Advisory:** replay nativo a cero. La sombra se reporta, pero no bloquea.
- **Lotes.** E1 activa en dos PRs, cada hook con su línea `activate`: el lote 1 son los hooks con 7
  días o más en `shadow` al abrir el PR (los siete de las fases 1–3 y los de 0060 E1 ya portados);
  el lote 2, los de 0060 E1 (T13, T14), E2 y E3 cuando cumplan su ventana. Son dos PRs porque la
  ventana es calendario: un solo PR dejaría esperando a los hooks que ya cumplen. E3 exige que no
  quede ninguno en `shadow` (R20).
- **Transiciones (R79, R80).** `scripts/js/rust-manifest-check.mjs` añade la regla de transiciones
  (antes T2 de 0058).

### D50 — Corte con delegación permanente (R20, R22, R24; enmienda D17 de 0057 y D46 de 0060)

- La lista de delegación permanente vive en `scripts/js/rust-areas.mjs` (D41 y D48 de 0060), junto
  al inventario. `cutover:check` acepta un subcomando o flag que esté en el manifiesto o en esa lista.
- El lanzador ejecuta el binario. El binario conserva el mecanismo de delegación de 0057 y, después
  del corte, lo dirige al TS congelado de `legacy/` en vez de al `dist/` del repo.
- El PR de corte borra `packages/cli/src` salvo lo que exige el TS congelado (que es el `dist/`
  publicado, no el fuente) y las suites de artefacto, y elimina el oráculo TS.

### D46 (de 0060) — Distribución según D17 de 0057 (R18, R21, R22, R84, R85)

Se conserva sin cambios de fondo: patrón esbuild (`navori` con lanzador JS y
`optionalDependencies` por plataforma, `postinstall` que enlaza solo si `--version` coincide),
`legacy/` con el `dist/` exacto del último TS publicado verificado por `integrity`, binarios musl
estáticos en Linux, sondas de `scripts/js/dist-probe.mjs` y `check:post-cutover` cronometrado.

## Failure modes

- **F44 — Un hook activado diverge en uso real.** Mitigación: R80 (vuelta a `shadow` con
  `deactivate`) y la matriz fail-closed de R83.
- **F45 — Una delegación permanente queda sin TS que la atienda.** Si el paquete se instala sin
  `legacy/`, el subcomando delegado falla. Mitigación: la sonda de R84 ejecuta también un
  subcomando de la lista de delegación permanente.
- **F43 (de 0060) — El postinstall no corre o el binario no coincide.** Mitigación: lanzador por
  Node o TS congelado (R22) y la sonda de R84.

## Testing strategy

- **Activación:** `hook-shadow-report.mjs` (R81, R82), `rust-manifest-check.mjs` con transiciones
  (R79, R80), replay nativo de los 22 hooks, el fuzz de 100 000 entradas de los hooks con compuerta
  (una corrida por lote) y la matriz fail-closed por engine (R83).
- **Distribución y corte:** sondas de R84, `check:post-cutover` cronometrado (R18) y
  `cutover:check` (R20).

## NOT in scope

- Portar los subcomandos de la lista de delegación permanente: siguen en el TS congelado y se
  pueden portar después del corte, en specs propias.
- Windows y otras plataformas sin binario: reciben el TS congelado (R22).
- Publicar en npm: E2 ensaya sin publicar; la publicación sigue el paso manual del README tras E3.

## Decisiones del usuario

| Q | Resolución |
|---|---|
| Q26 | (2026-10-31) Partir la fase 4: 0060 se queda con la cola larga y 0062 con la activación, la distribución y el corte |
| Q27 | (2026-10-31) Activación por evidencia mínima (D49): replay, fuzz de 100 000 y 7 días de sombra sin divergencias para hooks con compuerta; solo replay para advisory; sin umbral por clase |
| Q28 | (2026-10-31) Corte con delegación permanente de subcomandos raros al TS congelado (D50) |
| Q29 | (2026-10-31) Política de velocidad de D47 de 0060 en las tres specs abiertas (0059, 0060, 0062) |
| Q30 | (2026-11-02) Partir el PR 1a: las herramientas (T1, T2, T4) entran sin esperar la ventana de sombra, que empezó el 2026-11-02; el lote 1 (T3) y el reporte de sombra de A1 van en 1a′ |

## Preguntas (abiertas)

- **Q24 [human] — Scope npm de los paquetes de plataforma.** Pendiente desde la decisión 3 del
  usuario en 0057. Bloquea solo E2.
