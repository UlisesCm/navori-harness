# Capa de búsqueda indexada (tgrep + codegraph) — Tasks

Cuatro lotes. El primero abre el contrato de plugin sin plugin que lo use (el harness
renderiza idéntico mientras tanto); el segundo construye el bundle completo; el tercero
alinea la doctrina core y cierra el experimento de codegraph; el cuarto es el cierre
auto-hospedado + release. Orden estricto entre lotes; dentro de un lote las tareas son
paralelizables salvo nota.

## Lote 1 — el contrato SessionStart en el schema de plugins

- [ ] **T1** (R7) — `HOOK_EVENTS` en `packages/cli/src/lib/plugins.ts` gana
  `"SessionStart"`; el comentario del contrato (líneas ~57-62) documenta el evento nuevo y
  la advertencia C2 (no corre para subagentes — un plugin que necesite alcanzarlos usa
  scripts o PreToolUse). Nada más cambia: `pluginHooksToClaudeShape` ya es genérica.
  · test: `src/lib/__tests__/plugins.test.ts` con `// Covers: R7` — un manifest con hook
  `SessionStart` valida; un evento inventado (`"SessionResume"`) sigue rechazado.
  · test: `src/lib/__tests__/plugin-gate-hooks.test.ts` con `// Covers: R7` — un plugin con
  hook SessionStart aterriza en `settings.hooks.SessionStart[].hooks[]` junto al hook core
  de `session-start-context.sh` sin pisarlo (dos entradas, deep-merge coalesced), y el
  render codex del mismo config NO emite nada nuevo ni falla.

## Lote 2 — el bundle del plugin

- [ ] **T2** (R10) — `packages/plugins/tgrep/{plugin.json,package.json}` con los campos
  exactos del design (§Components). `package.json` espejo del de jscpd (name
  `@navori/plugin-tgrep`, private). El bundling es automático (readdir) — verificar con
  `pnpm build && node -e "…listBundledPluginIds()"` que `tgrep` aparece.
  · test: `src/lib/__tests__/plugins.test.ts` con `// Covers: R10` — `loadPlugin("tgrep")`
  valida contra el schema; `externalTool.checkBinary === "tgrep"`; install declara darwin y
  linux y NO win32 (el warn limpio de `add.ts` es el comportamiento esperado).

- [ ] **T3** (R8) — `scripts/tgrep-session.sh`: stdout plano de UNA línea según presencia
  de binario (mensajes del design §Components), warm del índice con timeout defensivo,
  exit 0 en TODOS los caminos (binario ausente, cache no escribible, index que falla).
  · test: `src/lib/__tests__/tgrep-session-hook.test.ts` con `// Covers: R8` — bajo bash y
  zsh, con PATH-shim de tgrep presente: una línea que contiene `tgrep-search.sh` y exit 0;
  con PATH sin tgrep: una línea que contiene `brew install tgrep` y exit 0; con
  `XDG_CACHE_HOME` apuntando a un dir de solo lectura: exit 0 igualmente.

- [ ] **T4** (R1, R2, R3, R4, R5, R6) — `scripts/tgrep-search.sh` según el contrato del
  design (§Components). Es la tarea central del spec; el test de staleness es
  no-negociable.
  · test: `src/lib/__tests__/tgrep-search-script.test.ts` con
  `// Covers: R1, R2, R3, R4, R5, R6` — sobre un fixture git con espacio en el nombre del
  directorio (`repo con espacio/`):
  (a) con tgrep real en PATH [skip si no está en la máquina de CI: `command -v tgrep`],
  buscar un literal → mismos archivos que `rg -l` (R1, R6);
  (b) **staleness**: indexar (primera búsqueda), APPEND de un token nuevo a un archivo,
  segunda búsqueda del token → lo encuentra (R2 — sin el reindex interno este caso falla,
  H3);
  (c) con PATH-shim SIN tgrep pero con rg: resultados correctos + stderr contiene la línea
  de aviso con `brew install tgrep` (R3, R4);
  (d) con PATH-shim sin tgrep ni rg: `grep -rn` produce el match y exit 0; patrón sin
  match → exit 1 en las tres vías (R3);
  (e) tras cualquier corrida, `git status --porcelain` del fixture está vacío y el índice
  existe bajo el `XDG_CACHE_HOME` del test (R5);
  (f) dos `tgrep index` simultáneos al mismo cache path no dejan la búsqueda siguiente
  rota (design §Failure modes).

