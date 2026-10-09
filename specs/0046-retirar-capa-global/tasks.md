# Retirar la capa global — Tasks

Una entrega → un PR contra `dev`, que cierra el issue completo. Cada milestone es un commit
atómico en el orden de design.md § "Approach", y cada uno deja `bun check` verde. Cada test lleva
`// Covers: R<n>`. La suite golden nunca se corre con `-u` en esta spec (D3).

## E1 — Retiro de `navori global`
Estimated LOC: 6000

### M1 — Extraer lo que sobrevive
- **A1** — harness ajeno y receptor de audit en verde tras la extracción ·
  `cd packages/cli && bun run test src/lib/diagnose/__tests__/foreign-harness.test.ts src/lib/audit/__tests__`
  → exit 0, 0 failed
- [x] **T1** (R4) — `engines/claude/user-scope.ts` con `claudeUserDir`, `readSettingsFile`
  (`SettingsRead`) y `permissionBagOf`, movidos sin cambio de comportamiento desde
  `global-render.ts`/`global-config.ts` (D1) · effect: behavior · test:
  `engines/claude/__tests__/user-scope.test.ts`::"claudeUserDir respeta CLAUDE_CONFIG_DIR"
- [x] **T2** (R4) — `scanForeignHarness` importa de `user-scope.ts`, sin `globalLayerInstalled`
  ni `globalConfigExists`; conserva `NAVORI_PLUGIN_DIR` (D2) · effect: behavior · test:
  `lib/diagnose/__tests__/foreign-harness.test.ts`::"con global.json presente, el conflicto del settings personal se reporta"
- [x] **T3** (R2) — `probeReceiver` pasa de `lib/audit/launchd.ts` a `lib/audit/collect.ts` con
  sus casos de test · effect: behavior · test:
  `lib/audit/__tests__/collect.test.ts`::"probeReceiver"

### M2 — Idioma sin `global.json`
- **A2** [observable] — con `~/.navori/global.json` en `en` en un HOME temporal, los comandos
  siguen en el idioma de D4 · `cd packages/cli && bun run test src/commands/__tests__` → exit 0,
  0 failed
- [x] **T4** (R3) — `reportLang` de `audit` resuelve `navori.config.json` del cwd y luego
  `DEFAULT_LANG`, sin `readGlobalConfig` (D4) · effect: behavior · test:
  `commands/__tests__/audit.test.ts`::"idioma ignora global.json"
- [x] **T5** (R3) — `backup`, `migrations` y `registry` borran `globalLang()` y usan
  `DEFAULT_LANG` (D4) · effect: behavior · test:
  `commands/__tests__/backup-restore.test.ts`::"idioma ignora global.json"

### M3 — Borrar el comando y sus módulos
- **A3** [observable] — `navori global` no existe y ningún módulo de la capa queda bajo `src/` ·
  `cd packages/cli && bun run test src/__tests__/command-docs-inventory.test.ts src/lib/__tests__/global-layer-removed.test.ts`
  → exit 0, 0 failed
- [x] **T6** (R1) — `index.ts` (`subCommands`) sin `global`; `command-docs-inventory.test.ts`
  afirma su ausencia y reescribe su fixture de `global` · effect: behavior · test:
  `__tests__/command-docs-inventory.test.ts`::"global no está registrado"
- [x] **T7** (R2) — se borran los siete módulos de R2, sus tests (lista de design.md § "Testing
  strategy"), sus entradas en `removal-parity.test.ts` y `render-writes-backed-up.test.ts`, y las
  claves i18n de la capa; `doctor` pierde `scanGlobalScope` y la supervisión launchd de
  `scanOtelReceiver` (D6) · effect: behavior · test:
  `lib/__tests__/global-layer-removed.test.ts`::"los módulos de la capa global no existen"
- [x] **T8** (R2) — `doctor.otelReceiverManual` sin `global collect`; `scanOtelReceiver` en dos
  estados (responde / no responde) · effect: behavior · test:
  `commands/__tests__/otel-receiver-doctor.test.ts`::"receptor otel sin supervisor"

### M4 — Plomería de render (área crítica)
- **A4** [observable] — el render de repo no cambia un byte · `git diff --exit-code -- packages/cli/src/engines/__tests__/__golden__ && cd packages/cli && bun run test src/engines/__tests__/golden-render-tree.test.ts && cd ../.. && bun run check:render`
  → exit 0, sin diff en `__golden__`
- [x] **T9** (R5) — fuera `fallbackScope`, `GLOBAL_FALLBACKS`, `FallbackScope`, el parámetro
  `scope` de `placeholderFallback`, el campo `globalSafe` y `GLOBAL_SAFE_BLOCK_IDS` (D3);
  `interpolate.test.ts` y `condition-tokens.test.ts` pierden los casos `global` · effect: behavior
  · test: `engines/__tests__/golden-render-tree.test.ts`::"golden render tree" (sin `-u`)

### M5 — Chequeo de restos en `doctor`
- **A5** [observable] — los restos se reportan, el HOME no cambia y sin restos no hay ruido ·
  `cd packages/cli && bun run test src/lib/diagnose/__tests__/global-leftovers.test.ts src/__tests__/doctor-json-checks.e2e.test.ts`
  → exit 0, 0 failed
- [x] **T10** (R6) — `lib/diagnose/global-leftovers.ts` (`scanGlobalLayerLeftovers`) detecta los
  cuatro restos de D5 (`plugin` solo con `plugin.json` de navori) y `doctor` imprime el warning con
  los pasos que aplican, con rutas resueltas · effect: behavior · test:
  `lib/diagnose/__tests__/global-leftovers.test.ts`::"reporta cada resto con sus pasos"
- [x] **T11** (R7) — el chequeo es de solo lectura: snapshot de rutas, tamaños y `mtime` del HOME
  temporal idéntico antes y después de `doctor`; un `skills/navori` ajeno no es resto · effect:
  behavior · test: `lib/diagnose/__tests__/global-leftovers.test.ts`::"no escribe fuera del repo"
- [x] **T12** (R8) — sin restos, la salida humana no menciona la capa y `doctor --json` trae
  `globalLayerLeftovers: []` en lugar de `globalScope` · effect: behavior · test:
  `__tests__/doctor-json-checks.e2e.test.ts`::"globalLayerLeftovers vacío"

### M6 — Docs, web y dirección
- **A6** [observable] — ningún doc público documenta `navori global` · `bun check` → exit 0
- [ ] **T13** (R9) — READMEs, `engines/README.md`, `apps/website` (`commands.ts`,
  `command-groups.ts`, `llms.txt.ts`, `Scopes.astro`, `i18n/ui.ts`) sin `navori global`;
  `releases.ts` intacto · effect: docs · test:
  `__tests__/command-docs-inventory.test.ts`::"docs públicas no mencionan navori global"
- [ ] **T14** (R10) — `DIRECTION.md` según D7 (sección borrada, invariante 8 reescrito en su
  número, No-meta nueva) y línea de superseded en `specs/0010-global-harness/design.md` · effect:
  docs · test: `__tests__/command-docs-inventory.test.ts`::"DIRECTION no declara la capa global"
