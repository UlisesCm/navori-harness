# Paridad Codex — Tasks

Lotes en orden; cada lote cierra con el quality gate verde (`bun check`). Rutas de test relativas a
`packages/cli/src/`. Cada test lleva `// Covers: R<n>`.

## Lote A — Registro de hooks y adaptador de payload

- [x] **T1** (R3, R18) — Crear `engines/codex/hook-registrations.ts` con `CODEX_HOOK_REGISTRATIONS`
  y `resolveCodexHooks(config)` según la tabla de D1, y hacer que `buildCodexConfigToml` serialice
  su resultado. Los 4 registros actuales conservan comando, matcher, timeout, `statusMessage` e
  índice; los nuevos van después dentro de su evento. La versión mínima sale del máximo de la tabla
  y reemplaza la constante fija de `doctor`.
  · test: `engines/__tests__/engine-parity.test.ts`::"every Claude hook is registered for Codex or
  declared unsupported" · `engines/__tests__/render-codex.test.ts`::"keeps the trusted_hash of the
  four pre-existing registrations" (los 4 hashes reales de D9) ·
  `commands/__tests__/codex-doctor.test.ts`::"derives the minimum Codex version from the
  registrations".
- [x] **T2** (R4) — Crear `core-assets/hooks/_partials/hook-input.sh` (D2): `nv_engine` por
  ubicación del script, `nv_project_dir`, `nv_progress_dir`, `nv_tool`, `nv_edited_paths` (encabezados
  de `apply_patch`) y `nv_subagent_type`. El partial normaliza entrada; cada script conserva su
  contrato propio de salida. Los hooks que requieren normalización específica de engine adoptan el
  partial; los demás conservan su lectura de payload y quedan cubiertos por sus pruebas de paridad
  y ciclo de vida. `plan-gate` permanece Claude-only mientras R6 esté diferido.
  · test: `lib/__tests__/codex-hook-payloads.test.ts`::"same verdict for paired Claude and Codex
  payloads" (implementer-no-markdown, guard-destructive, subagent-stop-handoff; plan-gate remains
  a Claude-only enforcement surface in this spec) ·
  `lib/__tests__/lifecycle-hooks.test.ts` sigue verde sin cambios bajo Claude.
- [x] **T3** (R1, R2) — `session-start-context` bajo Codex emite la parte viva (rama, aviso de rama
  base, commits, `progress/current.md`, worktrees conservados, audit mode) como `additionalContext`
  JSON, con el mismo tope de 8000 caracteres y puntero que Claude, sin `.claude/context/*.md` (D3).
  · test: `lib/__tests__/session-start-hook.test.ts`::"codex payload yields additionalContext with
  branch, commits and progress" · `engines/__tests__/render-codex.test.ts`::"registers
  session-start-context on SessionStart for all five sources".

## Lote B — Controles aplicados y `ask`

- [x] **T4** (R6, R7, R8) — Mantener Codex plan-gate sin registro y sin declaración `enforced`
  mientras R6 esté diferido. Registrar `implementer-no-markdown` sobre `^(Bash|apply_patch)$` (con
  `scribeOwnsMarkdown`) y declarar `markdown-ownership` `enforced` con evidencia `hook` en
  `ENGINE_CAPABILITIES.codex`; el inventario debe comprobar ambos hechos y conservar los demás
  controles Codex en alcance. El plan-gate de Claude no cambia.
  · test: `engines/__tests__/control-inventory.test.ts`::"codex enforced controls are registered
  with their event and matcher; deferred plan-gate is not registered or enforced".
- [x] **T5** (R5) — No registrar `pr-publisher-confirm` en Codex. Agregar un test que recorra los
  scripts registrados en Codex y falle si alguno puede emitir `"ask"` sin rama para
  `nv_engine=codex`. La regla `gh pr create → prompt` llega en T6.
  · test: `lib/__tests__/hook-claims-vs-scripts.test.ts`::"no Codex-registered hook emits ask".

## Lote C — Permisos, modelos e instrucciones

- [x] **T6** (R5, R9, R10) — Extraer `engines/shared/permission-rules.ts`
  (`collectShellPermissionRules`) de `buildSettings` sin cambiar `.claude/settings.json`. Crear
  `engines/codex/build-rules.ts` (`buildCodexRules`) con la traducción de D5, más la regla
  `gh pr create → prompt`. Escribir `.codex/rules/navori.rules` como archivo managed, y emitir la
  advertencia agregada, que no bloquea, más la lista completa en `--json`.
  · test: `engines/__tests__/codex-rules.test.ts`::"translates ask/deny and never emits allow",
  "an exact pattern becomes a prefix rule", "narrows a trailing
  glued asterisk and reports it", "drops inner wildcards and non-Bash rules",
  "settings.json and navori.rules share one source" · golden de `.claude/settings.json` sin cambios.
- [x] **T7** (R11, R12) — Nuevo `CODEX_MODEL_BY_CLAUDE_TIER` (D7) y `project_doc_max_bytes` según
  D8, calculado del `AGENTS.md` planeado.
  · test: `engines/__tests__/render-codex.test.ts`::"maps tiers to gpt-6 unless codexMap overrides",
  "writes project_doc_max_bytes only above 32768".