- [ ] **T5** (R11) — los cuatro assets de doctrina del plugin: `managed/tgrep-protocol.md`,
  `skills/tgrep-rung.md`, `skills/tgrep-search-agent.md`, `skills/tgrep-code-agent.md`, con
  el contenido del design (invocación canónica, tabla de ruteo codegraph↔tgrep, subset de
  flags seguro, flags prohibidos por bypass de índice). Claims redactados contra lo que los
  scripts REALMENTE hacen (la suite de `hook-claims-vs-scripts.test.ts` corre sobre esto).
  · test: `src/engines/claude/__tests__/render-tgrep-plugin.test.ts` con `// Covers: R11` —
  render de fixture con el plugin habilitado: el bloque `tgrep-protocol` está en
  `CLAUDE.md`; `structural-search/SKILL.md` contiene el sub-bloque del rung; los cuatro
  agentes (`researcher/explorer/implementer/reviewer.md`) contienen su inyección; el
  protocolo menciona `codegraph` (la tabla de ruteo existe).

## Lote 3 — doctrina core + codegraph

- [ ] **T6** (R9, R12, R14, R15) — `settingsFragment` del manifest (las DOS reglas allow de
  R9, ni una más) + la cláusula condicional en los bullets 7 y 22 de
  `packages/core/core-assets/managed/operaciones-seguras.md` (redacción: cede el default al
  wrapper "cuando el plugin tgrep está habilitado", sin tocar la exclusión vigente de `rg`
  directo) + `invariants: ["tgrep-search.sh"]`.
  · test: `render-tgrep-plugin.test.ts` con `// Covers: R9, R12, R14, R15` — settings del
  fixture contienen exactamente las dos reglas y NINGUNA para `rg`/`grep`; el CLAUDE.md
  renderizado contiene la cláusula condicional Y la exclusión de `rg` intacta; los
  invariants aparecen en el render y `doctor` del fixture pasa; deshabilitar el plugin +
  re-render deja el fixture sin `tgrep-search.sh`, sin sub-bloques y sin reglas allow
  (R15, reconciliación existente).

- [ ] **T7** (R13) — el experimento `alwaysLoad`, con las dos ramas cerradas: (1) agregar a
  mano `"alwaysLoad": true` a la entrada codegraph del `.mcp.json` de navori-harness,
  abrir sesión nueva de Claude Code, observar si `mcp__codegraph__*` aparece en tools
  cargados (no en la lista diferida del system-reminder); (2a) SI carga eager:
  `McpServerSchema` gana `alwaysLoad: z.boolean().optional()`, el builder de `.mcp.json`
  lo emite, manifest de codegraph lo declara y bump a 0.0.2; (2b) SI sigue diferido:
  revertir el edit manual y añadir a `codegraph-protocol.md` la línea de carga batcheada
  vía `ToolSearch` citando el hallazgo del audit. El resultado del experimento (fecha +
  versión de Claude Code + veredicto) queda escrito en el commit del cambio.
  · test (rama 2a): `src/lib/__tests__/plugins.test.ts` con `// Covers: R13` — manifest
  con `alwaysLoad` valida y el `.mcp.json` renderizado lo contiene.
  · test (rama 2b): `render` fixture asserta que `codegraph-protocol` contiene la
  instrucción de ToolSearch batcheado, en `render-tgrep-plugin.test.ts` con
  `// Covers: R13`.

## Lote 4 — cierre auto-hospedado + release

- [ ] **T8** (R10, R11) — auto-hospedaje: `navori add tgrep` en navori-harness (binario ya
  presente → sin install), `navori render --apply`, `navori doctor` limpio, y una sesión
  de humo: el hook emite su línea al arrancar y una búsqueda real por el wrapper devuelve
  lo mismo que `Grep`. Evidencia (salidas de doctor + la línea del hook) en la descripción
  del PR. Gate completo verde (`pnpm check` — recordar `format:check` y `test:coverage`,
  no `test`).
  · test: los de T2-T6 ya cubren el mecanismo; esta tarea aporta la evidencia de humo
  end-to-end sobre el repo real, citada en el PR.

- [ ] **T9** (R8, R11) — evals de activación según `evals.md` de esta spec: correr los
  tres escenarios RED/GREEN y llenar la tabla con veredictos y evidencia (los resultados
  invertidos se conservan tal cual salgan). Si GREEN-1 falla (el agente no usa el wrapper
  con la doctrina puesta), eso es un hallazgo de la clase #597 y se reporta en el PR — no
  se maquilla ajustando el escenario.

- [ ] **T10** — release + rollout (fuera del gate de la spec, proceso estándar 0.7.x):
  bump, publish (OTP de Ulises), `navori add tgrep && navori render --apply` en los 5
  repos propios (commit) y los 15 Bonum (solo render, harness gitignored). En máquinas sin
  tgrep el fallback del wrapper es el comportamiento esperado — no instalar tgrep como
  parte del rollout salvo pedido explícito.
