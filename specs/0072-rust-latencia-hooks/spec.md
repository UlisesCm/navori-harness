# Latencia de `session-start-context` y del guard con comandos largos (0.13.x, rebanada 6)

## Resultado

Quien usa navori con Claude Code o Pi paga menos latencia al abrir una sesión y al mandar comandos largos. La meta es el presupuesto de R17 (5 ms de p95 por invocación nativa) para `guard-destructive` con comandos de 6 y 40 KB y para `session-start-context`. Un perfil dice primero qué tan cerca se puede llegar. Si alguna celda no alcanza los 5 ms, recibe un presupuesto propio documentado, con su techo y su motivo, como en la lista de deuda de R17, y el umbral general no sube. Para quien mantiene el harness, cada celda que sale de la lista de deuda de R17 vuelve a exigir su presupuesto en `cutover:check`. Los veredictos y el contexto de los dos hooks no cambian.

## Guion de aceptación

Entorno: un runner Linux de la CI en reposo (carga ≤ min(4, CPU/2) al empezar), binario `navori-rust` en release desde la rama, y una sesión real de Claude Code y otra de Pi sobre un repo de prueba.

1. Leer el perfil de `session-start-context` y del guard con comandos largos. **Esperado:** el tiempo repartido por proceso lanzado, lectura y evaluación, y, para cada celda que no alcance 5 ms, su presupuesto propio con techo y motivo, anotado en esta spec.
2. Correr `bench:hooks --impl rust` comparable tres veces seguidas. **Esperado:** en las tres, el guard en los cuatro escenarios largos, en Claude y en Pi, y `session-start-context`, dentro de su presupuesto.
3. Correr `cutover:check` con ese reporte. **Esperado:** `ready`; ninguna de esas celdas aparece como `r17-debt`.
4. Correr el fuzz de comandos largos de los dos hooks (6 y 40 KB, con el patrón destructivo al principio, en medio y al final) y el replay de veredictos. **Esperado:** cero diferencias frente al shell, también en el motivo de auditoría.
5. Abrir dos veces seguidas una sesión de Claude Code y, entre una y otra, hacer un commit y editar un archivo de contexto. **Esperado:** cada arranque da el contexto que da hoy para ese estado del repo.
6. Mandar en Claude y en Pi un comando de 40 KB con `rm -rf /` al final, y el mismo sin nada destructivo. **Esperado:** bloquea el primero con el mensaje de hoy y deja pasar el segundo.
7. Revisar el historial del manifiesto. **Esperado:** una línea por hook cuyo `impl` cambió, y ninguna activación nueva.
8. Correr el bench con carga alta. **Esperado:** "no comparable", que bloquea como hoy.

## Reglas aplicables

- R1 — El presupuesto de R17 es 5 ms para las dos, y el umbral general no cambia. Una celda que el perfil muestre que no llega recibe un presupuesto propio documentado por celda, con techo y motivo, con el mismo patrón que la lista de deuda de R17 (decisión de Ulises, 24 nov). Por encima de su techo, bloquea.
- R2 — Los veredictos, mensajes, salidas y motivos de auditoría de los dos hooks no cambian: replay y fuzz sin diferencias frente al shell, en Claude y en Pi.
- R3 — Se re-firman solo los hooks cuyo `impl` cambia, cada uno con su línea en el historial del manifiesto.
- R4 — `session-start-context` no guarda en caché el contexto final ni repite sus efectos (`--ack`, el arm de auditoría, el aviso de worktrees). Solo puede cachear hechos puros, con la caché de hechos que ya existe.
- R5 — El guard sigue evaluando el comando completo. Un atajo para comandos largos solo entra con una prueba de equivalencia que incluya el motivo de auditoría.
- R6 — Una celda sale de la lista de deuda de R17 solo cuando tres corridas comparables seguidas la miden dentro de su presupuesto: el p95 sale de 40 corridas por celda y oscila cerca del borde.

## Estados

| Estado | Lo que ve el usuario |
|---|---|
| Vacío | Sesión sin contexto que inyectar: el arranque vacío de hoy. |
| Error | Hecho en caché ilegible: se recalcula. El guard bloquea si no puede evaluar. |
| Sin conexión | n/a: ninguno de los dos hooks usa la red. |
| Sin permiso | Caché de hechos sin escritura: se recalcula, con el mismo contexto. |

## Entorno y datos

- Prerrequisito: la lista de deuda de R17 (`R17_DEBT` en `scripts/js/cutover-check.mjs`, #1839), que entra con el corte. No está en H.
- Partida: corrida comparable sobre H (`997128b9`), run 45535565662, ubuntu-latest con 4 CPU y carga 1,50. `session-start-context` 75,7 ms de p95; guard con comandos largos de 9,1 a 12,7 ms en Claude y de 11,5 a 15,1 ms en Pi. Techos de deuda: 114, 15, 19, 18 y 23 ms. El p95 sale de 40 corridas por celda.
- La re-firma de latencia del guard ya está en H (#1772, `106e8a941`, `3ea9a30dd`, `f4b5d7f0c`, `08968c9c8`): estas cifras son posteriores, y lo que falta va más allá de esa re-firma.
- Hipótesis del desafío, a confirmar con el perfil: `session-start-context` lanza `git` tres veces, `navori plan resume` y, si el `navori` del `PATH` no es esta compilación, el TS. El guard con comandos largos supera el camino rápido (4 KB) y paga la compilación de patrones.
- Desafío del auditor (24 nov), incorporado; resumen en el PR de esta spec.
- La medición se hace en la CI de Linux: en macOS el carril PII nativo difiere y el bench no termina.
- Área crítica: hooks y su re-firma. La implementación empieza después de publicar 0.13.0.

## Fuera de alcance

- Otros hooks y escenarios, ya dentro del presupuesto.
- `routing-watch` y `bash-outcome-watch`: 0.14.

## Tareas

1. El perfil de los dos hooks está escrito y cada celda que no llega a 5 ms tiene su presupuesto propio con techo y motivo.
2. El fuzz cubre comandos largos con el patrón destructivo en distintas posiciones.
3. `guard-destructive` queda dentro de su presupuesto con comandos de 6 y 40 KB, en Claude y en Pi.
4. `session-start-context` queda dentro de su presupuesto, con el mismo contexto.
5. Replay y fuzz sin diferencias; re-firma con su línea de historial.
6. Las celdas medidas dentro del presupuesto salen de la lista de deuda y `cutover:check` da `ready`.
7. El guion pasa en la CI de Linux y en sesiones reales de Claude Code y Pi.
