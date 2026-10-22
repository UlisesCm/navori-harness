# #1354 — Comparabilidad de hooks y CI final de #1352

## Corrección del observador

`scripts/js/bench-hooks.mjs:isComparable` aceptaba carga inicial hasta `CPU/2`. Con diez CPUs,
una carga de 4.9 recibía `comparable: true`, pese al máximo de 4 conservado por
[#1354](https://github.com/UlisesCm/navori-harness/issues/1354). El test anterior incluso afirmaba
ese resultado. El nuevo límite es `min(4, CPU/2)`: conserva la condición más estricta de máquinas
pequeñas y rechaza carga negativa, ausente o no finita y CPU no finita o no positiva.

La regresión falló antes del cambio con carga 4.01 y diez CPUs (`expected true to be false`).
Con la corrección, los 33 casos de `bench-scripts.test.ts` pasaron. El nuevo caso conserva los
límites exactos, ignora las cargas de cinco/quince minutos y cubre metadatos inválidos. Esto
valida la clasificación; no constituye una medición de rendimiento ni acepta muestras antiguas.
`--report-only` conserva su contrato diagnóstico: exit 0 no acredita comparabilidad.

## CI final del PR #1352

La corrida [39269619834](https://github.com/UlisesCm/navori-harness/actions/runs/39269619834)
terminó correctamente el 2026-10-19. La API informa `headSha`
`9b47eb4a269971301764c07dff2d228873dfa049`; el log de checkout del shard 2 acredita el merge de
prueba `ebfb3d72cd87530944fa45df8b3058fb3e27daa7`, que integra ese HEAD sobre
`a251417bd231415c43bc091f051d9a994cf7e885`. No es una corrida del checkout actual.

Duraciones calculadas como `completedAt - startedAt` de cada paso, con resolución de un segundo:

| Paso | Inicio UTC | Fin UTC | Pared | Resultado |
|---|---|---|---:|---|
| [Coverage shard 1](https://github.com/UlisesCm/navori-harness/actions/runs/39269619834/job/118118288712) | 14:31:28 | 14:33:09 | 101 s | success |
| [Coverage shard 2](https://github.com/UlisesCm/navori-harness/actions/runs/39269619834/job/118118288212) | 14:31:27 | 14:34:05 | 158 s | success |
| [Coverage shard 3](https://github.com/UlisesCm/navori-harness/actions/runs/39269619834/job/118118288379) | 14:31:26 | 14:33:33 | 127 s | success |
| [Coverage shard 4](https://github.com/UlisesCm/navori-harness/actions/runs/39269619834/job/118118288115) | 14:31:28 | 14:32:53 | 85 s | success |
| [Aggregate coverage, floor and time budget](https://github.com/UlisesCm/navori-harness/actions/runs/39269619834/job/118119916790) | 14:34:21 | 14:34:26 | 5 s | success |

Los shards corren en paralelo; sumar sus duraciones no mide la pared del pipeline. La ventana
desde el inicio del primer paso de cobertura hasta el fin del agregado fue de 180 s e incluye
transferencia/espera entre jobs. No equivale a una comparación causal contra los 457 s históricos
de base: cambian población, scheduling y definición de pared. `checks` pasó; `affected` y
`semgrep` quedaron omitidos. No se describen como checks ejecutados.

Consulta reproducible:

```sh
gh run view 39269619834 --json headSha,event,conclusion,jobs
gh run view 39269619834 --job 118118288212 --log
```

### Archivos más lentos por shard

Se recuperaron los cuatro artefactos `vitest-shard-{1,2,3,4}` de la misma corrida. Cada uno contiene
`shard-i-4.json`. El merge nativo de Vitest 5.0.1, con reporter JSON y cobertura deshabilitada,
reconstruyó 465 archivos y 9 734 casos: 9 733 aprobados, uno pendiente y cero fallos. Este merge
solo lee resultados; no vuelve a ejecutar pruebas ni valida el checkout actual.

Las duraciones siguientes usan `testResults.endTime - startTime` del JSON nativo: ventana entre
el primer caso y el último caso del archivo. No son la pared del worker ni incluyen todo el
arranque/import del archivo. El cálculo directo sobre los blobs coincidió con el merge nativo
en las cuatro filas (tolerancia 0.001 ms).

| Shard | Archivos / casos en blob | Archivo más lento, relativo a `packages/cli/` | Duración |
|---|---:|---|---:|
| 1 | 117 / 1 930 | `src/commands/__tests__/audit.test.ts` | 52 396.772 ms |
| 2 | 116 / 2 230 | `src/__tests__/hooks-zsh-parity.test.ts` | 76 036.092 ms |
| 3 | 116 / 3 187 | `src/__tests__/audit-hooks.test.ts` | 62 462.469 ms |
| 4 | 116 / 2 387 | `src/lib/master/__tests__/slice.test.ts` | 45 378.462 ms |

SHA256 de los blobs descargados (bytes de `shard-i-4.json`, no del ZIP del artefacto):

| Shard | SHA256 |
|---|---|
| 1 | `ac4b22e65f710a0bba1dfb20b01ffa5626943ccb7610fa42ebb3c2ddd767c784` |
| 2 | `b1c35cceabb94217e913f22c7a2792e4f2e97a007cba2d255af4917b653c8fe2` |
| 3 | `6c10265b66231c3858e7c67e56d026a47b762591a643a551385107c28cd5db37` |
| 4 | `10e5b421d3478269d631fe9854aadb92864345caa479966533c49b25208da805` |

## Pendientes conservados

#1354 continúa abierto. Falta medir los tres hooks suplementarios en tres observaciones por lado,
con carga inicial ≤4 y bindings de fuente/observador; reacreditar cohortes y aceptaciones después
de cambios de fuentes y completar T39/A11. La pared y el archivo más lento por shard de la CI final
de #1352 quedan documentados aquí; no se trasladan a una fuente posterior. M5/R12 sigue
diferido y Node permanece en el carril de fallos: no se ejecutó un oráculo de eliminación. Los
checkpoints históricos de la spec conservan su fecha y sus límites.
