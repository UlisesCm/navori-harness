# Retirar la capa global (`navori global`) — Design

**Fecha:** 2026-10-08 · **Estado:** borrador para aprobación; challenge del auditor incorporado (2026-10-08).
**Señales:** decisión difícil de revertir (se borra un comando público y su contrato en
`doctor --json`), área crítica (plomería de render que escribe en el repo del usuario, guard de
`~/.navori` en los tests) y ownership (helpers de settings que hoy viven en un módulo que se borra).
**Ref verificada:** `git fetch origin dev` actualiza solo `FETCH_HEAD` en este clon (no existe la
ref `origin/dev`); `FETCH_HEAD` = `HEAD` = `ca13b11b`. Todo "ya existe" se leyó en esa ref.

## Approach

Retiro por sustracción, con dos piezas nuevas mínimas: un módulo neutral para los helpers de
settings que sobreviven y un chequeo de restos de solo lectura en `doctor`. No hay comando de
migración (decisión del usuario). El orden de los hitos deja cada commit compilable y verde:

1. **Extraer lo que sobrevive.** Los helpers que `lib/diagnose/foreign-harness.ts` importa de
   `engines/claude/global-render.ts` pasan a un módulo neutral, y `probeReceiver` pasa de
   `lib/audit/launchd.ts` a `lib/audit/collect.ts`. `scanForeignHarness` pierde la opción
   `globalLayerInstalled` (R4).
2. **Idioma sin `global.json`** en `audit`, `backup`, `migrations` y `registry` (R3).
3. **Borrar el comando y sus módulos**, `scanGlobalScope` en `doctor`, la supervisión launchd de
   `scanOtelReceiver` y sus tests e i18n (R1, R2).
4. **Quitar la plomería de render** (`fallbackScope`, `GLOBAL_FALLBACKS`, `globalSafe`,
   `GLOBAL_SAFE_BLOCK_IDS`) sin tocar un byte de los goldens (R5).
5. **Chequeo de restos en `doctor`** (R6–R8).
6. **Docs y web** (R9, R10).

### Enfoques descartados

- **Dejar `navori global uninstall` una versión como ruta de limpieza.** Excluido por la decisión
  del usuario: navori no escribe ni borra nada en `~/.claude` ni en `~/Library/LaunchAgents`.
- **Copiar los helpers dentro de `foreign-harness.ts`.** El chequeo de restos también necesita el
  directorio de usuario de Claude (que respeta `CLAUDE_CONFIG_DIR`); dos copias de esa resolución
  serían dos definiciones de dónde vive `~/.claude`.
- **Conservar `fallbackScope` con un solo valor.** Un parámetro con un único valor posible es
  plomería muerta; quitarlo deja que `tsc` encuentre cualquier llamador olvidado.
- **Leer `navori.config.json` del cwd en `backup`/`migrations`/`registry`.** Cambiaría la salida de
  usuarios que nunca instalaron la capa; R3 solo pide dejar de leer `global.json` (D4).

## Components

- `packages/cli/src/engines/claude/user-scope.ts` (nuevo): `claudeUserDir()` (antes
  `globalTargetDir`), `readSettingsFile()` y su tipo `SettingsRead` (antes `readExistingSettings` y
  `GlobalSettingsRead`), `permissionBagOf()` con la lista `allow`/`deny`/`ask` que hoy es
  `PERMISSION_KINDS` en `lib/config/global-config.ts`. Movidos sin cambio de comportamiento. Cubre R4.
- `packages/cli/src/lib/diagnose/foreign-harness.ts` (`scanForeignHarness`,
  `permissionContradictions`, `ForeignHarnessOptions`): importa de `user-scope.ts`; sin
  `globalLayerInstalled`, sin la rama `skip` y sin `globalConfigExists`. Conserva la exclusión
  `NAVORI_PLUGIN_DIR` (D2). Cubre R4.
- `packages/cli/src/lib/audit/collect.ts`: recibe `probeReceiver` junto a `DEFAULT_PORT` y
  `SERVICE_ID`. Cubre R2.
- `packages/cli/src/commands/{audit,backup,migrations,registry}.ts` (`reportLang`, `globalLang`):
  sin `readGlobalConfig` (D4). Cubre R3.
- `packages/cli/src/index.ts` (`subCommands`): sin `global`. Cubre R1.
- Se borran: `commands/global.ts`, `commands/global-prompts.ts`, `lib/config/global-config.ts`,
  `engines/claude/global-render.ts`, `engines/claude/global-plugin.ts`,
  `lib/workspace/global-scope.ts`, `lib/audit/launchd.ts`. Cubre R2.
