# Anexo: cambios de `dev` posteriores a la pausa que tocan lo portado

**Fecha:** 2026-11-03 · **Base comparada:** `migration/rust` en `08d3fc29f` (#1503) contra `dev` en
`502e30a41` (#1523). Solo registro: no sincroniza `migration/rust` con `dev` ni cambia código.

**Alcance.** PRs mergeados a `dev` desde #1478 que cambian algo ya portado o en `shadow` en Rust.
Quedan fuera los que no tocan nada portado: #1484 (inventario), #1486 (`check-deps-sync`, script del
repo), #1506 (sitio web) y #1523 (CI). #1517 (`navori_count_triggers` sin segundo argumento) sigue
abierto; si entra, toca `shell/gate_trigger.rs` y `shell/landing.rs` igual que #1490.

**Lectura de columnas.** "Rompe paridad" = un oráculo de `crates/navori-oracle-tests`, el hash de un
bloque o dependencia en `crates/ported.json`, o el ledger de sombra divergiría al sincronizar.
"Descartado" = la parte cae en delegación permanente al TS según #1503 (`master`, `audit`, `codex`,
`workspace`, `ticket`, `registry`, `bench` y sus hooks).

| PR           | Qué cambió en `dev`                                                                                                           | Archivo Rust afectado                                                                                                                                | ¿Rompe paridad de sombra?                                                                                | ¿Descartado por #1503?                                    |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| #1478        | Pi registra la evidencia de criterios ligados a entregas                                                                      | `navori-core/assets/pi/extension.ts.in`, `render/pi_extension.rs`                                                                                    | Sí: `pi_owned_parity` compara contra `extension-source.ts`                                               | No (Pi es motor del corte)                                |
| #1483        | `spec check` valida `spec.md` de una página                                                                                   | `navori-core/src/spec/`, `navori-cli/src/spec.rs`, `ported.json`                                                                                     | Sí: el Rust no reconoce `spec.md`; la superficie CLI difiere                                             | No (`spec` se conserva)                                   |
| #1487        | `orquestacion` y `planificacion` rutean por riesgo                                                                            | Ninguno de código: assets embebidos por `build.rs`                                                                                                   | No; cambia el render al reconstruir                                                                      | No                                                        |
| #1488        | Hook `pii-egress-guard` y parciales `pii-egress*` dentro de `guard-destructive`                                               | `hooks/guard_destructive/`, `render/harness_plan.rs`, `render/claude_settings.rs`, render de Pi                                                      | Sí: hash de `guard-destructive-base`; el shell bloquea y el Rust permite; falta registrar el hook        | Parcial: `audit/cli-event.ts` y el registro de Codex      |
| #1490        | Análisis lineal en `gate-trigger.sh`; registro de hooks en Pi                                                                 | `shell/gate_trigger.rs`, render de Pi                                                                                                                | Hash de los bloques que incluyen `gate-trigger.sh`; el veredicto no cambia                               | Parcial: `master-accept-confirm.sh`                       |
| #1499        | `cierre-sesion` sale del contexto de `SessionStart`                                                                           | `render/plan.rs:70`, `render/claude_md.rs:79`, `render/doc_budget.rs`, `navori-cli/src/session_start.rs`                                             | Sí: `block_plan_parity` y `session-start-context`                                                        | No                                                        |
| #1500        | El gate full se nombra por su runner en la doctrina                                                                           | Ninguno de código: assets embebidos                                                                                                                  | No                                                                                                       | No                                                        |
| #1501        | El post-check del reviewer compara contra el target de su revisión                                                            | `navori-core/src/handoff/review_check.rs`, `navori-cli/src/handoff.rs`                                                                               | Sí: `review_check_parity`                                                                                | No                                                        |
| #1502        | Lo que #1484 sacó del default queda detrás de flags                                                                           | `config.rs`, `render/harness_plan.rs:389` (`stop-verify-reminder` sin flag), `render/claude_settings.rs`, `render/native_hooks.rs`, `plan/roster.rs` | Sí: render de Claude y Pi, esquema de config                                                             | Parcial: `bench`, `codex` y el registro de hooks de Codex |
| #1504        | El despacho de Pi da al hijo la ruta exacta de su handoff                                                                     | `assets/pi/extension.ts.in`                                                                                                                          | Sí: `pi_owned_parity`                                                                                    | No                                                        |
| #1505        | Bloque `sdd` de una página y fila 3 de `planificacion`                                                                        | Ninguno de código: assets embebidos                                                                                                                  | No                                                                                                       | No                                                        |
| #1507        | Partes del plan maestro con `spec.md`                                                                                         | `navori-core/src/master/check_part.rs`, `master/status`                                                                                              | Sí: oráculos de `master`                                                                                 | **Sí** (`master` completo)                                |
| #1508        | `guard-search-routing.sh` en una sola pasada                                                                                  | `ported.json` (dep `scripts/guard-search-routing.sh`)                                                                                                | Hash de la dependencia; el veredicto no cambia                                                           | No                                                        |
| #1510, #1514 | El mapa de claves conocidas suma `qualityGate.affected`, `qualityGate.docs`, `models.codexProfiles` y `project.criticalPaths` | `config.rs` (`unknown_keys`, `QUALITY_GATE`)                                                                                                         | Sí: el Rust avisa de claves que el TS acepta                                                             | No                                                        |
| #1511, #1516 | `implementer`, `reviewer` y `publisher` toman `spec.md`; el publisher no agrega rutas ignoradas                               | Ninguno de código: assets embebidos                                                                                                                  | No                                                                                                       | No                                                        |
| #1515        | `copy-dest` sigue comillas y comandos dentro de `"$(...)"`                                                                    | `hooks/guard_destructive/copy_dest.rs`                                                                                                               | Sí: hash de `guard-destructive-base` y veredictos en sombra (`echo "$(cp a CLAUDE.md)"` pasa a bloquear) | No                                                        |
| #1518, #1521 | Pi distingue timeout y aborto del hijo; el stderr sale sin controles C1 ni bidi                                               | `assets/pi/extension.ts.in`                                                                                                                          | Sí: `pi_owned_parity`                                                                                    | No                                                        |
| #1522        | Los marcadores de navori no cuentan como palabras en los techos                                                               | `render/doc_budget.rs`                                                                                                                               | Sí: `doc_budget_parity`                                                                                  | No                                                        |

