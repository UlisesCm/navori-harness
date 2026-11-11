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

## Actualización del 2026-11-09: #1581 a #1631 (0.12.5)

**Base comparada:** `migration/rust` en `9a803ce6` (#1585) contra `dev` en `bab51106` (#1631, contenido de 0.12.5). Solo lectura: `git log --merges` y `git diff --stat` por PR, más el diff del TS o shell donde toca algo portado. Sin build.

**Sin efecto en Rust:**
- **Solo documentos o web:** #1581, #1594 (spec 0063), #1597, #1602 (spec 0064), #1614, #1616 y #1631.
- **Solo pruebas, scripts o CI del repo:** #1595, #1601 y #1603 (`ci.yml`, conflicto del sync), #1606 (`check-test-preservation.mjs`: los PRs de retiro del paso 4 que borren pruebas TS tendrán que declararlo), #1613 (`test-affected.mjs`, `receipt-ci.ts`) y #1626 (Node 26.13 en `ci.yml`; antes del sync `rust.yml` seguía en Node 24, y el sync lo pasa a `.nvmrc`).
- **Config de este repo o release:** #1586, #1591 y #1630.
- **Assets embebidos por `build.rs`:** #1588 (`orchestrator.md`), #1589 y #1605 (`reviewer.md`) y la parte de `publisher.md` de #1624. Cambian el render al reconstruir, no el código.
- **Plan maestro v2, solo TS (delegación permanente):** #1615, #1624 y #1627 (`lib/masterplan/`, `commands/master.ts`), y la parte de comando de #1620 y #1621.

| PR | Qué cambió en `dev` | Archivo Rust afectado | ¿Rompe paridad de sombra? | ¿Descartado? |
| -- | -- | -- | -- | -- |
| #1582 | En Pi, el reviewer tiene 30 min, como el implementer | `assets/pi/extension.ts.in:52` (`ROLE_TIMEOUT_MS.reviewer` 1200000 → 1800000) | Sí: `pi_owned_parity` | No |
| #1587 | `begin`, `seal` y `log-review` del reviewer no dependen del encargo; la extensión de Pi lo aplica | `assets/pi/extension.ts.in` | Sí: `pi_owned_parity` | No |
| #1596 | `guard-search-routing.sh`: un `grep -r` al inicio de una línea nueva pasa por el guard (#1509) | `ported.json` (dep `scripts/guard-search-routing.sh`), `hooks/guard_destructive/search.rs` | Sí: hash de la dependencia y veredicto distinto con salto de línea (zona S1) | No |
| #1599 | `harness.sessionState: false` apaga `progress/` por repo | `config.rs` (clave desconocida), render de Claude y Codex (archivos de `progress/`), `render/pi_owned.rs:509` (lista exacta de claves de `controls`), `extension.ts.in`, `session_start.rs` | Solo con la clave puesta: sin ella el TS renderiza igual byte a byte. Rust avisa la clave como desconocida y `pi_owned` rechaza el `controls` con `sessionState` | No |
| #1607 | La auditoría registra el fail-open de search routing como `fail-open`/`search-index-unavailable` | `ported.json` (hash de los bloques que incluyen `_partials/audit-log.sh` y de `tgrep-search-lane`), etiquetas en `guard_destructive/mod.rs` | Hash (lo corrige `rust:hooks-sync`); etiqueta D5 del paso 1a | Parcial: `audit/cli-event.ts` y `model.ts` |
| #1608 | Pi falla cerrado si la raíz y un worktree enlazado tienen estado de la misma feature | `assets/pi/extension.ts.in` | Sí: `pi_owned_parity` | No |
| #1609 | El prune conserva el texto del usuario; los encabezados de siembra pasan a `scaffold.ts` | Ninguno: `render --prune` no está en el manifiesto y el refactor de motores no cambia la salida | No se espera; confirmar en `render_engines` | No |
| #1617 | La doctrina del orquestador llega solo al hilo principal de Pi (archivo propio `pi-orchestrator`) | `render/pi_engine.rs`, `render/pi_owned.rs`, `extension.ts.in`, render de `AGENTS.md` | Sí: `pi_engine_parity`, `pi_owned_parity`, `render_engines` | No |
| #1618 | `AGENTS.md` por capas; lo exclusivo de Claude pasa a `claude-apendice.md` (`layers.ts`, `render-plan.ts`) | `render/block_plan.rs`, `render/plan.rs`, `render/claude_md.rs`, `render/prose.rs`, `render/codex_agents_md.rs`, `render/doc_budget.rs`, `render/plugins.rs` (`plugin.json` de acli y codegraph) | Sí: `block_plan_parity`, `claude_md_parity`, `render_engines`, `doc_budget_parity` | Parcial: la parte de Codex |
| #1619, #1622 | Presupuestos y goldens medidos sobre el `AGENTS.md` por capas | `render/doc_budget.rs` | Sí: `doc_budget_parity` | No |
| #1620, #1621, #1628 (hooks) | `master-accept-confirm.sh` dispara con triggers v2 y deja los v1; `master-plan-context.sh` ofrece la v2; corpus de `master-accept-confirm` reescrito | `hooks/master_accept_confirm/`, `hooks/master_plan_context/`, `ported.json` | Sí: hash y veredicto en sombra; el replay del corpus falla | **Sí**: el Rust se retira (paso 4a) |
| #1628 (spec) | Se elimina R22 de `spec check` (`master-delivery-unmapped`, `master-target-mismatch`) y la segunda lectura de config | `navori-cli/src/spec.rs:15-16,549-576`, `spec/check.rs:74-95,202-228` | Sí: el Rust sigue emitiendo R22 (casos `spec-deliveries:*` de `cases/spec.json`) y repite los avisos de config | **Sí**: la v2 reemplaza a la v1; el Rust de R22 se borra (paso 4a) |
| #1628 (plan) | Un workplan v1 con `source` falla `plan check` y el plan gate con "corre navori master migrate"; el índice de aceptación pierde el binding de entrega | `plan/check.rs:305` y `plan/acceptance_index.rs` (delegan con `source`) | No: el Rust delega al TS. Se puede simplificar después | No |
| #1629 | El índice de aceptación conserva los criterios en `cumplido`; `validateEvidence` diagnostica por criterio (`no-file`, `no-line`, `different-command`) con mensajes de comando literal; `bash-outcome.sh`; skill `plan-simple` | `plan/acceptance_index.rs`, `plan/evidence.rs`, `navori-cli/src/plan.rs` (`update`), `extension.ts.in` (una línea) | Sí: `plan_evidence_parity`, `plan_validate_evidence_parity`, casos de `cases/plan.json` y `pi_owned_parity` | No |

**Qué cambia en "Qué hacer al retomar":**
- Paso 2 suma #1629 (`acceptance_index.rs` y `evidence.rs`): el CLI nativo responde distinto que el TS en `plan update` y `plan check`. Va como 2c en la zona plan.
- Paso 3 suma #1582, #1587, #1599, #1608, #1617, #1618, #1619 y #1622 (render de Pi, `AGENTS.md` y presupuestos).
- Paso 4a absorbe #1620, #1621 y #1628: hooks de master y R22 se borran, no se portan.
## Estado tras el sync de `dev` (0.12.5) en `migration/rust`

**Sync:** rama `sync/rust-dev-20261109`, merge de `dev` en `bab51106` sobre `migration/rust` en `9a803ce6`.
Medido en la máquina local contra la base `9a803ce6`: `cargo test` 10 fallos que ya estaban en la base (jq
1.8.1 y locale del host) y `rust-oracle` 0 diferencias en 1273 casos.

**Resuelto en el sync:** los hashes de `ported.json` de todos los hooks que `dev` cambió (`rust:hooks-sync
--check` en 0), el render de los espejos de `.claude/` y `.pi/`, `coverage.json`, el golden de la superficie
del CLI, la poda de #1604 con la firma nativa (`removable.ts`), `pii-egress-guard` y `bench` en `rust-areas`,
los workflows de Rust con `.nvmrc` (#1626) y las cinco pruebas de Rust que leían el espejo `.codex/` que
`dev` borró. El corpus de `guard-destructive` es la unión (1233 casos, 6 de `pii-egress-guard`), y el shell
da los 1233 iguales.

**También entran con el sync, sin fila propia arriba:** #1512 (quita Codex de los motores de este repo,
318d5eff; obliga a adaptar las pruebas que leían `.codex/` y deja sin fixture las paridades `codex_*`) y
#1475 (`lib/master`, delegación permanente).

**Pendiente, por paso** (rojos conocidos del sync; ninguno se porta aquí):

| Paso | Qué falla | Origen en `dev` |
| -- | -- | -- |
| 1a | `guard_state`: `search_lane_*` y `pi_arm_*` (motivo de comillas ilegibles) | #1569 |
| 1b | `guard_destructive`: dos pruebas con 14 casos de `pii-egress`; replay nativo, los mismos 14 | #1488, #1528 |
| 2 (sin asignar) | `quality_gate_git` (9): el Rust se difiere con "the gate cd is missing" ante `cd "${…:-.}"` | #1546 |
| 2c | `plan-cmd:*` (16) y `plan_validate_evidence_parity` (2) | #1629 |
| 2 | `handoff:*` (4) y `review_check_parity` | #1587, #1605 |
| 3 | El render nativo delega al TS en todos los motores: `render_claude` (12), `render_engines` (4), las paridades de bloque, `CLAUDE.md`, settings, harness, owned paths, Pi, plugins, sub-bloques, `doc_budget` (2), `config_parity` (3), `render.rs`, `rust-tree` (2) y los casos de render del oráculo | #1599, #1617, #1618, #1619, #1622 |
| 3 | `gen-pi-extension-asset.mjs --check` aborta: el roster de Pi ya no tiene `publisher` | #1532, #1582, #1587, #1608 |
| 3 | `parser::root_help` y `surface:--help`: el Rust lista `bench`, que `dev` dejó tras un flag | #1502 |
| 3 (guarda) | guarda de Claude en render: quitarla exige G7a + G3 + 1c, y regresar retired-context a native: true | #1647 |
| 3 (Codex) | 12 paridades `codex_*`: Codex está congelado; decidir si se retiran | #1618 (parcial) |
| `spec` | `repo-specs:*`, `spec:*`, `spec-deliveries:*` y `surface:spec_--help` | #1483, #1628 |
| 4a | `master_hooks` (1) y el oráculo de `master`, que aborta en el setup `master close` (v1 de solo lectura) | #1620, #1621, #1628 |

**Tras el paso 4a:** el Rust de `master` (v1), sus hooks nativos y R22 de `spec check` salen del binario; `master`
queda en `PERMANENT_DELEGATION` como subárbol (`subtree: true`) y sus hooks siguen en shell (#1639). `spec check`
conserva una condición del R22 retirado: un repo cuyo config no declara `prTarget` ni `branchBase` sigue
delegando al TS (`crates/navori-cli/src/spec.rs`, en `load_spec`), para que la salida no cambie mientras el Rust no
entienda `spec.md`. Se quita en el PR de `spec.md` (#1483).

**Tras el PR de `spec.md` (#1483):** `spec check` y `spec classify` nativos leen el `spec.md` de una página
(`navori-core/src/spec/onepage.rs`) y el FIX de un `tasks.md` ausente propone `spec.md`, como el TS; la condición
de `prTarget`/`branchBase` sale de `spec.rs`. Salen del oráculo `repo-specs:*` (14) y `spec:*` (4). Un `spec.md`
que no es un archivo regular sigue delegando `spec check` al TS.

**Tras el paso 4c:** el Rust de `role-guard` y `engram-write-guard` sale del binario (host de Codex
`governance_hook.rs`, los dos hooks, `shell/role_case.rs` y `agent_governance.rs`), junto con sus entradas de
`ported.json`. Los dos hooks siguen en shell (`PERMANENT_SHELL_HOOKS`) y el render de Codex no cambia. Como el
hash `impl` cubre `shell/`, el resto de hooks se vuelve a firmar con `rust:hooks-sync`, sin cambio de comportamiento.

## Pendiente posterior a 0.13: locale de mensajes (opción 2)

Hoy (opción 1) un host cuyos diagnósticos de Bash salen traducidos se difiere al shell: la sonda de mensajes de
`prepare.rs` exige el texto inglés antes de leer stdin. Mejora para después de 0.13: que el nativo tome de esa misma
sonda el texto localizado (formato `línea N` y strerror de ENOENT, ENOTDIR y EACCES) y lo use en
`subagent_stop_handoff/mod.rs:307` y `:513` y en `quality_gate_pre_commit/mod.rs:371`, para evaluar esos hosts con
identidad byte a byte. Exige un catálogo por errno y un dialecto por locale que el corpus todavía no cubre.
