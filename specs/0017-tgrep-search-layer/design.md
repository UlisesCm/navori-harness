# Capa de búsqueda indexada (tgrep + codegraph) — Design

> **Para el implementador**: este design incluye TODO lo investigado (líneas exactas,
> comportamientos verificados empíricamente, contratos de la doc oficial con fecha). No
> re-investigues estos hechos; sí verifica que las líneas citadas no se hayan movido si
> `main` avanzó desde 2026-09-08.

## Hechos verificados (2026-09-08)

### tgrep 1.0.5 — empíricos, fixture controlado en scratchpad

| # | Comportamiento | Evidencia |
|---|---|---|
| H1 | Sin índice: degrada a scan completo con warning a stderr, exit 0, **no crea nada** en el repo | fixture: `warning: no index at <path>/.tgrep - scanning every file` |
| H2 | El default de índice es `.tgrep/` DENTRO del repo; `--index-path <dir>` lo reubica a donde sea | mismo warning + `tgrep index . --index-path` funcionó a dir externo |
| H3 | **Índice stale = falso negativo SILENCIOSO**: contenido nuevo en archivo ya indexado → exit 1 sin warning; archivo nuevo post-index → exit 1 sin warning | fixture T3/T4 |
| H4 | Contenido borrado post-index NO da falso positivo (verifica candidatos contra el archivo vivo) | fixture T5 |
| H5 | Re-index completo: 0.07s / 793 archivos de texto (bonum-webapp, el repo más grande del parque); índice 6.3M | medido con `time` |
| H6 | Paridad con rg: `tgrep -l "useEffect"` y `rg -l "useEffect"` sobre bonum-webapp → listas md5-idénticas (110 archivos) | md5 `80507608…` en ambos |
| H7 | Exit codes: 0 = match, 1 = sin match | fixture |
| H8 | Sin `--pre` ni preprocesadores; sin archivo de config (`--no-config` se acepta y se ignora, solo compat con líneas rg) → allowlist-safe | `--help` completo + README |
| H9 | Flags: superset casi total de rg (`-i -S -F -w -v -e -l -c -o -m -g -t -A/-B/-C -n --json --vimgrep -P …`) + propios (`--no-index`, `--index-path`, `--stats`) | `--help` completo |
| H10 | `tgrep serve`: TCP JSON-RPC 2.0 **sin auth**, bind address NO documentado; watch nativo con fallback a polling (default 120s) | README + `serve --help` |

### Claude Code — doc oficial (code.claude.com/docs, fetched 2026-09-08)

| # | Contrato | Consecuencia de diseño |
|---|---|---|
| C1 | `SessionStart` y `SessionEnd` son eventos de hook soportados; stdout PLANO de un hook SessionStart se agrega como contexto visible para Claude | el hook del plugin emite texto plano, sin jq/node |
| C2 | **SessionStart corre SOLO para la sesión principal, nunca para subagentes**; PreToolUse/PostToolUse sí corren en subagentes | el fallback vive en el wrapper, no en contexto de sesión |
| C3 | PreToolUse: exit 2 bloquea; cualquier otro código no-cero es advisory y la llamada procede | (ya documentado en jscpd; sin cambios) |
| C4 | `alwaysLoad` está documentado para servers http/sse/ws; para stdio los campos documentados son `command/args/env/timeout` | R13 exigió verificación empírica antes de renderizarlo. **Verificado 2026-09-09 (CC 2.1.236): TAMBIÉN funciona en stdio** — las tools diferidas de la sesión bajan de 68 a 67 y `codegraph_explore` arranca cargado. La doc está incompleta, no en contra; medición en `evals.md` |

### codegraph — doc oficial (github.com/colbymchenry/codegraph) + estado local

- Local: v1.5.0, índice `.codegraph/` de 33M en navori-harness, MCP registrado en `.mcp.json`
  (managed por navori) SIN `alwaysLoad`; en la sesión de esta investigación los tools
  `mcp__codegraph__*` arrancaron DIFERIDOS (pagan un `ToolSearch` antes del primer uso).
