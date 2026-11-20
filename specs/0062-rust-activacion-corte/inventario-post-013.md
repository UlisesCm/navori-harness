# Inventario de lo que queda en TS, shell y Node después de 0.13

Hecho por S1 el 20 nov 2026 sobre `migration/rust` `f40cbe7e`. Es solo lectura: no hay código. Responde a la pregunta de Ulises: qué más se podría migrar a Rust.

Fuentes:
- `scripts/js/rust-areas.mjs` (`AREAS`, `PERMANENT_DELEGATION`, `PERMANENT_SHELL_HOOKS`);
- `scripts/js/cutover-check.mjs`;
- `crates/ported.json`;
- los hooks renderizados (`.claude/settings.json`, `.claude/hooks/`, `.pi/navori/hooks/`, `.pi/navori.json`);
- `crates/navori-cli/src` (`delegate.rs`, `hook.rs`, `journal.rs` y los `*_hook.rs`).

Mediciones en `~/.cache/navori-rust/s1/guard-lat/` (ventana del 20 nov, 12:36-12:42; ventana sucia, con carga de 9 a 17).

## Supuesto

En `f40cbe7e`, los 12 hooks de `ported.json` están en `shadow`: el script de bash decide y el nativo observa. "Después de 0.13" quiere decir después de activar los lotes A-D (10 hooks). `subagent-stop-handoff` sigue en sombra hasta el punto 8 (#350), y `pii-egress-guard` y `guard-destructive` van en su propio lote, que no está en A-D.

## Tabla

Columnas:
- **Caliente**: corre en cada llamada a una herramienta.
- **Arranca**: los procesos que lanza cada vez que corre.
- **Costo**: lo que costaría portarlo. S es menos de 1 día, M de 1 a 3 días y L más.

| Área | Qué es | Caliente | Arranca hoy | Costo | Recomendación |
|---|---|---|---|---|---|
| Envoltura de los 12 hooks portados (Claude) | `settings.json` lleva el bloque `native-runtime` en línea: una shell, un `$(…)` y `navori-rust`. Si sale con 3, 126 o 127, cae a `bash "$f"`. | Sí (PreToolUse Bash, Edit, Write y Agent) | sh/bash + subshell + `navori-rust` | S | **Dejar** en 0.13. Para 0.13.1, evaluar el comando directo al binario (pregunta a). |
| Envoltura de los 6 hooks portados (Pi) | El bridge corre `bash .pi/navori/hooks/<hook>.sh`, que tiene el bloque con `--via-script`. | Sí (cada llamada de Pi) | bash (lee el `.sh` renderizado, de 1.000 a 3.400 líneas) + subshell + `navori-rust` | M (el bridge tiene que llamar al binario y conservar el respaldo) | **Portar** en 0.13.1+: el bridge llama a `navori-rust hook` directo y solo cae a bash si sale con 3. |
| Journal de sombra (`journal.rs` → `tools rust-shadow begin/complete`, `packages/cli/src/lib/rust-shadow/`, 505 líneas) | Registro de la ventana R81. | Sí, pero solo en sombra | **2 × Node** por llamada (begin y complete), más el carril de bash en sombra (`shadow.rs:250`) | — | **Borrar** después del release, cuando los 12 estén activos y la evidencia de R81 archivada (o dejarlo como modo de depuración opt-in). |
| `routing-watch` + `bash-outcome-watch` + partial `bash-outcome.sh` (444 + 25 + 495 líneas) | Avisos de ruteo y evidencia de bash. | **Sí**: PostToolUse en cada Bash, Edit, Write y Agent (Claude), y `tool_result` en el padre de Pi | Siempre: `git rev-parse` y `jq`. A veces: `node -e`, al registrar la evidencia de bash de un plan (`bash-outcome.sh:122-126`, `:284-288`), al armar un aviso (`routing-watch.sh:240`) o en Codex (`:324`). Con auditoría: `navori audit --record-metadata`. Estimado en `rust-areas.mjs:162`: unos 76 ms. | L (paridad byte a byte con `lib/plan/evidence.ts`; `plan_evidence_parity.rs` ya cubre una parte) | **Portar**, primero en la lista: es el único hook caliente que todavía lanza Node en uso normal. Diferido explícitamente "después de 0.13" (#1701). |
| `managed-drift-watch` (334 líneas) | Aviso de deriva de bloques gestionados. | Sí (PostToolUse Bash, Edit y Write; `tool_result` de Pi) | `git rev-parse` + `shasum`/`sha1sum` sobre los archivos gestionados (de 15 a 35 ms) | M (el hash de bloque ya es nativo en navori-core; zona crítica) | **Portar** después de routing-watch, reutilizando el hash nativo. Hoy está en `PERMANENT_SHELL_HOOKS`: hay que reabrir esa decisión. |
| `audit-mode-trigger` (108 líneas) | Arma la auditoría. | En cada prompt (UserPromptSubmit) | `jq` + `navori audit --start` (**TS**) solo si se arma | S para el hook, M para `audit` | **Dejar** (congelado en dev). Portar `audit` primero, si se porta. |
| `audit-mode-close` (57), `worktree-reclaim` (281) | Cierre de sesión. | No (SessionEnd) | `jq`; `git` + `gh pr list` | — | **Dejar** (fuera del camino caliente; worktree-reclaim borra worktrees, mucho riesgo para poca ganancia). |
| `stop-verify-reminder`, `master-*`, `role-guard`, `engram-write-guard` | Detrás de un flag, master o Codex. | No (no se renderizan en este repo) | `jq`/`node`/`sed`, `git`, `navori master status` | — | **Dejar** (permanentes, por #1503). |
| Analizadores dentro de hooks portados | `implementer-no-markdown` (`node -e` o `python3 -I -S -c`, `implementer_no_markdown_hook.rs:98-107`); `pr-publisher-confirm` (`node -e`, `publish_confirm_hook.rs:98`). | Raro: solo en la excepción Node/JSON o Python de escritura y en la aprobación de Codex | Node o Python | M | **Dejar**: son la paridad con el script y no corren en uso normal. |
| `model-advisor` | Exige `node` en PATH (`model_advisor.rs:143`), pero no lo lanza. | No (SessionStart y Stop) | nada | S | **Dejar**. Opcional: quitar la exigencia cuando el script deje de depender de node. |
| Ayudantes del CLI en hooks activos | `quality-gate` → `navori gate foreign` (siempre lanza un proceso, `quality_gate.rs:230`); `session-start` → `navori audit --consume-arm` (`session_start.rs:~262`); auditoría → `navori audit --record-metadata` (`navori-core/src/audit.rs:471`). | gate: solo en `git commit`; audit: solo con auditoría armada | **Node** si el `navori` del PATH es el CLI TS | M (`gate foreign`, `audit`) | **Portar** `gate foreign` y los 3 modos de `audit` usados por hooks. Con eso, ningún hook activo vuelve a lanzar Node. |
| Comandos sin portar ni delegación permanente | `init`, `add`, `configure`, `update`, `refresh`, `audit`, `receipt`, `gate` (salvo `probe`), `tools` (salvo `notice`, `session-context` y `rust-shadow`), `bench` | No (a mano) | `node <legacy/dist>` vía `delegate.rs` | L (prompts de clack; `clack.rs` ya existe) | **Portar por demanda** (son el área E2/E3). `cutover:check` los marca. |
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

  La envoltura de shell suma **unos 1,5 ms de p50 por hook**. En Pi, además, bash lee un `.sh` de 1.000 a 3.400 líneas antes del bloque. En una llamada de Pi corren de 4 a 6 hooks en paralelo, así que el costo es CPU, no latencia en serie.
- Llamar al binario directo pierde el respaldo a bash (sin `navori-rust` o con exit 3). Para conservarlo, el bridge o el comando tienen que reintentar con bash ante 3, 126 o 127. Recomendación: en Pi sí (M, en el bridge, junto con `wip/pi-bridge-siblings-complete`). En Claude, el ahorro es la shell de Claude, que no se puede quitar: el campo `command` siempre pasa por una shell. Solo se gana el `$(…)`, unos 0,5 ms. No vale el cambio.

## Pregunta (b): ¿algún hook arranca Node en uso normal?

- **En sombra (hoy, hasta el 26 nov): sí.** Los 12 hooks portados lanzan **2 × Node** por llamada para el journal (`journal.rs:130-170`: `tools rust-shadow begin/complete`) y además corren el carril de bash. Desaparece al activar (`hook.rs`: `use_shadow` exige el modo `shadow`).
- **Activos, después de 0.13: no, en el caso normal.** Lo que queda:
  - `routing-watch` y `bash-outcome-watch` (shell puro, no portados) corren en cada PostToolUse. Siempre lanzan `git` y `jq`. Lanzan `node -e` cuando registran la evidencia de bash de un plan con trabajo en curso (`bash-outcome.sh:122-126`, `:284-288`), cuando arman un aviso (`routing-watch.sh:240`) o en Codex (`bash-outcome.sh:324`). Es el **único Node en el camino caliente** después de 0.13, y aparece justo en las sesiones con plan activo.
  - Con la auditoría armada: `navori audit --record-metadata` (TS) en cada evento auditado.
  - `quality-gate-pre-commit` en `git commit`: `navori gate foreign` (TS).
  - `session-start-context`: `navori audit --consume-arm` (TS) una vez por sesión.
  - Analizadores `node -e`/`python3` de `implementer-no-markdown` y `pr-publisher-confirm` en sus casos raros.
  - Si el `navori` del PATH no es `navori-rust` de la misma versión, los ayudantes en proceso (`gate probe`, `plan gate`, `tools session-context`) lanzan `navori` en vez de correr dentro del proceso (`hook_facts.rs:250-252`).

## Pregunta (c): TS duplicado de lo portado que se podría borrar después del release

| Pieza | Líneas | ¿Se puede borrar? |
|---|---|---|
| `lib/rust-shadow/` + `tools rust-shadow` (journal de sombra, TS) y `journal.rs`/`shadow.rs` (Rust) | 505 TS (+ Rust) | **Sí**, después de activar los 12 y archivar R81. Es lo único que se puede borrar sin cambiar el modelo. |
| Herramientas de cierre (`hook-shadow-report.mjs`, `bench-hooks --impl shell`) | unas 1.500 | Sí, cuando ya no haya hooks en sombra (o dejarlas para el próximo port). |
| `commands/*.ts` y `lib/*` de los comandos portados | unas 24.000 | **No** en 0.13.x: el binario delega en ellos las formas que no modela y son el oráculo de paridad. Se borran por comando cuando desaparezca la última rama `None` → delegar. |
| `.sh` de los 12 hooks y sus partials | 4.633 + 3.195 (fuente) | **No**: son el respaldo y la entrada de integridad. Borrarlos exige otro modelo (implementación embebida en el binario) y una historia para instalar sin binario. |

## Orden recomendado (después de 0.13)

1. **0.13.1**:
   - re-firma de latencia del guard (`wip/rust-guard-latencia`);
   - bridge de Pi que deja terminar a los hermanos (`wip/pi-bridge-siblings-complete`);
   - que el bridge llame al binario directo, con respaldo a bash.
2. **Después de archivar R81**: borrar el journal de sombra (TS + Rust) y sus herramientas.
3. **Port de `routing-watch` y `bash-outcome-watch`** (L, #1701): quita el último Node del camino caliente.
4. **`gate foreign` y `audit`** (M): ningún hook activo lanza Node.
5. **`managed-drift-watch`** (M): reabrir la decisión de "permanente".
6. **Lo demás** (`init`, `add`, `configure`, `update`, `refresh`, `receipt`): por demanda.

## Preguntas abiertas

- ¿El `navori` del PATH después de 0.13 está garantizado que sea `navori-rust`? Si es el CLI TS, los ayudantes en proceso de los hooks lanzan Node.
- ¿El journal de sombra queda como modo de depuración opt-in o se borra?
- Repetir las mediciones de arranque en una ventana limpia antes de decidir lo del bridge de Pi.
