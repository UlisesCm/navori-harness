# Solución: observaciones sin `complete` cuando el bridge aborta a un hermano (#1783)

Autor: S3, 23 nov 2026. Estado: **diseño, nada implementado**. Se decide después del corte del 26: hasta entonces no cambia nada del camino de los hooks ni de la medición de R81.

## Problema verificado

- **Diagnóstico completo:** #1783, issuecomment-7112969548. Del 19 al 23 nov hay 20 observaciones de Pi sin `complete`:
  - 15 de forma A: un hermano bloqueó y el bridge cortó a los demás.
  - 4 de forma B: plazo agotado bajo presión.
  - 1 aislada.
- **Dónde corta el bridge:** al primer bloqueo, después de una gracia de 2 s (`BRIDGE_SIBLING_GRACE_MS`, `packages/cli/src/engines/pi/bridge-source.ts:51` y `:383` en la punta). Manda SIGTERM al grupo de cada hermano y SIGKILL a los 2 s (`:166-179`).
- **Qué escribe el binario:**
  - Escribe `begin` antes de leer stdin (`crates/navori-cli/src/hook.rs:468-488`).
  - Escribe `complete` después del script y de la comparación, y antes del veredicto (`hook.rs:510-516`). Por eso el que bloquea siempre completa.
  - Queda sin `complete` el hermano al que matan mientras corre el script en sombra.
- **Efecto en R81:** el informe cuenta esas filas como pérdidas o como canceladas inferidas (`--sibling-cancel`). Con hooks que bloquean seguido, eso sube el ámbar y el rojo de lotes sanos.

## Restricciones encontradas al diseñar (verificadas)

1. **El workspace prohíbe `unsafe`.** `Cargo.toml:30` tiene `unsafe_code = "deny"`, y en `crates/` no hay ningún `allow(unsafe_code`. `navori-cli` depende solo de `navori-core`, `navori-hooks`, `lexopt`, `serde_json` y `sha2` (`crates/navori-cli/Cargo.toml`). Atrapar SIGTERM en el binario exige una dependencia nueva (`signal-hook` o similar; piso de nivel 2) o una excepción a la lint. **Esto encarece la opción 3 que recomendé en el diagnóstico.**
2. **El script en sombra corre en su propio grupo de procesos** cuando hay plazo (`crates/navori-cli/src/shadow.rs:258-260`, `process_group(0)`). El SIGTERM del bridge al grupo del binario no lo alcanza.
   - **Sin verificar:** que en Pi siempre haya plazo (`SHADOW_DEADLINES`, `shadow.rs:27-32`, decide por hook).
   - Si lo hay, el bash del hermano abortado sigue vivo hasta su propio plazo, aunque su padre ya murió. Es un efecto aparte que vale medir.
3. **El journal es del binario.** El bridge no conoce el id de observación que devuelve `begin_until` (`hook.rs:475`).
4. **Hay que mantener todo fuera de `implementationHash`** (`scripts/js/rust-manifest-check.mjs:168-179` hashea solo `crates/navori-hooks/src`). `navori-cli` y el bridge quedan fuera del hash, pero los dos están en el camino de los hooks.

## Opciones

| # | Qué hace | Archivos | Coste y riesgo | Resuelve |
|---|---|---|---|---|
| 1 | El bridge escribe un marcador `aborted` (hook, engine, hora y motivo) al cortar a un hermano | `bridge-source.ts`, escritura del journal (Rust y TS) y `hook-shadow-report.mjs` | Dos escritores del journal; correlación por tiempo, ambigua cuando hay llamadas simultáneas (caso del 23 nov 15:59Z, 11 hermanos) | Las formas A, si la correlación acierta |
| 2 | El informe distingue A, B y aisladas con el hecho de que el que bloquea siempre completa | `scripts/js/hook-shadow-report.mjs` y su prueba | Solo el informe; cambia la medición: después del corte, con la ventana nueva ya abierta o en la siguiente | Ninguna pérdida desaparece, pero quedan clasificadas |
| 3 | El binario atrapa SIGTERM y escribe `complete` con `aborted` antes de salir | `hook.rs`, `journal.rs`, esquema del journal y **una dependencia nueva** | Nivel 2 por piso (dependencia nueva). El handler corre en un hilo aparte; carrera con el `complete` normal | Las formas A en todos los engines |
| 5 | **Id de llamada del bridge.** El bridge pasa a cada hermano `NAVORI_BRIDGE_CALL=<uuid>:<hook>`. El binario lo copia en la fila `begin` (campo opcional). Al abortar, el bridge agrega una línea `{"abortedCall": "<uuid>:<hook>", "reason": …}` a un archivo propio (`rust-shadow/bridge-aborts.jsonl`). El informe une las dos fuentes por id exacto | `bridge-source.ts` (+ assets), `journal.rs` (un campo opcional en `begin`), `hook-shadow-report.mjs` | Sin dependencias ni `unsafe`. Un escritor por archivo. El bridge solo hace un `appendFile` al abortar. Correlación exacta | Las formas A en Pi; Claude y Codex no tienen bridge |
| 4 | No cortar a los hermanos | `bridge-source.ts` | Más latencia en cada bloqueo | Descartada |

## Recomendación