- Oficial: recomienda `"alwaysLoad": true` en el MCP config; auto-sync con watcher (debounce
  2s) + catch-up al reconectar + banner de staleness — la frescura del grafo NO necesita
  hook propio; FTS5 busca SÍMBOLOS (no texto arbitrario: eso sigue siendo de tgrep/rg);
  monorepos vía `projectPath`.
- Audit de navori (sesiones reales 2026-09-07/08): cientos de búsquedas shell, **cero**
  queries al grafo. El problema de codegraph no es cableado, es activación — mismo patrón
  que #597 (mecanismo > atención del modelo).

### navori — mecánica exacta (líneas de main @ 8499f7d)

- `packages/cli/src/lib/plugins.ts` — `HOOK_EVENTS = ["PreToolUse", "PostToolUse", "Stop"]`
  (~línea 63): el enum Zod es la ÚNICA compuerta; `pluginHooksToClaudeShape`
  (`build-settings.ts:528`) es genérica sobre `h.event`, así que agregar `"SessionStart"`
  al enum fluye solo al settings. El deep-merge coalesce buckets por matcher
  (`build-settings.ts:323-327`).
- Codex **ignora** `manifest.hooks` por completo (`build-config-toml.ts` hardcodea sus
  propios `[[hooks.PreToolUse]]`; cero lectores de hooks de plugin) — R7 no lo toca.
- Scripts de plugin: `scripts[].{src,dest,exec}` → `.claude/scripts/<dest>`, con expansión
  de `# navori:include <partial>` (`engines/claude/index.ts:1624`, partials en
  `core-assets/hooks/_partials/`) e interpolación `{{shq:<configKey>}}` (patrón completo en
  `packages/plugins/jscpd/scripts/check-jscpd.sh`).
- Inyecciones `skills[].injectInto`: sub-bloque managed APPENDED al archivo destino
  (`engines/claude/index.ts:821-870` render, `1373-1470` mecánica, reconciliación de
  deshabilitados en `858-870`) — codegraph inyecta hoy a `structural-search/SKILL.md` +
  `researcher/explorer/implementer/reviewer.md`: espejo exacto para tgrep.
- Bundling 100% dinámico: `copy-assets.mjs` hace readdir de `packages/plugins/*`;
  `listBundledPluginIds()` (bundled-assets.ts:241) también — un directorio nuevo con
  `plugin.json` + `package.json` se auto-empaqueta, sin registro manual.
- `navori add <id>` (`add.ts:145-230`): habilita en config → `hasBinary(checkBinary)` →
  confirm → `runShellCommand(install[platform])` → `postInstall` → outro "corre render".
  Sin install command para la plataforma → warn limpio (`ta.noInstallCommand`).
- `navori doctor`: `scanMissingExternalTools` (doctor.ts:1181) warn con install por
  plataforma (impreso en 536-543 vía i18n `td.externalTools`); `invariants` del manifest se
  verifican verbatim contra el render.
- SessionStart core hook emite JSON `hookSpecificOutput.additionalContext`
  (`session-start-context.sh:209-215`); C1 permite al hook del plugin usar stdout plano —
  ambos conviven en el mismo bucket de settings.
- Gate de suite: `hook-claims-vs-scripts.test.ts` verifica condiciones necesarias entre
  prosa y capacidad real del script (redactar los claims de la doctrina con precisión);
  `check-coverage-floor.mjs` con `KNOWN_ZERO` caza módulos TS nuevos sin tests.
- Permisos actuales: 105 allow / 28 ask / 136 deny; los MCP del harness ya van por allow.

## Approach

