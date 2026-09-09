# Capa de búsqueda indexada (tgrep + codegraph) — Requirements

## Context

Microsoft publicó [`tgrep`](https://github.com/microsoft/tgrep) (Rust, MIT): grep con índice
de trigramas y superficie de flags compatible con ripgrep. Ulises lo instaló (`brew install
tgrep`, v1.0.5 verificada) y decidió incorporarlo como plugin de navori: **cuando el binario
existe es el método default de búsqueda de contenido en todos los flujos y modos; cuando no
existe, el harness sigue con el método actual sin degradarse**. Además: el harness debe
mostrarle al usuario, en algún punto natural, que sin los plugins está en la ruta lenta.

Dos restricciones estructurales que esta spec verificó ANTES de diseñar:

1. **El tool nativo `Grep` no es pluggable** — Claude Code trae ripgrep embebido y no expone
   backend alternativo. "tgrep como default" solo puede lograrse por la otra vía: regla
   `allow` para que corra sin prompt ni clasificador en todos los modos, más doctrina managed
   que lo declare primera opción. Es el mismo mecanismo con el que codegraph es hoy "primera
   llamada".
2. **Los hooks de `SessionStart` NO corren para subagentes** (doc oficial de hooks,
   verificada 2026-09-08). Cualquier detección de tgrep que viva solo en el contexto de
   sesión es invisible para `researcher`/`explorer`/`implementer`/`reviewer`. Por eso el
   fallback vive DENTRO del wrapper script, no en la atención del modelo.

Y un hecho empírico que gobierna el diseño (fixture controlado, tgrep 1.0.5, 2026-09-08):
**un índice stale produce falsos negativos SILENCIOSOS** — contenido nuevo en archivo ya
indexado y archivos nuevos post-index salen `exit 1` sin warning, indistinguible de "no hay
match". El reindex completo midió 0.07s en el repo más grande del parque (bonum-webapp,
793 archivos de texto). Conclusión: re-indexar antes de cada búsqueda no es preferencia,
es requisito de correctitud y es barato.

La spec también absorbe dos pedidos de la misma conversación: (a) sinergia
codegraph↔tgrep — son capas complementarias (codegraph: símbolo/estructura/blast-radius;
tgrep: texto literal/regex) y la doctrina debe enrutar entre ellas, no dejarlas competir;
(b) auditar si el harness usa codegraph de forma óptima contra su doc oficial — hallazgo:
las sesiones medidas por `navori audit` registran cientos de búsquedas shell y **cero**
queries al grafo, y el tool MCP arranca diferido (paga un `ToolSearch` antes del primer
uso), fricción que la doc oficial de codegraph recomienda eliminar con `alwaysLoad: true`
— campo que la doc de Claude Code solo documenta para servers http/sse/ws, así que exige
verificación empírica antes de renderizarse (R13).

Público: todo repo que renderice el harness navori. Motor primario: Claude Code; codex no
consume hooks de plugin (verificado en `build-config-toml.ts`) y no se ve afectado.

## Requirements (EARS)

### El wrapper (correctitud del default + fallback)

- **R1** — WHEN el binario `tgrep` está en PATH, el wrapper `.claude/scripts/tgrep-search.sh`
  SHALL ejecutar la búsqueda vía tgrep con índice de trigramas, y su lista de resultados
  SHALL ser idéntica a la de `rg` para el mismo patrón y raíz (paridad verificada por md5 de
  listas de archivos en esta investigación).
- **R2** — El wrapper SHALL re-indexar (`tgrep index <root> --index-path <cache>`) ANTES de
  cada búsqueda, porque un índice stale produce falsos negativos silenciosos (hecho
  empírico del Context). IF el re-index falla THEN el wrapper SHALL degradar esa búsqueda a
  `tgrep --no-index` (scan completo, sin índice) en lugar de fallar o arriesgar un falso
  negativo.
- **R3** — IF `tgrep` NO está en PATH THEN el wrapper SHALL caer a `rg` con los mismos
  argumentos, e IF `rg` tampoco está THEN a `grep -rn`, preservando el contrato de exit
  codes (0 = match, 1 = sin match) hacia el llamador en las tres vías.
- **R4** — WHEN el wrapper cae a un fallback (R3), it SHALL emitir a stderr UNA línea que
  nombre el motor usado y el comando de instalación de tgrep — la señal en sesión de "estás
  en la ruta lenta" que pidió el usuario, visible tanto para el agente como en el transcript.
- **R5** — El índice SHALL vivir fuera del repo, bajo
  `${XDG_CACHE_HOME:-$HOME/.cache}/navori/tgrep/<clave-estable-por-repo>`; el wrapper SHALL
  NOT crear archivos dentro del working tree (verificado: tgrep sin `--index-path` busca
  `.tgrep/` en el repo — el wrapper siempre pasa `--index-path`).