## Actualización del 2026-11-06: #1524 a #1580

**Base comparada:** `migration/rust` en `ea406231` (#1527) contra `dev` en `f3b6a13d` (#1580). Se revisó el
código Rust de la rama, sin build. Entran #1526, #1528 y #1529, que son posteriores a la tabla anterior.

**Sin efecto en Rust:**
- **Solo pruebas, scripts o CI del repo:** #1539, #1540 (`bench`, descartado), #1549, #1561, #1565 y #1580
  (`test-affected.mjs`).
- **Solo documentos:** #1545 y #1548.
- **Solo config de este repo:** #1538 y #1573.
- **Assets embebidos por `build.rs`:** #1526 (`spec-bootstrap`); prompts de agentes en #1550, #1555,
  #1558, #1563 y #1567. Cambian el render al reconstruir, no el código.
- **Superficie que sigue en TS:** #1572 (`gate-decision.ts` y el rechazo de `receipt sign`; el Rust solo
  porta `checkReceipt` de lectura en `diagnose/receipt.rs`, y los mensajes de `plan classify` con
  borrador no cambian) y #1574 (`receipt-ci.ts`).
- **Descartado por #1503:** #1553 (`audit.mode` en opt-in).

| PR | Qué cambió en `dev` | Archivo Rust afectado | ¿Rompe paridad de sombra? | ¿Descartado por #1503? |
| -- | -- | -- | -- | -- |
| #1528 | El carril de PII de `guard-destructive` revisa HTTPie sin esquema | `hooks/guard_destructive/` (no tiene carril de PII) | Sí: hash de `guard-destructive-base` y amplía la divergencia de #1488 (más comandos que el shell bloquea y el Rust permite) | Parcial, como en #1488 |
| #1529 | Los topes de `doc-budgets.ts` bajan a `ceil(medido × 1.05)` | `render/doc_budget.rs` | Sí: `doc_budget_parity` compara contra las tablas del TS | No |
| #1530 | `receipt` verifica la CI con `gate=ci`; nueva clave `qualityGate.ci` | `config.rs:441` (`QUALITY_GATE` solo conoce `fast`, `full`, `scoped` y `nativeHooks`) | Sí: el Rust avisa de `qualityGate.ci` como clave desconocida; `receipt` sigue en TS | No |
| #1531 | Pi escribe `AGENTS.md` y las skills sin depender de Codex | render de Pi (`render/`) | Sí: render de Pi y golden `agents-md` | No |
| #1532 | El publisher corre en la sesión padre de Pi (sale del roster de hijos) | `assets/pi/extension.ts.in`, render de `.pi/navori.json` y `plan/roster.rs` | Sí: `pi_owned_parity` y render de Pi | No |
| #1536 | La doctrina de `planTiers` y `scribeOwnsMarkdown` no se renderiza con los flags apagados | `render/harness_plan.rs`, render de Claude, Codex y Pi | Sí: `block_plan_parity` | No |
| #1546 | `quality-gate-pre-commit.sh` no bloquea fuera de un repo con bash 5.3 (`cd ""` pasa a `cd .`) | `hooks/quality_gate_pre_commit/` | Hash de `qg-pre-commit-base`. El shell deja de bloquear en ese caso; el Rust no usa `cd`, así que se espera que ya permitiera. Confirmar en la sombra | No |
| #1559 | `subagent-stop-handoff.sh` acepta `- Status:` (prefijo de lista) en el handoff `.md` | `hooks/subagent_stop_handoff/mod.rs:344` (`^\*{0,2}status`) | Sí: hash, y el Rust sigue marcando "sin línea 'Status:'" donde el shell acepta (hook no bloqueante: difiere el aviso) | No |
| #1569 | La regla 6d de `copy-dest` da su propio motivo cuando no puede leer las comillas | `hooks/guard_destructive/copy_dest.rs` | Hash de `guard-destructive-base`. El veredicto no cambia (exit 2); cambia el texto del motivo | No |
| #1577 | El plan gate deja pasar `nivel-0:` con un borrador de `plan classify`, y `classify --diff` lo trata como sin workplan | `plan/gate.rs:828` (niega si existe `workplan_<f>.json`), `navori-cli/src/plan.rs:807` (`classify_diff` valida el archivo) | Sí: veredicto distinto en el hook `plan-gate` en sombra (TS permite, Rust niega) y salida distinta de `classify --diff` | No |
| #1578 | Pi valida gate, handoff y evidencia en el worktree dueño de la feature | `assets/pi/extension.ts.in` | Sí: `pi_owned_parity` | No |

## Qué hacer al retomar

1. Sincronizar `dev` en `migration/rust` y recalcular los hashes de `ported.json`.
2. Portar, en este orden de riesgo: `guard-destructive` (#1488, #1515 y #1528, hook en sombra con
   veredictos distintos; #1569 solo cambia el motivo), `plan-gate` (#1577, veredicto distinto), el render
   bajo flags (#1502, #1499, #1536), `subagent-stop-handoff` (#1559), `spec check` (#1483), `review-check`
   (#1501), `doc_budget` (#1522, #1529), `unknown_keys` (#1510, #1514, #1530) y la plantilla y el render de Pi
   (#1478, #1504, #1518, #1521, #1531, #1532, #1578).
3. No portar #1507 ni las partes de `audit`, `codex`, `bench` y `master-accept-confirm` de #1488,
   #1490 y #1502: van por delegación permanente.