**Un solo punto de entrada con fallback interno.** Toda búsqueda de contenido va por
`.claude/scripts/tgrep-search.sh`; el wrapper decide el motor (tgrep → rg → grep) por
presencia de binario, re-indexa antes de buscar (H3 lo hace obligatorio, H5 lo hace
gratis) y preserva el contrato de exit codes. Esto resuelve de raíz el problema de C2
(subagentes sin contexto de sesión): la decisión del motor NO depende de la atención ni
del contexto del modelo — el mismo comando es correcto en cualquier agente, modo y máquina.

**Default por doctrina + allow, no por reemplazo de tool** (el `Grep` nativo no es
pluggable). La regla `allow` hace la vía promptless en los cinco modos; los bloques managed
la declaran primera opción en los cuatro puntos de decisión (R11) sin contradecir a
`operaciones-seguras.md` (R12).

**Sinergia codegraph↔tgrep = ruteo, no competencia.** codegraph responde
símbolo/estructura/impacto (y su FTS5 busca símbolos); tgrep responde texto
literal/regex. La doctrina fija: conceptual → grafo primero; literal → wrapper directo;
la hipótesis del grafo se VERIFICA con el wrapper (hoy dice "Grep/Read"). Sin hook
router PreToolUse: sería costo en cada Bash call para un empujón que la doctrina ya da
(descartado, ver NOT in scope).

**Descartado — `tgrep serve` en v1** (H10): daemon TCP sin auth y bind sin documentar no se
despliega al parque; el reindex-per-search de H5 da la misma frescura sin daemon. Serve
queda como optimización v2 gated en leer el bind en el fuente de tgrep.

**Descartado — allowlistear `rg`/`grep` directos**: el fallback corre dentro del proceso
del wrapper (ya autorizado); `rg --pre` ejecuta comandos arbitrarios por archivo y es la
razón vigente de su exclusión.

## Components

- `packages/plugins/tgrep/plugin.json` — manifest (R7-R11, R14). Campos exactos:
  `id: "tgrep"`, `externalTool: { name: "tgrep", checkBinary: "tgrep", install: { darwin:
  "brew install tgrep", linux: "brew install tgrep" } }` (win32 omitido a propósito →
  R10), `settingsFragment.permissions.allow: ["Bash(bash .claude/scripts/tgrep-search.sh
  *)", "Bash(tgrep *)"]`, `scripts: [tgrep-search.sh, tgrep-session.sh]`, `hooks:
  [{ event: "SessionStart", command: "bash \"$CLAUDE_PROJECT_DIR/.claude/scripts/tgrep-session.sh\"", timeout: 30, statusMessage: "navori/tgrep: search index" }]`,
  `managed: [tgrep-protocol]`, `skills: [rung + 4 agentes]`, `invariants:
  ["tgrep-search.sh"]`. Sin `postInstall` (el hook calienta el índice por sesión; un
  postInstall solo cubriría la máquina que corrió `add`).
- `packages/plugins/tgrep/scripts/tgrep-search.sh` — el wrapper (R1-R6). Contrato:
  `tgrep-search.sh <args-de-busqueda…>` con passthrough verbatim de `"$@"` al motor; añade
  `--index-path` solo en la vía tgrep. Raíz = `git rev-parse --show-toplevel` (fallback
  `$PWD`); clave de cache = hash sha-256 de la raíz absoluta (`shasum -a 256` con fallback
  `sha256sum`, primeros 16 hex — rutas con espacios quedan fuera del filesystem del cache);
  índice en `${XDG_CACHE_HOME:-$HOME/.cache}/navori/tgrep/<clave>`. Vía tgrep: reindex
  silencioso → si falla, búsqueda con `--no-index` (R2). Sin tgrep: `command -v rg` →
  `exec rg "$@"` precedido de la línea de aviso a stderr (R4); sin rg → `grep -rn` con los
  args posicionales (patrón y paths) y aviso igual. `set -euo pipefail` excepto alrededor
  de la búsqueda (exit 1 = sin match NO es error). Sin includes de audit (no es hook).
