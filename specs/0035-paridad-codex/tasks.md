# Paridad Codex — Tasks

Lotes en orden; cada lote cierra con el quality gate verde (`bun check`). Rutas de test relativas a
`packages/cli/src/`. Cada test lleva `// Covers: R<n>`.

## Lote A — Registro de hooks y adaptador de payload

- [ ] **T1** (R3, R18) — Crear `engines/codex/hook-registrations.ts` con `CODEX_HOOK_REGISTRATIONS`
  y `resolveCodexHooks(config)` según la tabla de D1, y hacer que `buildCodexConfigToml` serialice
  su resultado. Los 4 registros actuales conservan comando, matcher, timeout, `statusMessage` e
  índice; los nuevos van después dentro de su evento. La versión mínima sale del máximo de la tabla
  y reemplaza la constante fija de `doctor`.
  · test: `engines/__tests__/engine-parity.test.ts`::"every Claude hook is registered for Codex or
  declared unsupported" · `engines/__tests__/render-codex.test.ts`::"keeps the trusted_hash of the
  four pre-existing registrations" (los 4 hashes reales de D9) ·
  `commands/__tests__/codex-doctor.test.ts`::"derives the minimum Codex version from the
  registrations".
- [ ] **T2** (R4) — Crear `core-assets/hooks/_partials/hook-input.sh` (D2): `nv_engine` por
  ubicación del script, `nv_project_dir`, `nv_progress_dir`, `nv_tool`, `nv_edited_paths` (encabezados
  de `apply_patch`), `nv_subagent_type` y `nv_emit_context`. Migrar a él los literales `.claude/` y la
  lectura de payload de `guard-destructive`, `quality-gate-pre-commit`, `plan-gate`,
  `implementer-no-markdown`, `managed-drift-watch`, `routing-watch`, `subagent-stop-handoff`,
  `worktree-reclaim`, `audit-mode-trigger`, `audit-mode-close` y `stop-verify-reminder`.
  · test: `lib/__tests__/codex-hook-payloads.test.ts`::"same verdict for paired Claude and Codex
  payloads" (plan-gate, implementer-no-markdown, guard-destructive, subagent-stop-handoff) ·
  `lib/__tests__/lifecycle-hooks.test.ts` sigue verde sin cambios bajo Claude.
- [ ] **T3** (R1, R2) — `session-start-context` bajo Codex emite la parte viva (rama, aviso de rama
  base, commits, `progress/current.md`, worktrees conservados, audit mode) como `additionalContext`
  JSON, con el mismo tope de 8000 caracteres y puntero que Claude, sin `.claude/context/*.md` (D3).
  · test: `lib/__tests__/session-start-hook.test.ts`::"codex payload yields additionalContext with
  branch, commits and progress" · `engines/__tests__/render-codex.test.ts`::"registers
  session-start-context on SessionStart for all five sources".

## Lote B — Controles aplicados y `ask`

- [ ] **T4** (R6, R7, R8) — Registrar `plan-gate` sobre `^spawn_agent$` (con `planTiers`) e
  `implementer-no-markdown` sobre `^(Bash|apply_patch)$` (con `scribeOwnsMarkdown`); pasar
  `plan-gate` y `markdown-ownership` a `enforced` con evidencia `hook` en
  `ENGINE_CAPABILITIES.codex`; quitar la exclusión de Codex en `control-inventory.test.ts`. Registrar
  en `unsupportedSurfaces` las filas `unsupported` de D1 con su razón.
  · test: `engines/__tests__/control-inventory.test.ts`::"codex enforced controls are registered with
  their event and matcher".
- [ ] **T5** (R5) — No registrar `pr-publisher-confirm` en Codex. Agregar un test que recorra los
  scripts registrados en Codex y falle si alguno puede emitir `"ask"` sin rama para
  `nv_engine=codex`. La regla `gh pr create → prompt` llega en T6.
  · test: `lib/__tests__/hook-claims-vs-scripts.test.ts`::"no Codex-registered hook emits ask".

## Lote C — Permisos, modelos e instrucciones

- [ ] **T6** (R5, R9, R10) — Extraer `engines/shared/permission-rules.ts`
  (`collectShellPermissionRules`) de `buildSettings` sin cambiar `.claude/settings.json`. Crear
  `engines/codex/build-rules.ts` (`buildCodexRules`) con la traducción de D5, más la regla
  `gh pr create → prompt`. Escribir `.codex/rules/navori.rules` como archivo managed, y emitir la
  advertencia agregada, que no bloquea, más la lista completa en `--json`.
  · test: `engines/__tests__/codex-rules.test.ts`::"translates allow/ask/deny", "narrows a trailing
  glued asterisk and reports it", "drops inner wildcards and non-Bash rules",
  "settings.json and navori.rules share one source" · golden de `.claude/settings.json` sin cambios.
- [ ] **T7** (R11, R12) — Nuevo `CODEX_MODEL_BY_CLAUDE_TIER` (D7) y `project_doc_max_bytes` según
  D8, calculado del `AGENTS.md` planeado.
  · test: `engines/__tests__/render-codex.test.ts`::"maps tiers to gpt-6 unless codexMap overrides",
  "writes project_doc_max_bytes only above 32768".

## Lote D — Instalación

- [ ] **T8** (R14, R16) — Crear `lib/codex/trust.ts`: `codexHookHash`, `codexHookKey`,
  `readCodexTrustState` y `planTrustEdit` (D9, D10). Agregar `smol-toml` como dependencia para validar.
  · test: `lib/__tests__/codex-trust.test.ts`::"reproduces the four real Codex hashes",
  "classifies Trusted, Modified and Untrusted", "edit preserves every other byte of a config with
  comments and foreign tables", "invalid result is never written".
- [ ] **T9** (R13, R14, R15) — Comando `navori codex trust` (`commands/codex.ts`, citty +
  `@clack/prompts`): muestra ruta y tabla de hooks, pide confirmación, respalda en
  `~/.navori/backups/`, escritura atómica con modo `0600` y relectura antes de escribir. Soporta
  `--yes` y `--cwd`, es idempotente y verifica con `hooks/list` si `codex` está instalado.
  · test: `commands/__tests__/codex-trust.test.ts`::"no confirmation writes nothing and makes no
  backup", "non-TTY without --yes exits non-zero", "second run is a no-op",
  "aborts if the config changed after confirmation".
- [ ] **T10** (R16, R17, R18) — `doctor` (`scanCodexHealth`) reporta la confianza del proyecto con el
  mensaje de error propio, los hooks por estado y la versión mínima derivada. `render`/`sync`/`init`
  imprimen `navori codex trust` como siguiente paso en lugar de `codexTrustHint`.
  · test: `commands/__tests__/codex-doctor.test.ts`::"untrusted project is an error that says
  AGENTS.md does not load", "trusted project with unapproved hooks is a warning with the count" ·
  `commands/__tests__/codex-render-next-step.test.ts`::"render points to navori codex trust only
  when something is missing".

## Cierre

- [ ] **T11** — Humo manual antes del PR: en `monorepo-fullstack`, `navori sync` y `navori codex trust`,
  y luego una sesión real de `codex exec` que confirme el contexto de arranque y que `plan-gate`
  bloquee un `spawn_agent` sin workplan. Anotar el resultado en el PR.