- **R6** — El wrapper SHALL funcionar con rutas de repo que contienen espacios (el propio
  workspace de Ulises es `Dev - Docs/…`) y desde cualquier cwd dentro del repo (resuelve la
  raíz con `git rev-parse --show-toplevel`, con fallback a `$PWD` fuera de git).

### El plugin (contrato navori)

- **R7** — El sistema SHALL aceptar `"SessionStart"` como evento válido en `hooks[]` del
  manifest de plugin (`HOOK_EVENTS` en `plugins.ts`), y el adapter claude SHALL mapearlo al
  bucket `hooks.SessionStart` de `.claude/settings.json` por la misma vía genérica
  (`pluginHooksToClaudeShape`) que los eventos existentes. El adapter codex SHALL seguir
  ignorando hooks de plugin sin error (comportamiento actual, ahora cubierto por test).
- **R8** — WHEN una sesión inicia con el plugin `tgrep` habilitado, el hook de SessionStart
  SHALL emitir por stdout plano (contrato documentado de Claude Code para SessionStart)
  exactamente UNA línea: con binario presente, que tgrep está activo como default de
  búsqueda; sin binario, que no está instalado con su comando de instalación. El hook SHALL
  salir 0 en todos los caminos (nunca bloquea el arranque) y, con binario presente, SHALL
  construir/calentar el índice para que la primera búsqueda no pague el build inicial.
- **R9** — El plugin SHALL declarar en `settingsFragment.permissions.allow` las reglas que
  hacen la vía promptless en TODOS los modos (`default`, `acceptEdits`, `plan`, `auto`,
  `dontAsk`): la invocación canónica del wrapper y el binario directo (`Bash(tgrep *)`).
  El manifest SHALL NOT allowlistear `rg` ni `grep` (el fallback corre DENTRO del proceso
  del wrapper, ya autorizado; `rg --pre` sigue siendo la razón por la que `rg` directo no
  se pre-aprueba).
- **R10** — `navori doctor` SHALL reportar el binario faltante con su comando de
  instalación vía el mecanismo existente (`scanMissingExternalTools`), e `navori add tgrep`
  SHALL ofrecer instalarlo (mecanismo existente de `externalTool.install`); el manifest
  SHALL declarar `checkBinary: "tgrep"` e install por plataforma con los métodos
  oficialmente documentados (brew para darwin/linux; win32 sin comando → warn limpio ya
  implementado en `add.ts`).

### Doctrina (default en todos los flujos + sinergia)

- **R11** — El plugin SHALL entregar doctrina managed que declare al wrapper como default
  de búsqueda de contenido cuando tgrep existe, en los CUATRO puntos donde hoy se decide
  cómo buscar: bloque de protocolo en `CLAUDE.md`, inyección de rung en
  `structural-search/SKILL.md` (ejecutor del Rung 1), e inyecciones a los agentes
  `researcher`, `explorer`, `implementer` y `reviewer` (mismo mecanismo `injectInto` que
  codegraph). La doctrina SHALL incluir la tabla de ruteo codegraph↔tgrep: pregunta
  conceptual/símbolo/impacto → codegraph primero; token literal/regex/copy → wrapper; la
  hipótesis del grafo se verifica con el wrapper, nunca con un segundo query al grafo.
- **R12** — Los dos bullets de `operaciones-seguras.md` que hoy fijan la preferencia de
  búsqueda ("Code search" y "searching is not shell work") SHALL ganar la cláusula
  condicional que cede el default al wrapper cuando el plugin tgrep está habilitado, de
  modo que ningún bloque managed contradiga a otro en el render final.

### Codegraph (optimización auditada)

- **R13** — El sistema SHALL resolver la fricción de arranque de codegraph por una de dos
  vías, decidida por verificación empírica (la doc de Claude Code no documenta `alwaysLoad`
  para stdio): IF `alwaysLoad: true` en la entrada stdio de `.mcp.json` hace que los tools
  `mcp__codegraph__*` arranquen no-diferidos THEN `McpServerSchema` gana el campo opcional,
  el render lo emite y el manifest de codegraph lo declara (bump 0.0.2); ELSE el bloque
  `codegraph-protocol.md` SHALL instruir cargar el tool vía UN `ToolSearch` batcheado al
  primer uso de sesión, citando el hallazgo del audit (cientos de búsquedas shell, cero
  queries al grafo) como razón.

### Guardas

- **R14** — WHILE el plugin tgrep está habilitado, el render SHALL contener los invariantes
  verbatim del manifest (al menos `tgrep-search.sh`), y `navori doctor` SHALL fallar si un
  refactor de assets se los come (mecanismo existente de `invariants`).
- **R15** — La adopción SHALL ser reversible por el flujo estándar: `navori remove tgrep` +
  render deja el harness sin rastros del plugin (sub-bloques `injectInto` y scripts
  huérfanos incluidos, vía la reconciliación existente de plugins deshabilitados).
