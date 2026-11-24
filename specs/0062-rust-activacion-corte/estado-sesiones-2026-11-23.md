# Estado de S1, S2 y S3 al cierre del 23 nov 2026

Cierre ordenado por Ulises el 23 nov (~18:10 CST) para seguir desde otra PC. Este documento junta lo que estaba repartido entre la memoria de engram (punteros `coordinacion/rust-0.13/sesion-1`, `-2` y `-3`) y los archivos locales de `.navori/state/handoffs/`, que git ignora y no viajan.

Las copias de esos archivos locales están en [`handoffs-2026-11-23/`](handoffs-2026-11-23/). Son una foto del 23 nov: rutas de `~/.cache/navori-rust/` y nombres de worktrees se refieren a la PC Linux.

## Puntas y fechas

| Qué | Valor |
|---|---|
| `migration/rust` | `f1e198df` (#1804) |
| `dev` | `94fc634a` (#1792) |
| Checkout de la sombra | `~/Documentos/dev/personal/navori-rust`, rama `ulises/rust-sombra` en `9afccdef`. Solo lectura: nada de `cargo test` ni builds ahí (caso #1774) |
| Binario instalado | `~/.cargo/bin/navori-rust`, sha `a510785e989d9662`, del 19 nov |
| Ventana R81 actual | 19 nov 16:16:08 → 26 nov 16:16; la última fila cierra el 26 a las 17:15 CST |
| Plazo de #1801 | miércoles 25 nov, 12:00 (revisado, en verde y con recibo; si no, queda como limitación conocida) |
| Instalación | jueves 26 nov. La hora la decide Ulises; S3 recomienda después de las 17:16 (runbook, sección 0) |
| Activación de lotes | al cerrar la ventana R81 nueva, ~3 dic |

## Reglas vigentes (resumen)

- `decisiones-ulises/2026-11-23-autonomia-merge`: cada sesión crea y mergea sus PRs a `migration/rust` o `dev` con CI verde, revisión por subagente, segunda revisión de otra sesión si toca un área crítica y recibo. Nunca `main`, npm, tags, releases ni reinstalar `navori-rust`. Un reintento si un hook bloquea por timeout.
- `decisiones-ulises/2026-11-23-1640`: los PRs del grupo de re-firmas 2 se mergean al estar listos hasta el jueves 26 a las 12:00. Nadie reinstala antes. Nada que re-firme después.
- La medición R81 (`hook-shadow-report.mjs`, `causes.json`, umbrales, journal) no cambia antes del 26.
- Antes de algo pesado: sin carga ajena (`uptime` < 4; jey usa otro candado, `~/.jey-heavy.lock`). Carga pesada bajo `systemd-run --user --scope -p MemoryMax=8G -- flock /tmp/navori-heavy.lock`.

## PRs abiertos

| PR | Sesión | Base | Estado | Qué falta |
|---|---|---|---|---|
| #1803 | S2 | `migration/rust` | borrador | bump 0.13.0: build, `render --apply`, goldens, oráculo con avisos y gate full; fecha y titular de releases los decide Ulises. No se mergea hasta que cierre la ventana |
| #1805 | S3 | `migration/rust` | listo | recorte de 400 caracteres de los bloques de arranque (#1779, opción a). Lo mergea Ulises; gate local pendiente por carga ajena |
| #1806 | S2 | `migration/rust` | borrador | lista de delegación transitoria (T10, PR 1). Gate full y revisiones. No se mergea antes de ~3 dic |
| #1807 | S2 | `migration/rust` | borrador | borrador del release 0.13.0 (`release-0.13-borrador.md`). Documento, no se mergea tal cual |
| #1808 | S2 | `migration/rust` | borrador | Plan B de Q24 (paquetes sin scope). Solo si Ulises lo elige |
| #1809–#1812 | S1 | `migration/rust` | borrador, con conflictos | activación de los lotes guard, B, C y D. Rehacer sobre la punta antes de ~3 dic |
| #1813 | S1 | `migration/rust` | borrador | parche de medición de `hook-fuzz` para reproducir la divergencia. No se mergea |
| #1814 | — | `dev` | borrador | #1623, reloj virtual en `native-integration.test.ts`. Rama del 9 nov sin subir hasta hoy |

`wip/release-0.13-bump-e1` no tiene PR: #1803 ya la incluye.

## S1

**Hecho el 23 nov.** Mergeados #1778, #1787, #1795, #1796 y #1802; #1800 (guard en fallo cerrado con git inutilizable, re-firma los 12 hooks) entró en `f9331066`. Segunda revisión de #1790 (APPROVED). Issues #1793, #1794 y #1801. Verificación de #1772: replay de los 12 hooks idéntico (2.491 casos) en `fe7996f8` y `90f0ac5f`. Repo privado de sincronización de engram creado.

**Pendientes, en orden.**
1. Reproducir la divergencia del fuzz del guard (caso 1216, semilla 1) con carga controlada, máximo 1 h. Herramienta en #1813. Si el arreglo re-firma, antes del jueves 12:00.
2. #1801: workplan `guard-git-forms` aprobado ([copia](handoffs-2026-11-23/workplan_guard-git-forms.md)); base `migration/rust`; implementer con commits por fase; plazo miércoles 25 a las 12:00; avisar a Ulises el miércoles por la mañana.
3. #1793: workplan `routing-watch-write-probe` aprobado ([copia](handoffs-2026-11-23/workplan_routing-watch-write-probe.md)). Área crítica (hooks): implementer y reviewer.
4. Terminar la verificación de #1772: fuzz de 100.000 casos del guard y R17.
5. El jueves 26: anunciar el SHA final en la lista del grupo (#1527, `issuecomment-7066266095`; S1 es la única dueña).

**Solo en la PC Linux.** Worktrees `s1-inv-23` y `s1-guard-git` (el parche de `hook-fuzz.mjs` ya está en #1813), `s1-docs` y `s1-sin-node`; binarios en `~/.cache/navori-rust/target-s1-{inv23,guardgit}`; datos en `~/.cache/navori-rust/s1/{routing-watch-cost,v1772,guard-git,div}`.

## S2

**Hecho el 23 nov.** Mergeados #1780 (oráculo y `cutover-check` leen `requires`), #1788 (`check-pin` compara Cargo con `packages/cli`) y #1799 (paso e.2: `dist-probe` distingue el binario del legacy). #1791 (`audit --arm/--disarm` nativos) lo mergeó Ulises. Segundas revisiones de #1778 y #1800 (APPROVED). #1803 abierto como borrador del bump, con e.1 incluido. Decisión `t10-alcance` (opción A) implementada en #1806: `cutover:check` pasa de 73 bloqueantes a 9, con 64 transitorios.

**Pendientes, en orden.**
1. #1803 después de la ventana: build, `render --apply`, goldens (cli-surface, snaps, oráculo `doctor.json`, removable-native-signature, og), oráculo con los avisos encendidos y gate full.
2. #1806: gate full, revisión por subagente y segunda revisión. Sin merge antes de ~3 dic.
3. Segunda revisión de #1801 cuando S1 abra el PR.
4. Si la segunda revisión de #1791 (S3: APPROVED con 2 MEDIO, `issuecomment-7117340769`) pide cambios: PR de seguimiento antes del 26.
5. Después del 26 (aprobado): PR chico para que la CI corra `native_arm_is_consumed_by_the_ts_and_starts_the_session`.
6. T10 (PR único `migration/rust` → `dev`, borra `packages/cli/src`): espera la decisión de Ulises.

**Solo en la PC Linux.** Worktrees `s2-bump-e1` (#1803), `s2-transitoria` (#1806), `rust-enabled-plugins` (#1807) y `rust-cp-seguimiento` (#1808), todos limpios y empujados; `~/.cache/s2-env.sh` y los scripts `~/.cache/s2-*.sh`; archivo de handoffs en `~/.cache/navori-rust/s2/archive/`.

## S3

**Hecho el 23 nov.** Spec 0065 (#1786) y su enmienda (#1792) mergeadas en `dev`; #1784 por Ulises. #1790, #1797 y #1798 mergeados. Issues #1783 y #1789. La prueba `pii_egress_guard.rs` corrida en el checkout de la sombra escribió 33 filas en el journal real de R81 el 21 nov: diagnóstico en #1774 y aislamiento en #1804 (mergeado). Segunda revisión de #1791: APPROVED con 2 MEDIO. #1800 no afecta la ventana R81 en curso (verificado: checkout y binario sin cambios, 940 filas con la implementación instalada). Runbook del 26 al día ([copia](handoffs-2026-11-23/corte-26-runbook.md)), con el paso previo de máquina sin carga ajena y la lista de comprobación de 10 minutos. Diseño de #1783 ([solución](handoffs-2026-11-23/solution_1783-aborto-hermanos.md) y [revisión](handoffs-2026-11-23/solution_review_1783-aborto-hermanos.md)). Workplans de la fase 1 de 0065 ([copia](handoffs-2026-11-23/workplan_0065-fase1.md)). #1805 abierto.

**Pendientes, en orden.**
1. La mañana del 26: lista de comprobación del runbook y `navori gate full` sobre la punta, sin carga ajena (S3 lo corre).
2. Tabla de cierre de la ventana R81 actual después de las 17:16 del 26, con la nota del lote C (33 filas de la prueba).
3. Vigilancia: `s3-shadow-watch`, `s3-vigila` y `s3-target-watch` (unidades de usuario en la PC Linux).
4. Autoría del `cargo test` del 21 nov: sin confirmar (S1 y S2 no respondieron); esa parte de #1774 sigue abierta.
5. #1783: opción 2 y después la 5, después del 26.
6. 0065: cada PR de la fase 1 se parte en a/b porque la spec pone el TS en `dev`. Clasificación: PR 1 nivel 2 (piso de contrato compartido), PR 2 nivel 1 (score 7), PR 3 nivel 2 (score 8 y piso PII). Ulises decide el orden; no se implementa antes de su aprobación.
7. Medir la pieza 5 de 0066 después de la instalación (runbook, sección 2).

**Solo en la PC Linux.** Worktrees `s3-ensayo-26` (ramas locales `s3/ensayo-26-v2`, `-v3`, `-v4` y `s3/ensayo-lotes-3dic`: merges de ensayo, sin valor propio), `s3-r81-close`, `s3-rev-1791` y los de PRs ya mergeados; herramientas de vigilancia y cierre en `~/.cache/navori-rust/s3/r81/` (`vigila.sh`, `hermanos.sh`, `r81-cierre.sh`, `target-watch.sh`); cola de publicación en `.navori/state/publish/` (ya publicada); respaldo `~/respaldos/wip-activacion-2026-11-23.bundle`.

## Seguimientos después de 0.13

- #1776: siguen abiertas la prueba del cierre en fallo de `inert` y `GIT_DENIED` global (`repo.rs`, firmado).
- #1774: prueba de contrato de que ninguna prueba corre un script del árbol con el carril nativo, y alerta de un `target/` nuevo en el checkout de la sombra.
- #1794: huella del árbol de 246 ms al correr un criterio.
- Divergencia del fuzz del guard bajo carga, si no se reproduce antes del 26.
