# Inventario de lo que queda en TS, shell y Node después de 0.13

Hecho por S1 el 20 nov 2026 sobre `migration/rust` `f40cbe7e`. Es solo lectura: no hay código. Responde a la pregunta de Ulises: qué más se podría migrar a Rust.

Revisión 2 (20 nov): incluye las correcciones de la revisión de S3 (`coordinacion/rust-0.13/revisiones/inventario-post-013`) y las decisiones de Ulises (`decisiones-ulises/2026-11-20-post-013-orden`).

Revisión 3 (23 nov): agrega lo que queda fuera de 0.13 (sección "Fuera de 0.13"), según `decisiones-ulises/2026-11-23-0910` y `decisiones-ulises/2026-11-23-0925`.

Fuentes:
- `scripts/js/rust-areas.mjs` (`AREAS`, `PERMANENT_DELEGATION`, `PERMANENT_SHELL_HOOKS`);
- `scripts/js/cutover-check.mjs`;
- `crates/ported.json`;
- los hooks renderizados (`.claude/settings.json`, `.claude/hooks/`, `.pi/navori/hooks/`, `.pi/navori.json`);
- `crates/navori-cli/src` (`delegate.rs`, `hook.rs`, `journal.rs` y los `*_hook.rs`).

Mediciones en `~/.cache/navori-rust/s1/guard-lat/` (ventana del 20 nov, 12:36-12:42; ventana sucia, con carga de 9 a 17).

## Supuesto

En `f40cbe7e`, los 12 hooks de `ported.json` están en `shadow`: el script de bash decide y el nativo observa. La activación, según la decisión de Ulises del 20 nov:
- **26 nov**: los lotes con hooks de los dos engines.
  - B: quality-gate-pre-commit, subagent-no-background, implementer-no-markdown.
  - D: comment-draft-confirm, pr-publisher-confirm.
  - guard-destructive, como grupo propio.