- `packages/plugins/tgrep/scripts/tgrep-session.sh` — hook SessionStart (R8). stdout plano,
  UNA línea; con binario: dispara el warm del índice (mismo cómputo de cache-key que el
  wrapper, extraído con cuidado de no duplicar la lógica: el warm ES `tgrep index` con los
  mismos parámetros) y emite "tgrep ACTIVO — búsqueda de contenido va por
  .claude/scripts/tgrep-search.sh"; sin binario: "tgrep NO instalado (brew install tgrep) —
  búsqueda por Grep nativo / fallback del wrapper". Exit 0 SIEMPRE (nunca bloquear el
  arranque); el warm con timeout defensivo para no colgar la sesión.
- `packages/plugins/tgrep/managed/tgrep-protocol.md` — doctrina CLAUDE.md (R11). Contenido:
  invocación canónica, tabla de ruteo codegraph↔tgrep, la regla de fallback (el wrapper
  decide, el agente no pregunta), el subset de flags seguro en ambos motores
  (`-i -l -c -n -F -w -e -g -A/-B/-C -m`), y los flags que NO usar por el wrapper
  (`--hidden`, `--no-ignore*` y `-a` bypassean el índice; `-t` difiere entre motores).
  **Corregido en T5 contra medición**: `-E/--encoding` NO bypassea el índice —
  `tgrep --stats -E auto <patrón>` sigue reportando `Query plan: AND(n trigrams)`,
  mientras que los otros tres caen a `Brute-force search`. La doctrina lista solo
  los tres verificados.
  Redactar claims con la precisión que `hook-claims-vs-scripts.test.ts` exige.
- `packages/plugins/tgrep/skills/tgrep-rung.md` — inyección a `structural-search/SKILL.md`
  (R11): "Rung 1 — ejecutor". Espejo del estilo de `codegraph-rung.md` (frontmatter
  name/description/type: behavior).
- `packages/plugins/tgrep/skills/tgrep-search-agent.md` y `tgrep-code-agent.md` —
  inyecciones a agentes (R11), espejo del par de codegraph (search → researcher/explorer;
  code → implementer/reviewer).
- `packages/cli/src/lib/plugins.ts` — `HOOK_EVENTS` gana `"SessionStart"` (R7) con el
  comentario de contrato actualizado (incluida la advertencia C2: no llega a subagentes).
- `packages/core/core-assets/managed/operaciones-seguras.md` — cláusula condicional en los
  bullets de las líneas 7 y 22 (R12).
- `packages/plugins/codegraph/` — resuelto por el experimento R13 a favor de la primera
  rama: manifest 0.0.2 + `McpServerSchema.alwaysLoad` + render en `.mcp.json`. La segunda
  (una línea de ToolSearch batcheado en `managed/codegraph-protocol.md`) NO se escribió, y
  eso es lo correcto por el hallazgo 1 de `evals.md`: la doctrina no era lo que faltaba.

## Decisions

- **Reindex-per-search en vez de daemon** — H3 (falsos negativos silenciosos) + H5 (0.07s)
  + H10 (serve sin auth/bind desconocido). La frescura es determinista y el costo es menor
  que un solo round-trip del clasificador.
- **Fallback dentro del wrapper, no en doctrina condicional** — C2: los subagentes no ven
  el contexto de SessionStart; un `if` en bash es infalible, un "si tgrep está activo…" en
  prosa depende de atención (la lección medida de codegraph: cableado perfecto, cero uso).
- **Cache fuera del repo** — H2 + el schema de plugins no sabe escribir `.gitignore`; a
  `~/.cache` no hay nada que ignorar ni que limpiar en 20 repos.
- **`Bash(bash .claude/scripts/tgrep-search.sh *)` como invocación canónica** — relativa a
  la raíz del repo (cwd estándar de los agentes), estable para el prefix-match de permisos,
  y sin depender de `$CLAUDE_PROJECT_DIR` en la línea de comando del agente (la
  interpolación de env en reglas allow no está garantizada).