## Lote D — Instalación

- [x] **T8** (R14, R16) — Crear `lib/codex/trust.ts`: `codexHookHash`, `codexHookKey`,
  `readCodexTrustState` y `planTrustEdit` (D9, D10). Agregar `smol-toml` como dependencia para validar.
  · test: `lib/__tests__/codex-trust.test.ts`::"reproduces the four real Codex hashes",
  "classifies Trusted, Modified and Untrusted", "edit preserves every other byte of a config with
  comments and foreign tables", "invalid result is never written".
- [x] **T9** (R13, R14, R15) — Comando `navori codex trust` (`commands/codex.ts`, citty +
  `@clack/prompts`): muestra ruta y tabla de hooks, pide confirmación, respalda en
  `~/.navori/backups/`, escritura atómica con modo `0600` y relectura antes de escribir. Soporta
  `--yes` y `--cwd`, es idempotente y verifica con `hooks/list` si `codex` está instalado.
  · test: `commands/__tests__/codex-trust.test.ts`::"no confirmation writes nothing and makes no
  backup", "non-TTY without --yes exits non-zero", "second run is a no-op",
  "aborts if the config changed after confirmation".
- [x] **T10** (R16, R17, R18) — `doctor` (`scanCodexHealth`) reporta la confianza del proyecto con el
  mensaje de error propio, los hooks por estado y la versión mínima derivada. `render`/`sync`/`init`
  imprimen `navori codex trust` como siguiente paso en lugar de `codexTrustHint`.
  · test: `commands/__tests__/codex-doctor.test.ts`::"untrusted project is an error that says
  AGENTS.md does not load", "trusted project with unapproved hooks is a warning with the count" ·
  `commands/__tests__/codex-render-next-step.test.ts`::"render points to navori codex trust only
  when something is missing".

## Lote E — Capacidades de plugins

- [x] **T12** (R19) — Distinguir herramientas CLI declaradas por `externalTool` de servidores MCP
  declarados por `mcpServer`: no generar advertencia MCP ni tabla falsa para CLI-only, serializar la
  tabla real de MCP y advertir si falta ambas capacidades. Esto no promete invocación automática de
  CLI; los hooks automáticos de escáner permanecen diferidos hasta validar payload y ciclo de vida
  del host.
  · test: `engines/codex/__tests__/render-codex.test.ts`::"distinguishes CLI-only, MCP-only, and
  unconfigured plugins in Codex config".

## Lote F — Default de permisos Codex

- [x] **T13** (R20) — Emitir en la configuración raíz generada `sandbox_mode = "danger-full-access"`,
  `approval_policy = "on-request"` y `approvals_reviewer = "user"`; preservar la herencia de agentes,
  modos explícitos más restrictivos y overrides CLI/host. Corregir inventario de capacidades y la
  advertencia para no presentar sandbox, reglas o `guard-destructive` como protección de rutas o
  aprobación por comando; la guardia solo cubre Bash. Render/migración debe conservar backup y ser
  idempotente, sin mutar config global ni otros repos.
  · evidencia: pruebas dirigidas (72) y golden verdes; la prueba incluye agente explícito read-only.
  `.codex/config.toml` renderizado contiene los tres valores. En checkout aislado, upgrade desde
  `workspace-write` dio primera sync `pending: 1`, `written: 1` con backup, y segunda sync
  `pending: 0`, `written: 0`. `codex doctor --json` reportó `sandbox.helpers` en estado `ok`, modo
  irrestricto por defecto y modo restringido bajo override CLI; el doctor completo salió 1 por
  diagnósticos no relacionados. Reviewer aprobó el gate completo (297 archivos, 5402 tests pass,
  1 skip); receipt fresco al revisar. La herencia de subagentes sigue la documentación oficial, no
  un smoke live. No se mutaron configuración global, host activo ni otros repositorios.

## Cierre

- [x] **T11** — Cierre manual del alcance restante y limitación: en un checkout aislado de
  `navori-harness`, `navori sync --apply --json` terminó con `status: ok`, `pending: 0` y
  `written: 0`. Con un `HOME` aislado, `navori codex trust --yes` seguido de `navori doctor`
  confirmó **12/12 hooks Trusted** y que plan-gate no está registrado. En Codex 0.157.1, `codex exec`
  entregó en `SessionStart` la rama `spec/0035-paridad-codex` y el encabezado de
  `progress/current.md` (`# Checkpoint — #1046 / Spec0036`) sin leer ese archivo. En un smoke
  `workspace-write`, Codex ejecutó un único `apply_patch` para crear cuatro probes temporales; el
  payload observado por `routing-watch` fue `navori: routing check.` y el registro correlacionado
  `.git/navori/routing-watch/01a0e5a8-db90-7d52-9efa-61e03c35f30c` enumeró las cuatro rutas y
  `#notified`. Esto verifica routing-watch por separado; no implica que todos los hooks se hayan
  probado individualmente. Codex plan-gate queda temporalmente fuera: un smoke previo creó un
  implementer sin workplan, así que no se afirma ni se exige su enforcement en esta spec.