**La 2 primero, la 5 después. La 3 queda descartada mientras siga la lint `unsafe_code = "deny"` y no se acepte una dependencia nueva.**

- **La 2** sola ya separa las formas A, que no son fallas del nativo, de las pérdidas reales. Solo toca el informe. Entra cuando Ulises decida tocar la medición, nunca antes del 26.
- **La 5** pasa de inferir a registrar las formas A sin tocar el modelo de señales del binario.
  - El campo nuevo de `begin` es opcional: los lectores actuales lo ignoran (verificar con `hook-shadow-report.mjs` antes de implementar).
  - Va en el grupo que re-instala, porque cambia `bridge-source.ts` (política `todo-en-013`, punto 2).
- **La forma B** (plazo bajo presión) no la resuelve ninguna opción: es del entorno y el criterio de 10 min la sigue contando.
- **El efecto 2** (el bash del hermano sobrevive al SIGTERM) se mide aparte. Si se confirma, conviene que el binario mate su grupo cuando muere el padre. Eso también necesita señales, así que queda como hallazgo y no como parte de esta solución.

## Verificación prevista (cuando se implemente)

- **Prueba del bridge:** dos hermanos, uno bloquea. `bridge-aborts.jsonl` tiene exactamente una línea con el id del cortado, y su `begin` lleva el mismo id.
- **Prueba del informe:** una observación sin `complete` con id en `bridge-aborts` sale como "cortada por hermano (registrada)". Sin id, sale como hoy.
- **Paridad:** el `begin` sin `NAVORI_BRIDGE_CALL` es byte a byte igual al actual.
- **Sin firmas:** `rust-manifest-check.mjs` en verde y `ported.json` sin cambios.

## Desafío del auditor y cambios (23 nov, ~16:35)

Informe completo: `solution_review_1783-aborto-hermanos.md`. Veredicto: la 5 procede con cambios, la 2 procede y la 3 no procede. S3 verificó estos puntos:

- **[ALTO] La opción 5, tal como estaba escrita, no es compatible con los lectores.**
  - `identitySchema` es `z.strictObject` (`packages/cli/src/lib/rust-shadow/journal.schema.ts:31`). El auditor cita también `beginSchema` y `completeSchema` (`:68`, `:76`).
  - Además, el journal no lo escribe `journal.rs`: este pasa flags al CLI TS (`tools rust-shadow`).
  - **Cambio:** el id no va en la fila `begin`. El bridge escribe `bridge-aborts.jsonl` con `(hook, engine, pid del hijo, hora del spawn, motivo)`. El informe une por hook, engine y ventana de ±500 ms alrededor del `begin`, el mismo criterio que `hermanos.sh`. Con varias llamadas simultáneas del mismo hook, la unión puede ser ambigua; el informe la marca como ambigua en vez de adivinar. No toca el esquema ni el binario.
- **[MEDIO]** El bridge debe usar el mismo endurecimiento que `appendPrivateAuditFile` (`journal.ts:46-57`; sin verificar por S3) y una escritura síncrona.
- **Opción 6 (nueva, del auditor): no matar a los hermanos tras el bloqueo.**
  - Verificado por S3: la llamada ya vuelve al instante con el primer bloqueo (`bridge-source.ts:368-383`, `Promise.race([firstBlock, …])`). Los hermanos reciben `stop.abort()` 2 s después y el SIGTERM llega por `kill` (`:262-271`). Quitarlo no suma latencia a la llamada.
  - **Coste:** los hermanos siguen hasta su propio plazo. `quality-gate-pre-commit` aparece en 6 de las 15 formas A; dejarlo terminar es correr su gate completo después de que la llamada ya se bloqueó. #1773 eligió cortar a propósito.
  - **Variante más barata:** subir la gracia (`BRIDGE_SIBLING_GRACE_MS`) solo lo justo para que terminen los hermanos rápidos. Los últimos `complete` del diagnóstico llegan entre +119 y +430 ms; los cortados son los lentos.
- **El efecto 2 es real, pero solo afecta a 2 hooks.** Solo `guard-destructive` y `pii-egress-guard` tienen plazo (`shadow.rs:19-23`), y su bash corre en su propio grupo. Al morir el binario, ese bash sigue hasta terminar. En los demás comparte grupo y muere con el SIGTERM.
- **Corrección de citas:** el kill del bridge está en `:262-271`, no en `:166-179`.

### Recomendación final

1. **Opción 2 (solo el informe)**, cuando Ulises decida tocar la medición, nunca antes del 26. Con lo que ya hay, separa "cortada por un hermano" de "aislada", pero no puede distinguir la forma B de la A sin un dato nuevo.
2. **Opción 5 corregida** (`bridge-aborts.jsonl` aparte, sin tocar el esquema ni el binario). Da ese dato nuevo: registra el motivo del corte (bloqueo de un hermano, plazo o aborto de la llamada). Entra en el grupo que re-instala, porque cambia `bridge-source.ts`.
3. **Opciones 3, 4 y 6, no.** La 3 necesita señales: una dependencia nueva o una excepción a `unsafe_code = "deny"`. La 4 y la 6 cambian el comportamiento por una medición; si Ulises prefiere la 6, que sea la variante de la gracia y con medición previa de cuánto tarda cada hermano.

**Decide Ulises. Nada se implementa antes del 26.**