- **0.13.1**: los hooks que solo corren en Claude.
  - Lote C: plan-gate, general-purpose-confirm, session-start-context, model-advisor, pii-egress-guard.
  - `subagent-stop-handoff`, según el punto 8 (#350).
  - El lote A queda obsoleto.

Un hook deja la sombra solo cuando se activa **y** se hace `render --apply`: el render es el que emite `--shadow` en la envoltura (`native-hook.ts:107`), y `hook.rs:427` lo respeta mientras el `settings.json` renderizado lo traiga.

## Tabla

Columnas:
- **Caliente**: corre en cada llamada a una herramienta.
- **Arranca**: los procesos que lanza cada vez que corre.
- **Costo**: lo que costaría portarlo. S es menos de 1 día, M de 1 a 3 días y L más.

| Área | Qué es | Caliente | Arranca hoy | Costo | Recomendación |
|---|---|---|---|---|---|
| Envoltura de los 12 hooks portados (Claude) | `settings.json` lleva el bloque `native-runtime` en línea: una shell, un `$(…)` y `navori-rust`. Si sale con 3, 126 o 127, cae a `bash "$f"`. | Sí (PreToolUse Bash, Edit, Write y Agent) | sh/bash + subshell + `navori-rust` | S | **Dejar** en 0.13. Para 0.13.1, evaluar el comando directo al binario (pregunta a). |
| Envoltura de los 6 hooks portados (Pi) | El bridge corre `bash .pi/navori/hooks/<hook>.sh`, que tiene el bloque con `--via-script`. | Sí (cada llamada de Pi) | bash (lee el `.sh` renderizado, de 898 a 3.525 líneas) + subshell + `navori-rust` | M (el bridge tiene que llamar al binario y conservar el respaldo) | **Portar en 0.13.1** (decidido): el bridge llama a `navori-rust hook` directo y cae a bash ante exit 3, 126 o 127, junto con `wip/pi-bridge-siblings-complete`. |
| Journal de sombra (`journal.rs` 270, `shadow.rs` 340 → `tools rust-shadow begin/complete`; `packages/cli/src/lib/rust-shadow/`, 505 líneas sin tests y 1.293 con tests) | Registro de la ventana R81 y mecanismo con el que entran los portes nuevos y las re-firmas (modo `shadow` de `ported.json`, `hook.rs:427,468-515`). | Sí, pero solo en sombra | **2 × Node** por llamada (begin y complete), más el carril de bash en sombra (`shadow.rs:250`) | M (lista de archivos en la pregunta c) | **Borrar en 0.14**, sin modo de depuración (decidido), después de activar el lote C (0.13.1) y después de portar y activar `routing-watch` y `bash-outcome-watch` con su propia ventana de sombra. |
| `routing-watch` + partial `bash-outcome.sh` (444 + 494 líneas) | Avisos de ruteo y evidencia de bash. | **Sí, el único hook en shell que corre en cada llamada**: PostToolUse Bash, Edit, Write, NotebookEdit, Agent y Task (Claude) y `tool_result` en el padre de Pi | Siempre: `git rev-parse` y `jq`. A veces: `node -e`, al registrar la evidencia de bash de un plan (`bash-outcome.sh:122-126`, `:284-288`), al armar un aviso (`routing-watch.sh:240`) o en Codex (`:324`). Con auditoría: `navori audit --record-metadata`. Estimado en `rust-areas.mjs:162`: unos 76 ms. | L (paridad byte a byte con `lib/plan/evidence.ts`; `plan_evidence_parity.rs` ya cubre una parte) | **Portar** (0.14, #1701): es el único hook caliente que todavía lanza Node en uso normal. |
| `bash-outcome-watch` (25 líneas + el mismo partial) | Evidencia de un Bash que falló. | **No**: solo PostToolUseFailure con matcher Bash (Claude). En Pi no tiene binding (`.pi/navori.json` solo enlaza `managed-drift-watch` y `routing-watch` en `tool_result`). | `node -e` para el aviso (`:23`) + el partial | S, sale con el de routing-watch | **Portar** junto con routing-watch (comparten el partial y su paridad). |
| `managed-drift-watch` (334 líneas) | Aviso de deriva de bloques gestionados. | Sí (PostToolUse Bash, Edit, Write y NotebookEdit; `tool_result` de Pi) | `git rev-parse` + `shasum`/`sha1sum` sobre los archivos gestionados (de 15 a 35 ms) | M (el hash de bloque ya es nativo en navori-core; zona crítica) | **Dejar** (decidido): solo se porta con un motivo concreto. Sigue en `PERMANENT_SHELL_HOOKS`. |
| `audit-mode-trigger` (108 líneas) | Arma la auditoría. | En cada prompt (UserPromptSubmit) | `jq` + `navori audit --start` (**TS**) solo si se arma | S para el hook, M para `audit` | **Dejar** (congelado en dev). Portar `audit` primero, si se porta. |
| `audit-mode-close` (57), `worktree-reclaim` (281) | Cierre de sesión. | No (SessionEnd) | `jq`; `git` + `gh pr list` | — | **Dejar** (fuera del camino caliente; worktree-reclaim borra worktrees, mucho riesgo para poca ganancia). |
| `stop-verify-reminder`, `master-*`, `role-guard`, `engram-write-guard` | Detrás de un flag, master o Codex. | No (no se renderizan en este repo) | `jq`/`node`/`sed`, `git`, `navori master status` | — | **Dejar** (permanentes, por #1503). |
| Analizadores dentro de hooks portados | `implementer-no-markdown` (`node -e` o `python3 -I -S -c`, `implementer_no_markdown_hook.rs:98-107`); `pr-publisher-confirm` (`node -e`, `publish_confirm_hook.rs:98`). | Raro: solo en la excepción Node/JSON o Python de escritura y en la aprobación de Codex | Node o Python | M | **Dejar**: son la paridad con el script y no corren en uso normal. |
| `model-advisor` | Exige `node` en PATH (`model_advisor.rs:143`), pero no lo lanza. | No (SessionStart y Stop) | nada | S | **Dejar**. Opcional: quitar la exigencia cuando el script deje de depender de node. |
| Ayudantes del CLI en hooks activos | `quality-gate` → `navori gate foreign` (siempre lanza un proceso, `quality_gate.rs:230`); `session-start` → `navori audit --consume-arm` (`session_start.rs:~262`) y, en Codex resume, `navori plan resume --json` (`session_start.rs:186`); auditoría → `navori audit --record-metadata` (`navori-core/src/audit.rs:471`); `plan-gate` delega a TS con auditoría armada, ante un fallo de lectura o con un `report()` vacío (`plan_gate.rs:27,36,49`). | gate: solo en `git commit`; audit: solo con auditoría armada; resume: una vez por sesión | **Node** si el `navori` del PATH es el CLI TS (`gate foreign` ya es nativo con `navori` = `navori-rust`) | M (`audit`) | `gate foreign` portado en 0.13 (#1775). **Portar** los 3 modos de `audit` usados por hooks. |
| Sonda `navori --version` (`hook_facts.rs:270-326`) | Detecta qué `navori` hay en el PATH, para decidir si los ayudantes corren en proceso (`hook_facts.rs:254-256`). La llaman `quality_gate.rs:144`, `session_start.rs:114` y `plan_gate_hook.rs:90`. | No por llamada: queda en caché por binario y `node` en `.navori/state/rust-facts` del proyecto (`facts_cache.rs`) y se repite tras cada actualización o sin caché usable | **Node** (~120 ms en frío, `hook_facts.rs:231`) si el `navori` del PATH es el CLI TS | — | Depende del punto 2 de post-013-orden (S2 verifica el launcher de npm). Con `navori` = `navori-rust`, cuesta lo que un `navori-rust --version`. |
| Extracción sin `jq` | `comment-draft-confirm` usa `node -e` si no hay `jq` (`navori-hooks/src/shell/draft_body.rs:298-303`). `subagent-stop-handoff` e `implementer-no-markdown` consultan `host.on_path("node")` para elegir el perfil, como el script. | Solo en hosts sin `jq` | Node | S | **Dejar** (paridad con el script, que hace la misma cascada jq → node). |
| Comandos sin portar ni delegación permanente | `init`, `add`, `configure`, `update`, `refresh`, `audit`, `receipt`, `gate` (salvo `probe` y `foreign`), `tools` (salvo `notice`, `session-context` y `rust-shadow`), `bench` | No (a mano) | `node <legacy/dist>` vía `delegate.rs` | L (prompts de clack; `clack.rs` ya existe) | **Portar por demanda** (son el área E2/E3). `cutover:check` los marca. |
| Delegación permanente | `master`, `codex`, `workspace`, `ticket`, `registry`, `doctor --json`, `backup|migrations restore` sin `--yes` | No | Node | — | **Dejar** (decisión de #1503 y procedencia de `doctor --json`). |
| TS de los comandos ya portados | `commands/{render,sync,doctor,plan,…}.ts` (unas 11.900 líneas) + `lib/{plan,render,handoff,spec}` (unas 12.000) | No | — | — | **Dejar** en 0.13: es el TS congelado al que el binario delega las formas que todavía no modela (`render.rs:86,163`, `sync.rs:39`, `plan.rs:1156`) y el oráculo de paridad. |
| `.sh` fuente de los 12 hooks portados | `core-assets/hooks` (4.633 líneas + 18 partials, 3.195), renderizados en `.claude/hooks` (13.853) y `.pi/navori/hooks` (9.569) | — | — | — | **Dejar**: son el respaldo (exit 3 y `NAVORI_HOOK_IMPL=shell`), la entrada de integridad del nativo y la ruta para instalaciones sin binario. |

## Pregunta (a): hooks que lanzan un `.sh` que después llama a `navori-rust`, y cuánto ahorraría llamar al binario directo

- **Claude**: ninguno lanza el `.sh` en el camino normal. `settings.json` lleva el bloque en línea (`--via-command`) y solo hace `exec bash "$f"` si el nativo sale con 3, 126 o 127. Lo que queda es la shell con la que Claude corre el comando, más un `$(…)`.
- **Pi**: sí, los 6 hooks portados que se cablean en Pi (`guard-destructive`, `quality-gate-pre-commit`, `pr-publisher-confirm`, `comment-draft-confirm`, `subagent-no-background` e `implementer-no-markdown`). El bridge corre `bash <script>.sh` y el bloque del script llama a `navori-rust hook --via-script "$0"`.
- **Medido** (`bash-start.txt`, 400 corridas intercaladas, carga 13; los p50 son representativos, los p95 están inflados por la carga):

  | Forma | p50 | p95 |
  |---|---|---|
  | `navori-rust --version` directo | 1,99 ms | 6,31 ms |
  | `bash -c 'navori-rust --version'` | 3,46 ms | 9,56 ms |
  | `bash -c :` | 2,06 ms | 5,75 ms |
  | `sh -c :` (dash) | 1,48 ms | 4,75 ms |

  La envoltura de shell suma **unos 1,5 ms de p50 por hook**. En Pi, además, bash lee un `.sh` de 898 a 3.525 líneas antes del bloque. En una llamada de Pi corren en paralelo los hooks de `tool_call` (4 en el padre y 6 en un hijo), así que el costo es CPU, no latencia en serie. Además, en Pi corren:
  - `managed-drift-watch` y `routing-watch` en `tool_result`;
  - `worktree-reclaim` y `audit-mode-close` al cerrar la sesión (`session_shutdown`).
- Llamar al binario directo pierde el respaldo a bash (sin `navori-rust` o con exit 3). Para conservarlo, el bridge o el comando tienen que reintentar con bash ante 3, 126 o 127. **Decidido**: en Pi sí, en 0.13.1, en el bridge, junto con `wip/pi-bridge-siblings-complete`. En Claude, el ahorro es la shell de Claude, que no se puede quitar: el campo `command` siempre pasa por una shell. Solo se gana el `$(…)`, unos 0,5 ms. No vale el cambio.

## Pregunta (b): ¿algún hook arranca Node en uso normal?

- **En sombra: sí.** Cada hook portado en sombra lanza **2 × Node** por llamada para el journal (`journal.rs:130-170`: `tools rust-shadow begin/complete`) y además corre el carril de bash.
  - Para B, D y el guard, esto desaparece el 26 nov.
  - Para C y subagent-stop-handoff, en 0.13.1.
  - En los dos casos, al activar **y** hacer `render --apply` (`native-hook.ts:107`, `hook.rs:427`).
- **Activos: no, en el caso normal.** Lo que queda:
  - `routing-watch` (shell puro, no portado) corre en cada PostToolUse (Claude) y en cada `tool_result` del padre de Pi. Siempre lanza `git` y `jq`. Lanza `node -e` cuando registra la evidencia de bash de un plan con trabajo en curso (`bash-outcome.sh:122-126`, `:284-288`), cuando arma un aviso (`routing-watch.sh:240`) o en Codex (`bash-outcome.sh:324`). Es el **único Node en el camino caliente**, y aparece justo en las sesiones con plan activo.
  - `bash-outcome-watch`: solo cuando falla un Bash en Claude (`node -e` para el aviso). En Pi no está conectado.
  - La sonda `navori --version` (`hook_facts.rs:270-326`): una vez por binario y `node`, en caché. Es Node (~120 ms en frío) si el `navori` del PATH es el CLI TS. No se quita (decisión de Ulises del 22 nov): la versión decide el veredicto de `quality-gate-pre-commit` en sombra (probe en proceso o `navori gate probe`), y un atajo sin spawn no puede garantizar el mismo resultado que el CLI TS sin arrancar Node (Node < 22.12, `dist` roto). La caché ahora se invalida también al cambiar el `node` del PATH (ruta canónica y stamp).
  - `plan-gate` delega a TS con auditoría armada o ante un fallo de lectura (`plan_gate.rs:27,36,49`). En Codex resume, `session_start.rs:186` llama a `navori plan resume --json`.
  - `comment-draft-confirm` usa `node -e` en hosts sin `jq` (`draft_body.rs:298-303`).
  - Con la auditoría armada: `navori audit --record-metadata` (TS) en cada evento auditado.
  - `quality-gate-pre-commit` en `git commit`: `navori gate foreign` (TS solo si el `navori` del PATH es el CLI TS; nativo desde 0.13).
  - `session-start-context`: `navori audit --consume-arm` (TS) una vez por sesión.
  - Analizadores `node -e`/`python3` de `implementer-no-markdown` y `pr-publisher-confirm` en sus casos raros.
  - Si el `navori` del PATH no es `navori-rust` de la misma versión, los ayudantes en proceso (`gate probe`, `plan gate`, `tools session-context`) lanzan `navori` en vez de correr dentro del proceso (`hook_facts.rs:254-256`).

## Pregunta (c): TS duplicado de lo portado que se podría borrar después del release

| Pieza | Líneas | ¿Se puede borrar? |
|---|---|---|
| `lib/rust-shadow/` + `tools rust-shadow` (journal de sombra, TS) y `journal.rs` (270) / `shadow.rs` (340) (Rust) | 505 TS sin tests (1.293 con tests) + 610 Rust | **Sí**, en 0.14 (decidido: sin modo de depuración), después de activar el lote C y después de portar y activar `routing-watch` y `bash-outcome-watch` en sombra. El borrado también toca `hook.rs` (`use_shadow`, `Comparison`), el modo de `native-hook.ts`, `cutover-check.mjs:26,108`, `cli-surface.golden.json:259`, `tools.ts:6,145`, `crates/navori-cli/tests/{hooks,shadow,shadow_deadline}.rs`, `hook-shadow-report.mjs:4-5` y `CONTRIBUTING.md:119-129`. |
| Herramientas de cierre (`hook-shadow-report.mjs`, `bench-hooks --impl shell`) | unas 1.500 | Sí, cuando ya no haya hooks en sombra (o dejarlas para el próximo port). |
| `commands/*.ts` y `lib/*` de los comandos portados | unas 24.000 | **No** en 0.13.x: el binario delega en ellos las formas que no modela y son el oráculo de paridad. Se borran por comando cuando desaparezca la última rama `None` → delegar. |
| `.sh` de los 12 hooks y sus partials | 4.633 + 3.195 (fuente) | **No**: son el respaldo y la entrada de integridad. Borrarlos exige otro modelo (implementación embebida en el binario) y una historia para instalar sin binario. |

## Orden recomendado (después de 0.13)

Decidido por Ulises (`decisiones-ulises/2026-11-20-post-013-orden`):

1. **26 nov**: activar B, D y el guard (con `render --apply`).
2. **0.13.1**:
   - bridge de Pi directo al binario, con caída a bash, junto con `wip/pi-bridge-siblings-complete`;
   - re-firma de latencia del guard (`wip/rust-guard-latencia`, re-medida en una ventana limpia);
   - activación del lote C;
   - `subagent-stop-handoff`, según el punto 8 (#350).
   - **La sombra se mantiene hasta acá.**
3. **0.14**, en este orden:
   1. port de `routing-watch` + `bash-outcome-watch` (L, #1701), que entra en sombra con su propia ventana de observación;
   2. activación de los dos con la evidencia de esa ventana;
   3. **recién después**, borrar el journal de sombra (TS y Rust) y sus herramientas;
   4. `audit` (M); `gate foreign` ya se portó en 0.13.
4. **`managed-drift-watch`**: solo con un motivo concreto.
5. **Lo demás** (`init`, `add`, `configure`, `update`, `refresh`, `receipt`): por demanda.

**Nota sobre la sombra y 0.14** (de la revisión de S3; decidido por Ulises el 20 nov): el modo `shadow` es como entran los portes nuevos con ventana de observación. Por eso `routing-watch` y `bash-outcome-watch` se portan y se activan ANTES de borrar el journal; el borrado va después de su activación.

## Fuera de 0.13

Decidido por Ulises el 23 nov (`decisiones-ulises/2026-11-23-0910`). Reemplaza, para estos puntos, lo que `decisiones-ulises/2026-11-20-todo-en-013` había metido en 0.13.

- **Arranques de Node en `plan-gate` y `session-start-context` activos (PR B): descartado.** El ahorro es de 0 a unos 30 ms y solo en ramas raras:
  - con `navori` = binario (postinstall), los spawns que quedan ya no arrancan Node;
  - con el lanzador JS (sin postinstall) cuestan ~30 ms, pero solo cuando falla el frame de `tools session-context` y además el subproceso (`tools notice`, `dominio inject`, `--ack`), con el memo de CLI viejo, o en Codex resume (`plan resume`);
  - en `plan-gate` solo quedan las ramas `Delegate` (auditoría armada, workplan que no se lee, escalación).

  No compensa tocar un área crítica con el plazo del 26 nov. El Node residual queda como está en la pregunta (b). El PR A (la sonda `navori --version`) también se descartó el 22 nov; solo entra el arreglo de su caché (#1778).
- **Lo que sí importa para 0.13:** que `navori --version` del binario (versión de Cargo) coincida con `STAMP_VERSION` (`packages/cli/package.json`). Si difieren, `plan gate`, `tools session-context` y `gate probe` nunca corren en proceso. No se toca ninguna versión antes de la instalación del 26 nov: hoy coinciden la CLI TS 0.12.5 del PATH y `STAMP_VERSION`, así que en la sombra el camino en proceso corre. En el release las dos suben juntas a 0.13.0 y `check-pin` lo verifica al publicar (S2) (`decisiones-ulises/2026-11-23-0925`).
- **`routing-watch` y `bash-outcome-watch`: fuera de 0.13** (no llegan al 26 nov). Siguen en shell, sin port ni sombra, con el orden de 0.14 de arriba. Antes de decidir su port se mide el costo de `routing-watch` por sesión.

## Preguntas abiertas

- El `navori` del PATH después de 0.13: Ulises eligió la opción A (decisiones-ulises/2026-11-20-1645): el paquete expone el bin `navori-rust` nativo con postinstall; sin postinstall queda un script de Node y `doctor` avisa del costo. Sigue abierta solo la verificación de S2 sobre `navori`: si es el CLI TS, la sonda `navori --version` y los ayudantes en proceso de los hooks lanzan Node.
- El punto 8 (#350), que define cuándo entra `subagent-stop-handoff`.
- Repetir las mediciones de arranque en una ventana limpia antes del PR del bridge.

Cerradas: la sombra no queda como modo de depuración; en 0.14 se borra después de portar y activar `routing-watch` y `bash-outcome-watch`; el bridge de Pi va directo en 0.13.1.
