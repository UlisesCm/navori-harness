# `gate fast/full` y `receipt` nativos en Rust (0.13.x, rebanada 4)

## Resultado

Quien trabaja con el flujo de revisión de navori corre `navori gate fast` o `navori gate full` y usa `navori receipt` (`review begin/seal`, `sign`, `check`, `gate`, `ci`), y el binario `navori-rust` lo hace sin Node. El gate corre los comandos declarados en la config, deja el log completo, imprime un veredicto y reusa un verde guardado. El recibo ata la revisión al contenido que se publica. Veredictos, archivos de estado y códigos de salida son los del TS.

## Guion de aceptación

Entorno: macOS y Linux, binario `navori-rust` construido desde la rama, `PATH` sin `node` ni el CLI de TypeScript (salvo lo que el propio gate del repo ejecute), un repo de prueba con `qualityGate.fast` y `qualityGate.full`, y un PR de prueba en GitHub con una CI que termina.

1. `navori gate fast` con el gate en verde. **Esperado:** el veredicto del TS en stdout, el log completo en el directorio de estado y exit 0.
2. Repetirlo sin cambios. **Esperado:** reusa el verde guardado, como el TS; `--force` lo vuelve a correr.
3. Romper una prueba y correr `navori gate full`. **Esperado:** veredicto rojo, el log con la falla y el código de salida del TS.
4. `navori receipt review begin` sobre una rama con cambios y después `seal`. **Esperado:** el nonce y el sidecar sellado, iguales en forma a los del TS.
5. `navori gate full --review-feature f --review-nonce <nonce> --target dev`. **Esperado:** la corrida queda atada a esa revisión, como en el TS.
6. `navori receipt sign` y `navori receipt check`. **Esperado:** recibo escrito y comprobación en verde; si se edita un archivo cubierto, `check` informa la deriva como el TS.
7. `navori receipt gate` para un plan de nivel 1. **Esperado:** la misma decisión de gate acotado o completo que el TS.
8. `navori receipt ci --pr <n>`. **Esperado:** espera la corrida de la CI y responde `ok`, `no-evidence` o `refused` con los mismos campos que el TS.
9. `navori receipt ci` sin red. **Esperado:** el error del TS; nada se marca como listo.
10. `navori gate full` en un repo sin `qualityGate.full`. **Esperado:** el error de config del TS.

## Reglas aplicables

- R1 — El gate ejecuta exactamente los comandos de la config, con el entorno, el directorio y la captura del TS, y nunca altera el veredicto.
- R2 — Los archivos de estado (logs, caché de verdes, sidecars y recibos) tienen el formato del TS. Un estado escrito por uno lo lee el otro.
- R3 — El recibo cubre exactamente el conjunto que publica el TS. Una deriva o un archivo sin cubrir nunca se informa como `ok`.
- R4 — `receipt ci` consulta GitHub con las mismas llamadas, tiempos de espera y reglas de rutas no confiables que el TS.
- R5 — El evento de auditoría que hoy escribe el TS en estos comandos se sigue escribiendo igual.
- R6 — `gate fast/full`, `receipt` y sus subcomandos salen de la delegación transitoria, y `cutover:check` lo refleja.

## Estados

| Estado | Lo que ve el usuario |
|---|---|
| Vacío | Sin `qualityGate` o sin recibo: el error del TS que nombra qué falta. |
| Error | Gate rojo: veredicto, log y código del TS. Deriva del recibo: los archivos y su tipo de cambio. |
| Sin conexión | `receipt ci` sin red: el error del TS, nunca `ok`. |
| Sin permiso | Sin `gh` autenticado: el error del TS. |

## Entorno y datos

- Inventario en H (`997128b9`): `gate` (salvo `probe` y `foreign`, ya nativos) y `receipt` están en `TRANSITIONAL_DELEGATION` (`scripts/js/rust-areas.mjs`). Tamaño TS: `commands/gate.ts` 131 líneas y `commands/receipt.ts` 381; usan `lib/gate/` (caché 293 y corrida 386), `lib/handoff/review-evidence.ts` (717), `lib/diagnose/receipt.ts` (635) y `receipt-ci.ts` (367), `lib/audit/cli-event.ts` (1.220) y la clasificación de specs. Rust ya tiene la caché y la corrida del gate, la evidencia de revisión y `checkReceipt` de solo lectura; faltan `sign`, `check` con escritura, `ci` y el evento de auditoría.
- `gh` autenticado y un PR de prueba con CI para el paso 8.

## Fuera de alcance

- `gate probe` y `gate foreign`: ya nativos.
- Cambiar qué cubre el recibo o los tiempos de `receipt ci`: no cambian.
- Los modos de `audit`: 0.14.

## Tareas

1. `gate fast` y `gate full` corren, registran y reusan el verde como el TS.
2. `gate full` se ata a una revisión con `--review-feature` y `--review-nonce`.
3. `receipt review begin` y `seal` escriben la evidencia del TS.
4. `receipt sign` y `check` escriben y comprueban el recibo, con deriva.
5. `receipt gate` y `receipt ci` deciden como el TS.
6. El oráculo compara veredictos, estado y salidas con el TS; los estados se leen en los dos sentidos.
7. `gate` y `receipt` salen de la delegación transitoria.
8. El guion pasa sobre el binario construido, sin Node en `PATH`.