- **La línea de aviso (R4) va en el wrapper Y el hook** — el hook cubre al humano al abrir
  sesión (una vez); el wrapper cubre al agente en el momento de uso (cada fallback). Doble
  canal porque los públicos son distintos; ninguno es nag (una línea cada uno).
- **codegraph NO gana hook de SessionStart** — su watcher + catch-up al reconectar (doc
  oficial) ya mantienen el grafo fresco; un hook duplicaría el mecanismo del propio tool.
  La sinergia es de ruteo (doctrina), no de infraestructura.

## Failure modes

- **tgrep se desinstala a media sesión** → el wrapper re-evalúa `command -v` en cada
  invocación: la siguiente búsqueda cae a rg con aviso. Sin estado cacheado de la decisión.
- **Index corrupto o cache no escribible** → R2: `--no-index` para ESA búsqueda (scan
  completo, correcto y más lento); el wrapper no borra ni repara el cache en v1.
- **Timeout del hook SessionStart** (repo enorme, primer build) → C3/doc: un hook con
  timeout no bloquea; la sesión arranca sin la línea y el wrapper indexa en la primera
  búsqueda. `timeout: 30` en el manifest es techo generoso (H5: 0.07s medido).
- **Dos sesiones paralelas sobre el mismo repo** → ambas re-indexan al mismo cache path;
  tgrep escribe el índice de forma atómica o falla → la vía R2 (`--no-index`) absorbe la
  colisión. Verificarlo es parte de T4 (test de concurrencia simple: dos index simultáneos
  no dejan el cache en estado que rompa la búsqueda siguiente).
- **Worktrees de agente** (`.claude/worktrees/`) → `git rev-parse --show-toplevel` resuelve
  al worktree, cuya raíz produce OTRA clave de cache → índice propio, correcto por
  construcción (indexa lo que ese árbol ve).

## Testing strategy

Cada test responde un riesgo nombrado arriba; los archivos y casos exactos van en
`tasks.md`. Riesgos → tests: paridad de motores (H6→T4), falsos negativos por staleness
(H3→T4, el test central: editar tras indexar y exigir el hit), triple fallback y exit
codes (R3→T4), espacios en rutas (R6→T4, fixture con espacio en el nombre), enum de hooks
y mapeo a settings (R7→T1), render completo del plugin — sub-bloques, allow, hook,
invariants (R11/R14→T6), reversibilidad (R15→T6), claims vs capacidades
(`hook-claims-vs-scripts` corre en la suite y debe seguir verde con la prosa nueva).

## NOT in scope

- **`tgrep serve` / watch mode** — v2, gated en verificar el bind address en el fuente
  (H10). El diseño v1 no deja deuda: el wrapper es el único punto a cambiar.
- **Wrapper MCP sobre el JSON-RPC de tgrep** — la jugada estructural mayor (familia
  `mcp__tgrep__*` sin Bash), fuera hasta que exista serve seguro.
- **Hook router PreToolUse que intercepte grep/rg shell** — costo en CADA Bash call para
  un empujón que la doctrina da; re-evaluar solo si el audit post-rollout muestra que el
  wrapper no se usa (misma vara de evidencia que #597).
- **Retención/limpieza del cache `~/.cache/navori/tgrep`** — índices de 6M por repo;
  irrelevante hoy. Si crece, es un `doctor --fix` futuro.
- **Paridad codex** — codex no consume hooks de plugin ni `settingsFragment` de permisos
  Claude; el wrapper y la doctrina managed le llegan por sus propias superficies cuando
  su adapter los soporte (drift ya conocido de paridad de skills, spec 0004).
- **Activación profunda de codegraph** (hooks de empujón, métricas por agente) — esta spec
  solo toma R13; lo demás espera evidencia del audit post-0017.