- `packages/cli/src/commands/doctor.ts`: sin `scanGlobalScope` ni la sección "Capa global";
  `scanOtelReceiver` y `OtelReceiverReport` sin `supervised` ni `supportsSupervisor` (D6); nueva
  llamada a `scanGlobalLayerLeftovers` con salida humana y la llave JSON `globalLayerLeftovers`
  en lugar de `globalScope` (D5). `scanStaleGlobalCli` no cambia. Cubre R6–R8.
- `packages/cli/src/lib/diagnose/global-leftovers.ts` (nuevo): `scanGlobalLayerLeftovers(opts)`,
  solo `lstat`. Cubre R6–R8.
- Render: `lib/render/placeholders.ts` (`GLOBAL_FALLBACKS`, `FallbackScope`, parámetro `scope` de
  `placeholderFallback`), `lib/render/interpolate.ts` (`fallbackScope` en las opciones de
  `interpolate`, `interpolateRaw`, `maybeInterpolateLine`), `engines/shared/render-managed-file.ts`
  (`fallbackScope` en el input y en `interpolateFrontmatter`), `lib/render/render-plan.ts` (campo
  `globalSafe` de los assets, `GLOBAL_SAFE_BLOCK_IDS`, mención del baseline global en el JSDoc de
  `conditionOrchestration`). Cubre R5.
- `packages/cli/src/lib/i18n.ts`: fuera el bloque `global` (`GlobalCmdStrings`, es/en),
  `common.globalQualityGate|globalBranchBase|globalPrTarget|globalCommits`,
  `engine.globalBaselineIntro`, `doctor.globalScope*`, `doctor.otelReceiverDead` y
  `doctor.otelReceiverAbsent`; `doctor.otelReceiverManual` reescrito sin `global collect`; nuevas
  claves del aviso de restos. `globalCliStale` no cambia. Cubre R1, R6.
