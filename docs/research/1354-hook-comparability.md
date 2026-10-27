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

## Cierre 2026-10-26

Decisión "Medir y cerrar" (2026-10-26): muestra fresca de los tres hooks suplementarios y de tests en
reposo, cohortes del 2026-10-18 declaradas no reproducibles (hashes conservados), tabla CI final del
HEAD final y M5/R12 diferido. Los reportes nuevos traen provenance (`head`, `dirty`).

### CI final del PR #1398

Run [40368114190](https://github.com/UlisesCm/navori-harness/actions/runs/40368114190): PR #1398,
`headSha` `5a48be15b321c6bedba88a578479c958b7964d6b`, evento `pull_request`, plan full, conclusión
success. Duración = `completedAt - startedAt` de cada job.

| Job | Resultado | Inicio UTC | Fin UTC | Duración |
|---|---|---|---|---:|
| plan | success | 2026-10-26T17:23:14Z | 2026-10-26T17:23:25Z | 11 s |
| checks | success | 2026-10-26T17:23:14Z | 2026-10-26T17:23:40Z | 26 s |
| test (1) | success | 2026-10-26T17:23:28Z | 2026-10-26T17:26:14Z | 2 m 46 s |
| test (2) | success | 2026-10-26T17:23:27Z | 2026-10-26T17:26:34Z | 3 m 07 s |
| test (3) | success | 2026-10-26T17:23:27Z | 2026-10-26T17:25:41Z | 2 m 14 s |
| test (4) | success | 2026-10-26T17:23:27Z | 2026-10-26T17:25:51Z | 2 m 24 s |
| test-merge | success | 2026-10-26T17:26:36Z | 2026-10-26T17:26:56Z | 20 s |

`semgrep` y `affected` quedaron omitidos (skipped); no se describen como checks ejecutados. Frente a
la corrida de `9b47eb4a` (secciones anteriores: pasos de cobertura de 101/158/127/85 s y agregado de
5 s), las unidades difieren: allí se miden pasos; aquí, jobs completos. Cambian además HEAD,
población y scheduling, por lo que no se atribuye causalidad.

### Hooks suplementarios (A3)

Seis reportes comparables con provenance (`dirty=false`), tres por head: base
`a251417bd231415c43bc091f051d9a994cf7e885` y C `5a48be15b321c6bedba88a578479c958b7964d6b`,
medidos con el observador de C. Celdas: mediana de n=3, ms `wall/cpu`, orden `absent / root / active`
(21 renglones: 7 combinaciones por 3 estados).

| Engine | Hook | Evento | Base `a251417b` | C `5a48be15` |
|---|---|---|---|---|
| claude | `bash-outcome-watch.sh` | BashFailure | 36/32 / 42/38 / 41/37 | 40/36 / 40/36 / 45/40 |
| codex | `engram-write-guard.sh` | Memory | 23/13 / 41/29 / 44/32 | 24/15 / 24/15 / 47/34 |
| claude | `audit-mode-close.sh` | SessionEnd | 12/8 / 15/10 / 106/119 | 14/10 / 16/12 / 93/95 |
| codex | `audit-mode-close.sh` | SessionEnd | 17/8 / 17/8 / 112/119 | 20/10 / 20/10 / 100/97 |
| pi | `audit-mode-close.sh` | SessionEnd | 10/8 / 10/8 / 104/119 | 13/10 / 12/10 / 93/97 |
| claude | `worktree-reclaim.sh` | SessionEnd | 30/23 / 50/42 / 53/43 | 35/26 / 33/26 / 55/46 |
| pi | `worktree-reclaim.sh` | SessionEnd | 28/24 / 48/41 / 51/43 | 32/26 / 32/27 / 55/47 |

`bash-outcome-watch` cambió funcionalmente en `d2bee468`: su delta no es costo puro.

SHA256 de los seis reportes comparables (`.navori/state/bench/`, orden del reporte de evidencia):

| Reporte | Head | SHA256 |
|---|---|---|
| `hooks-2026-10-26T17-30-44-751Z.json` | a251417b | `49563323b14fb2358238ceda3cc3592c3bd04e61bb42703f18e22dcf838e4424` |
| `hooks-2026-10-26T17-30-49-336Z.json` | a251417b | `85c09a4e58a7ee03a4cf8db41fac8224231759ae53a6dd158e0633961582f03e` |
| `hooks-2026-10-26T17-30-54-324Z.json` | a251417b | `ad18698ca1a795ea4370ff1e72122fe55802068031cb42e2278d4650d63bcd7d` |
| `hooks-2026-10-26T17-30-59-037Z.json` | 5a48be15 | `493768c3709a42e2e14b50896ea967c3308a71f9d7210753537e4bcb1cbad829` |
| `hooks-2026-10-26T17-36-12-162Z.json` | 5a48be15 | `e1eb9832bb10d935f8b688f1cabe3dd5fa716042ed8f5668efd9128a1296edca` |
| `hooks-2026-10-26T17-36-16-556Z.json` | 5a48be15 | `c33b20fe3d9a7a66fc672e3fe320ba6135f1aa6b40ec9860e7a3ed11d6a7b9a1` |

### Corridas de tests

SHA256 de los reportes (`.navori/state/bench/`):

| Reporte | SHA256 |
|---|---|
| `tests-2026-10-26T17-36-16-660Z.json` | `e9920a47ca884d428722ca3ec2dad88e1e5aa3aacfc215aa6b5b51d4cdc6dd1b` |
| `tests-2026-10-26T17-44-49-609Z.json` | `4d6f13d2ed1a042aee55d42fdc68faf0f8b5c8f6f8f7a428fc91cb9a4d15f210` |
| `tests-2026-10-26T17-53-59-397Z.json` | `da71e937d2d973bb13d53c0ef5f21cffd011d3f89041787ab859c15c00854678` |

| Inicio | wall (ms) | sumFiles (ms) | Archivos | Tests | Workers | Carga inicial (1/5/15 min) | Head | dirty |
|---|---:|---:|---:|---:|---:|---|---|---|
| 17:36:16.660Z | 472714 | 1615120 | 482 | 10370 | 4 | 2.247 / 3.612 / 3.886 | `5a48be15` | false |
| 17:44:49.609Z | 509567 | 1738003 | 482 | 10370 | 4 | 3.405 / 4.565 / 4.399 | `5a48be15` | false |
| 17:53:59.397Z | 492893 | 1674287 | 482 | 10370 | 4 | 3.370 / 6.020 / 5.546 | `5a48be15` | false |

### Reportes no comparables

Cuatro reportes de hooks se descartaron por regla, no se borraron; están en
`.navori/state/bench/non-comparable/`:

| Reporte | SHA256 |
|---|---|
| `hooks-2026-10-26T17-30-35-366Z.json` | `a90c1147fdd4811ff60d3e1a400adb055bf35044e1ab5bffac3ce52b3e88c2cb` |
| `hooks-2026-10-26T17-30-39-948Z.json` | `fdd6327d1e9cec1b88e8d0a3b8476226f33a6d5da1d2efd2677cde633428347b` |
| `hooks-2026-10-26T17-32-25-874Z.json` | `cdec44e60558ce49f338cc23453817e7343a763936480b04493bf5c21a04981c` |
| `hooks-2026-10-26T17-32-30-860Z.json` | `8364b0aab307441b487002b8f362cf375facf9ea918a3505490aff101f2473ed` |

### Reacreditación del presupuesto

La cohorte del 2026-10-18 no es reproducible (hashes conservados en `tasks.md`). El presupuesto nuevo
sale de `--propose` sobre las tres corridas en reposo de arriba (adopción aprobada por el usuario el
2026-10-26): excepciones 47 -> 26. La versión anterior (`c74f50a6`) excedía
`guard-catalog-parity` (22302 ms > 20000 ms) en 1 de 3 corridas.

## Pendientes conservados

#1354 continúa abierto. Falta medir los tres hooks suplementarios en tres observaciones por lado,
con carga inicial ≤4 y bindings de fuente/observador; reacreditar cohortes y aceptaciones después
de cambios de fuentes y completar T39/A11. La pared y el archivo más lento por shard de la CI final
de #1352 quedan documentados aquí; no se trasladan a una fuente posterior. M5/R12 sigue
diferido y Node permanece en el carril de fallos: no se ejecutó un oráculo de eliminación. Los
checkpoints históricos de la spec conservan su fecha y sus límites.