- Docs y web: `README.md`, `packages/cli/README.md` (tabla de comandos y sección "Harness global
  por máquina"), `packages/cli/src/engines/README.md` (párrafo del engine `"global"`),
  `apps/website/src/content/commands.ts` (entrada `global` y menciones a `global collect`),
  `apps/website/src/content/command-groups.ts` (`"global"` en su grupo),
  `apps/website/src/pages/llms.txt.ts` ("Tres alcances"), `apps/website/src/components/sections/Scopes.astro`
  y `apps/website/src/i18n/ui.ts` (`scopes.global.*`). Cubre R9.
- `docs/DIRECTION.md` y `specs/0010-global-harness/design.md` (D7). Cubre R10.

## Decisions

### D1 — Helpers en `engines/claude/user-scope.ts`, con nombres sin "global" (R4)

Leen archivos de settings de Claude, igual que `build-settings.ts` y `coexist-settings.ts`, y
`lib/diagnose` ya importa de `engines/claude`. Tienen dos consumidores: `foreign-harness.ts` y
`global-leftovers.ts`. El renombre cuesta poco (hoy el único importador de fuera es
`foreign-harness.ts`) y evita que un "global" huérfano sugiera una capa que ya no existe.

### D2 — `foreign-harness` se comporta como hoy con `globalLayerInstalled: false` (R4)

La comparación del `settings.json` personal contra el `deny` del repo corre siempre. En una
máquina sin capa global el resultado es idéntico; en una con restos, el hallazgo que antes daba
`scanGlobalScope` ahora sale aquí, que es lo correcto porque `scanGlobalScope` desaparece. La
exclusión de `~/.claude/skills/navori/` (`NAVORI_PLUGIN_DIR`) se queda: ese directorio lo reporta
el chequeo de restos, y sin la exclusión saldría también como colisión ajena.

### D3 — Plomería de render: sustracción con los goldens como prueba (R5)

Con `fallbackScope` ausente, todo llamador de repo ya usa `repo`, y `placeholderFallback` en
`repo` nunca consulta `GLOBAL_FALLBACKS`. `globalSafe` solo lo leen `GLOBAL_SAFE_BLOCK_IDS` y
`composeBaseline`, ambos borrados. Por eso la salida no cambia. La prueba es que
`engines/__tests__/golden-render-tree.test.ts` pase **sin** `-u` y que `bun run check:render` no
marque drift en este repo. `tsc` falla ante cualquier llamador que siga pasando `fallbackScope`.

### D4 — Precedencia de idioma sin `global.json` (R3)

- `audit` (`reportLang`): `language` de `navori.config.json` del cwd, y si no hay, `DEFAULT_LANG`
  (`es`) vía `resolveLang`.
- `backup`, `migrations` y `registry` (`globalLang`): `DEFAULT_LANG`. Las tres copias de
  `globalLang()` se borran y cada sitio usa `DEFAULT_LANG`.

Costo aceptado: quien tenía `language: "en"` en `global.json` verá esos tres comandos en español.

### D5 — Chequeo de restos: módulo propio, solo `lstat`, advisory (R6–R8)

- `scanGlobalLayerLeftovers({ home, claudeDir })` devuelve `Array<{ kind, path }>` con `kind` en
  `manifest` (`<home>/.navori/global.json`), `plugin` (`<claudeDir>/skills/navori`, solo si su
  `.claude-plugin/plugin.json` declara `name: "navori"`), `legacy-hook`
  (`<claudeDir>/hooks/navori-global-baseline.sh`) y `launch-agent`
  (`<home>/Library/LaunchAgents/com.navori.audit-collect.plist`, en cualquier plataforma).
  Los defaults salen de `safeHomedir()` y `claudeUserDir()`; si lanzan, el resultado es `[]`.
- Existencia por `lstat`: un symlink roto también es un resto. La única lectura es el
  `plugin.json` del candidato `plugin`: un skill propio del usuario llamado `navori` no es un resto
  y nunca se le indica borrarlo (challenge, falso positivo con pérdida de datos).
- Las rutas impresas son las resueltas (`claudeDir` respeta `CLAUDE_CONFIG_DIR`), sin `/` final,
  no un `~/.claude` fijo.
- Módulo aparte porque es transitorio: retirarlo más adelante es borrar un archivo y una llamada.
- Salida humana: un `p.log.warn` con los restos encontrados y solo los pasos que aplican, en este
  orden: (1) `launchctl bootout gui/$(id -u)/com.navori.audit-collect` y borrar el plist (y, si se
  quiere, `~/.navori/logs/collect.*.log`), con la advertencia de que quien usa `audit.mode: always`
  debe correr `navori audit --collect` con un supervisor propio, porque el bootout detiene su
  receptor; (2) en `~/.claude/settings.json`, quitar las entradas
  `SessionStart` que apuntan a `navori-global-baseline.sh` y las reglas listadas en
  `ownedPermissions` de `~/.navori/global.json`, **antes** de borrar ese archivo; (3) borrar
  `~/.claude/skills/navori/` y `~/.claude/hooks/navori-global-baseline.sh`; (4) borrar
  `~/.navori/global.json`.
- No alimenta `computeHealthVerdict` ni `--strict`. Sin restos: nada en la salida humana y
  `globalLayerLeftovers: []` en JSON.

### D6 — `audit --collect` se queda; sale solo su supervisor (confirmado por el usuario, 2026-10-08)

El receptor (`lib/audit/collect.ts`, `audit --collect`) es la vía de datos de `audit.mode: always`
(Spec 0021) y tiene sentido en primer plano o con cualquier supervisor. Además, un plist que quede
corre `node <bin> audit --collect` con `KeepAlive`: si el subcomando desapareciera, launchd lo
relanzaría en bucle fallando. `scanOtelReceiver` queda en dos estados: responde (info) o no
responde (warn con `otelReceiverManual`, que indica `navori audit --collect`).

### D7 — `DIRECTION.md` y Spec 0010 (R10)

- Se borra la sección "La capa global (`~/.claude`) — qué es y qué no es".
- La meta "Base por-máquina y por-workspace" queda solo como Dominio (Spec 0011).
- El invariante 8 se reescribe **en su mismo número** para cubrir solo el Dominio, porque
  `commands/render.ts` (JSDoc de `appendCodexTrustHint`) cita "invariant 8".
- En "No-metas" entra el piso por máquina en `~/.claude`, con su porqué: no se adoptó y costaba
  ~5.5–6k LOC. La mención en "Qué requiere discusión" y la de Referencias cambian a "0010
  (superseded por 0046)".
- `specs/0010-global-harness/design.md` gana una línea de estado al inicio: superseded por la Spec
  0046 (2026-10-08). El resto queda como historia.

## Migration

- **Máquinas con la capa instalada:** el plugin y el hook siguen funcionando solos (el script
  generado no llama a `navori`), así que nada se rompe al actualizar. Solo dejan de actualizarse.
  `doctor` avisa con los pasos de D5.
- **Consumidores de `doctor --json`:** la llave `globalScope` desaparece y entra
  `globalLayerLeftovers` (cambio incompatible, va en la nota de versión). Para quien no adoptó la
  capa, `globalScope` siempre fue `null`.
- **Con la capa instalada**, el conflicto del `settings.json` personal contra el `deny` del repo
  pasa de `globalScope` a `foreignHarness.permissions` (D2).
- **Release:** quitar un comando se anota en la nota de la versión que lo publique. El historial
  existente de `apps/website/src/content/releases.ts` no se toca.

## Failure modes

- **Drift de render (área crítica).** Si un golden cambia, R5 falla: se corrige el código, nunca
  se regenera el golden. `check:render` es la segunda red.
- **Tests que tocan el `~` real.** `vitest.homeGuard.ts` conserva su guard de `~/.navori`. Los
  tests de restos inyectan `home` y `claudeDir` en temporales.
- **Allowlists obsoletas.** `removal-parity.test.ts` y `render-writes-backed-up.test.ts` listan los
  módulos borrados; sus entradas se quitan en el mismo commit que borra los archivos.
- **Conflicto con `chore/remove-jscpd-semgrep`** (checkout principal, sin commitear): modifica
  `engines/claude/global-render.ts` (un comentario), `lib/render/render-plan.ts` (un comentario en
  `computeRenderPlan`) y los goldens `claude.snap`/`codex.snap`. El que mergee segundo rebasa: en
  `global-render.ts` gana el borrado; en los goldens se toma la versión de `dev` y se corre la suite
  golden sin `-u`, que debe pasar (prueba de R5 sobre la nueva base). Si esa rama trae un baseline
  de jscpd que cite archivos borrados, se regenera.
- **HOME inutilizable.** `scanGlobalLayerLeftovers` devuelve `[]`, igual que `scanForeignHarness`
  devuelve `null`: "no puedo saberlo" no tumba `doctor`.

## Testing strategy

- R1: `command-docs-inventory.test.ts` afirma que `subCommands` no tiene `global` y que
  `global` no aparece como documentado ni como no documentado.
- R2: test nuevo que afirma que los siete módulos no existen bajo `src/`.
- R3: tests de `audit` y de `backup`/`registry` con un `~/.navori/global.json` en `en` en el HOME
  simulado: la salida sigue en `es` (o en el idioma del config del repo, para `audit`).
- R4: `foreign-harness.test.ts` sin `globalLayerInstalled`; el caso que lo pasaba en `true` se
  convierte en "con `global.json` presente, el conflicto del settings personal sí se reporta".
- R5: `golden-render-tree.test.ts` sin cambios en `__golden__`, más `bun run check:render`.
  `interpolate.test.ts` y `condition-tokens.test.ts` pierden los casos `global`.
- R6–R8: `global-leftovers.test.ts` (nuevo) con cada resto por separado, los cuatro juntos,
  ninguno, y un `skills/navori` sin `plugin.json` de navori (no es resto); snapshot de rutas, tamaños y `mtime` del HOME temporal antes y después: idéntico (R7).
  `doctor-json-checks.e2e.test.ts` cambia su bloque de `globalScope` por `globalLayerLeftovers`.
- R9: `command-docs-inventory.test.ts` más una búsqueda de `navori global` en los READMEs, la web
  y `llms.txt`, que no debe dar resultados (salvo `releases.ts`).
- Se borran: `global-prompts`, `global-collect-install`, `global-collect-uninstall`,
  `global-config`, `global-render`, `global-legacy-migration`, `global-plugin`,
  `permission-ownership`, `global-scope`, `global-safe-inventory`, `global-zero-footprint` y
  `launchd`. Los casos de `probeReceiver` de `launchd.test.ts` pasan al test de `collect`.
- Se editan: `claude-md-diet` (fuera el bloque "global baseline"), `i18n`, `classify` (rutas de
  fixture que ya no existen), `audit-collect` (comentario de launchd) y `vitest.homeGuard.ts`
  (solo el texto que menciona `global-config`).
- Gate: `bun check`.

## NOT in scope

- Reportar entradas de `settings.json` sin los archivos de R6: el chequeo mira solo los cuatro
  restos.
- `doctor` fuera de un repo con navori: sale antes por `noConfigRunInit` y no busca restos.
- Specs históricas que mencionan la capa (0014, 0015, 0021, 0026, 0035, 0039, 0041, 0042) y
  `docs/research/*`: son registro fechado y no se editan.
- `scanStaleGlobalCli` y `globalCliStale`: hablan del `navori` del PATH, no de esta capa.

## Durable knowledge

- **DIRECTION.md (No-metas):** el piso por máquina en `~/.claude` y su porqué (D7).
- **Dominio (engram):** "doctor detecta restos y da pasos; navori nunca escribe fuera del repo
  para limpiar" como patrón para futuros retiros.

## Entregas propuestas

Un PR (cierra el issue completo), con un commit atómico por hito del Approach, en ese orden. Cada
commit deja `bun check` verde. El hito 4 va separado para que el diff de render se revise solo y se
vea que `__golden__` no cambia.
