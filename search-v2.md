# Search v2 — plan de implementación desde cero

**Estado:** especificación lista para implementar después de terminar la limpieza en la otra sesión. Este documento NO afirma que la integración ni sus pruebas estén implementadas.

**Entrega actual:** sólo este archivo. No instalar, indexar, regenerar el harness ni modificar código como parte de escribir el plan.

**Objetivo:** Navori genera un routing por intención: estructura → CodeGraph MCP; texto → Microsoft tgrep CLI; paths → Glob; archivo y alcance conocidos → Read/Edit; contexto suficiente → ninguna búsqueda; correctness → compilador/linter/tests. Minimizar exploración repetida sin sacrificar evidencia.

## 1. Alcance y decisiones cerradas

| ID | Decisión obligatoria |
| --- | --- |
| D01 | Integración reutilizable en el generador Navori, no un parche exclusivo de `.claude/` local. |
| D02 | Implementación greenfield. No recuperar wrappers, hooks, tests ni protocolos de la integración retirada. Reutilizar únicamente infraestructura genérica del generador. |
| D03 | Claude Code es el host funcional de v1. Los demás engines deben mantener sus contratos de render; no prometer validación funcional de agentes en esos hosts. |
| D04 | Dos plugins independientes y opt-in: `codegraph` y `tgrep`. Ausente o `enabled: false` significa desactivado. No habilitarlos en todos los presets. |
| D05 | CodeGraph usa MCP stdio con una herramienta: `codegraph_explore`. No añadir MCP de tgrep. |
| D06 | CodeGraph lleva `alwaysLoad: true`, por disponibilidad temprana. No cambiar `ENABLE_TOOL_SEARCH` globalmente. Medir costo de startup y contexto; no declararlo gratuito. |
| D07 | Establecer `CODEGRAPH_MCP_TOOLS=explore` para que un entorno heredado no amplíe la superficie; `CODEGRAPH_EXPLORE_DEDUP=0` para evitar omitir source que otro contexto aislado no vio. |
| D08 | tgrep usa el subcomando oficial `search`, con flags antes de `--` y raíz explícita. Permitir ese subcomando, no `Bash(tgrep *)`. |
| D09 | tgrep server se inicia explícitamente en terminal persistente. Navori no crea supervisor, PID manager, auto-start ni hooks de lifecycle. |
| D10 | Setup e indexación son acciones explícitas. `render`, `sync` del harness y `doctor` no instalan herramientas, crean índices ni arrancan servidores. |
| D11 | No crear agentes-wrapper, router ejecutable, parser de prompts, interceptores PreToolUse ni contador de cuotas de búsquedas. |
| D12 | Política compuesta por un bloque universal del core y una extensión breve por plugin. No agregar motor de templates/condiciones ni duplicar la política completa en cada agente. |
| D13 | Mantener los agentes, reviews, gates y protocolos de seguridad existentes. Optimizar discovery no autoriza saltarse implementer/reviewer o el flujo de commits. |
| D14 | Una raíz de índice por checkout Git de Navori; no un índice por paquete. Un worktree es otro checkout, no comparte índices mediante symlinks. |
| D15 | No activar Git sync hooks ni el prompt hook del instalador de CodeGraph. No ejecutar `codegraph install` desde Navori. |
| D16 | Tests unitarios/render en CI normal; pruebas de binarios y Claude reales en verificación explícita separada. La entrega no es completa si las pruebas externas requeridas no se ejecutaron. |

**Versiones observadas al preparar el plan:** macOS arm64, CodeGraph `1.6.0`, tgrep `1.0.8`, Claude Code `2.1.267`. Son la referencia verificable, no una afirmación de compatibilidad con cualquier versión futura. Reusar esas versiones si siguen instaladas. No actualizar ni degradar binarios globales automáticamente. Una versión diferente debe pasar el mismo contrato de pruebas antes de declararse soportada.

## 2. Hallazgos y fuentes que determinan el diseño

### 2.1 Navori inspeccionado

El árbol inspeccionado todavía contiene la integración anterior; otra sesión la está retirando. Los paths siguientes identifican responsabilidades del generador, no autorización para restaurar su contenido anterior.

| Fuente local | Hecho confirmado / consecuencia |
| --- | --- |
| `docs/DIRECTION.md`, `docs/EXTENDING.md` | Navori genera harnesses; las herramientas externas corresponden a plugins. No convertir el CLI en executor de búsquedas. |
| `packages/cli/src/lib/plugins.ts` | Existen `managed`, `mcpServer`, `settingsFragment`, `externalTool`, `skills[].injectInto`. No se necesita un nuevo schema público. |
| `packages/cli/src/lib/render-plan.ts` | Registra bloques core y compone bloques de plugins. Reusar marcadores, versiones y preservación de texto manual. |
| `packages/cli/src/engines/claude/index.ts` | Registra MCP, aplica subbloques a agentes y reconcilia plugins desactivados. |
| `packages/cli/src/engines/claude/agent-mcp-tools.ts` | Una allowlist `tools:` necesita el grant MCP, además del permiso en settings. |
| `packages/cli/src/engines/claude/frontmatter-merge.ts` | Conserva entradas MCP añadidas en destino; desactivar un plugin requiere probar que no quede un grant suyo huérfano. |
| `packages/cli/src/engines/shared/gitignore-harness.ts` | `gitignoreHarness: off` significa que render NO toca `.gitignore`. El dogfood observado utiliza `off`. |
| `packages/cli/scripts/copy-assets.mjs` | El build copia assets a `dist/assets`; modificar fuentes sin rebuild puede producir un render engañosamente viejo. |
| `packages/core/core-assets/skills/structural-search.md` | La escalera previa Grep → AST y la confirmación obligatoria de punteros pueden competir con routing por intención. Reemplazar esa doctrina, no agregar otra escalera al final. |
| `CONTRIBUTING.md` | Assets modificados obligan a regenerar espejo y golden; gate final `pnpm check`; docs de repositorio solamente requieren lint y format check. |

### 2.2 Evidencia oficial y discrepancias resueltas

| ID | Fuente primaria | Uso en este plan |
| --- | --- | --- |
| S01 | [CodeGraph README v1.6.0](https://github.com/colbymchenry/codegraph/blob/v1.6.0/README.md) | Instalación CLI, init, configuración zero-config, exclusiones y comandos de diagnóstico. |
| S02 | [CodeGraph server-instructions v1.6.0](https://github.com/colbymchenry/codegraph/blob/v1.6.0/src/mcp/server-instructions.ts) | Source verbatim, banners stale, best-effort estructural y proyectos sin índice. |
| S03 | [CodeGraph tools v1.6.0](https://github.com/colbymchenry/codegraph/blob/v1.6.0/src/mcp/tools.ts) | `DEFAULT_MCP_TOOLS`, schema real y `projectPath` requerido cuando no hay proyecto predeterminado. |
| S04 | [CodeGraph dedup v1.6.0](https://github.com/colbymchenry/codegraph/blob/v1.6.0/src/mcp/explore-dedup.ts) | Dedup activado por defecto en esa versión; `CODEGRAPH_EXPLORE_DEDUP=0` lo desactiva. |
| S05 | [CodeGraph installer v1.6.0](https://github.com/colbymchenry/codegraph/blob/v1.6.0/src/installer/index.ts) | El instalador puede escribir configuraciones globales y ofrecer/activar un prompt hook. Evitarlo como postInstall del plugin. |
| S06 | [Referencia MCP actual](https://github.com/colbymchenry/codegraph/blob/main/site/src/content/docs/reference/mcp-server.md), [CHANGELOG](https://github.com/colbymchenry/codegraph/blob/main/CHANGELOG.md) | Una tool por defecto e historia de instrucciones para subagentes. La referencia contiene una descripción obsoleta de ausencia de índice: prevalecen S02/S03 y el smoke real. |
| S07 | [tgrep README v1.0.8](https://github.com/microsoft/tgrep/blob/v1.0.8/README.md) | Instalación y flags. |
| S08 | [tgrep AGENTS](https://github.com/microsoft/tgrep/blob/main/AGENTS.md) | Selección server/disco/scan, freshness, output y códigos de salida. |
| S09 | [tgrep CLI](https://github.com/microsoft/tgrep/blob/main/tgrep-cli/src/main.rs) | `Command::Search` usa la misma búsqueda que la forma abreviada; confirmado también con `tgrep search --help` local. |
| S10 | [Claude MCP](https://code.claude.com/docs/en/mcp) | `.mcp.json`, Tool Search, `alwaysLoad` y costo de cargar upfront. |
| S11 | [Claude subagents](https://code.claude.com/docs/en/sub-agents#what-loads-at-startup) | Contexto aislado; custom agents heredan CLAUDE.md salvo `omitClaudeMd`; Explore/Plan nativos lo omiten. |
| S12 | [Claude memory](https://code.claude.com/docs/en/memory), [skills](https://code.claude.com/docs/en/skills), [settings](https://code.claude.com/docs/en/settings) | Ubicación de instrucciones y evitar otra copia en rules/skills/hooks. |
| S13 | [Claude permissions](https://code.claude.com/docs/en/permissions) | Allowlist por subcomando y separación entre tools y permisos. Un permiso de Bash no es sandbox de paths. |
| S14 | [Claude programático](https://code.claude.com/docs/en/headless) | Captura `stream-json`, tool_use/tool_result y resultados de subagentes. |
| S15 | [CodeGraph MCP lifecycle](https://github.com/colbymchenry/codegraph/blob/v1.6.0/src/mcp/index.ts) | `CODEGRAPH_NO_DAEMON=1` permite procesos directos controlables en tests; no añadirlo al plugin de producción. |
| S16 | [MCP stdio](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports) | JSON-RPC delimitado por líneas para el smoke de protocolo, no para crear otro MCP. |

Reglas para el implementador:

- La tool puede estar visible aunque el proyecto no esté indexado. No escribir un test que exija `tools/list = []` cuando no hay `.codegraph/`.
- La evidencia estructural no certifica todas las relaciones dinámicas. Un resultado vacío no demuestra ausencia de comportamiento.
- Source ya leído significa recibido por **este contexto** y suficientemente vigente; no basta que otro subagente lo haya visto.
- `status` de tgrep no certifica que la última edición esté indexada.
- No fijar una espera de un segundo como garantía de freshness. Los tests esperan una condición observable con deadline.
- Conservar fuentes/versiones en el reporte de implementación. Ante una incompatibilidad nueva, documentar el fallo de contrato; no inventar flags ni debilitar el test para cerrar.

## 3. Contratos de archivos, configuración y ownership

### 3.1 Archivos fuente a crear

| Path | Contenido / responsabilidad |
| --- | --- |
| `packages/core/core-assets/managed/code-discovery-routing.md` | Política universal de §4.1. |
| `packages/plugins/codegraph/package.json` | Paquete workspace `@navori/plugin-codegraph`, versión inicial `0.0.1`, type module, exports `./package.json` y `./plugin.json`, files `plugin.json`, `managed`, `skills`; Node `>=22`. |
| `packages/plugins/codegraph/plugin.json` | Manifest exacto de §3.2, con siete injectInto. |
| `packages/plugins/codegraph/managed/codegraph-search-v2.md` | Extensión estructural de §4.2. |
| `packages/plugins/codegraph/skills/codegraph-access-v2.md` | Fragmento único reutilizado para acceso MCP a agentes, §4.4. |
| `packages/plugins/tgrep/package.json` | Paquete workspace `@navori/plugin-tgrep`, misma estructura base, files `plugin.json`, `managed`. |
| `packages/plugins/tgrep/plugin.json` | Manifest de §3.3; sin scripts/hooks/skills/MCP. |
| `packages/plugins/tgrep/managed/tgrep-search-v2.md` | Extensión textual de §4.3. |
| `docs/recipes/search-v2.md` | Runbook operativo de §6, no se inyecta al contexto. |
| `scripts/search-v2/` | Sólo harness de pruebas externas descrito en §8. No se empaqueta como runtime del producto. |

No editar los outputs `.claude/` a mano. Los changes al espejo se producen mediante `pnpm render:apply` después de cambiar fuentes.

### 3.2 Manifest CodeGraph

Campos obligatorios (no agregar `postInstall`):

```json
{
  "id": "codegraph",
  "name": "CodeGraph structural discovery",
  "description": "Structural code discovery through the CodeGraph MCP server",
  "version": "0.0.1",
  "managed": [
    { "id": "codegraph-search-v2", "file": "managed/codegraph-search-v2.md" }
  ],
  "externalTool": {
    "name": "codegraph",
    "checkBinary": "codegraph",
    "install": {
      "darwin": "npm install -g @colbymchenry/codegraph@1.6.0",
      "linux": "npm install -g @colbymchenry/codegraph@1.6.0",
      "win32": "npm install -g @colbymchenry/codegraph@1.6.0"
    }
  },
  "mcpServer": {
    "command": "codegraph",
    "args": ["serve", "--mcp"],
    "env": {
      "CODEGRAPH_MCP_TOOLS": "explore",
      "CODEGRAPH_EXPLORE_DEDUP": "0"
    },
    "alwaysLoad": true
  },
  "settingsFragment": {
    "permissions": {
      "allow": ["mcp__codegraph__codegraph_explore"]
    }
  },
  "invariants": ["codegraph_explore", "projectPath"]
}
```

A este objeto agregar `skills` con siete entradas, una por `leader`, `explorer`, `researcher`, `implementer`, `reviewer`, `auditor`, `ticket-audit`:

```json
{
  "id": "codegraph-access-v2-explorer",
  "file": "skills/codegraph-access-v2.md",
  "injectInto": ".claude/agents/explorer.md"
}
```

Sustituir únicamente el sufijo del id y el nombre del archivo destino en cada entrada. No inyectar en `commit-pr-pilot`; no convertir `leader` en subagente invocable.

Reusar `withAgentMcpTools` para el grant `mcp__codegraph__*` en `tools:`. Ese grant de acceso al servidor **no** amplía las herramientas expuestas: sólo se lista explore y sólo explore tiene permiso de ejecución automático. No cambiar el helper genérico para enumerar herramientas a partir de `invariants`.

### 3.3 Manifest tgrep

```json
{
  "id": "tgrep",
  "name": "Microsoft tgrep textual discovery",
  "description": "Textual code discovery through the tgrep CLI",
  "version": "0.0.1",
  "managed": [
    { "id": "tgrep-search-v2", "file": "managed/tgrep-search-v2.md" }
  ],
  "externalTool": {
    "name": "tgrep",
    "checkBinary": "tgrep",
    "install": { "darwin": "brew install tgrep" }
  },
  "settingsFragment": {
    "permissions": {
      "allow": ["Bash(tgrep search *)", "Bash(tgrep status *)", "Bash(tgrep --version)"]
    }
  },
  "invariants": ["tgrep search", "--no-index"]
}
```

Linux/Windows: instalación manual por releases o build oficial documentado en S07, sin inventar un bootstrap en el manifest. No se bloquea el render porque el binario falte. No otorgar permisos a `serve`, `index`, package managers o comandos de mantenimiento; son setup explícito.

No usar `Bash(tgrep -*)`: mezcla búsqueda con una superficie no delimitada. No afirmar que `Bash(tgrep search *)` impide leer fuera del repo; los límites de datos siguen dependiendo de las políticas/sandbox del host. Una negativa de permisos por seguridad no se elude cambiando de herramienta.

### 3.4 Registro y generación

1. Registrar ambos paquetes en `KNOWN_PLUGINS` y como workspace devDependencies del CLI. Regenerar lockfile con `pnpm install`; no usar `--no-frozen-lockfile` como parche en CI.
2. Registrar el bloque core en `CORE_MANAGED_ASSETS` con id `code-discovery-routing`, relPath correspondiente, `baseLanguage: "en"`, `rootOnly: true`. Sin `audience: orchestrator`: debe llegar también a custom subagents. Declarar `globalSafe: true` porque no cita paths del repo, ni nombres de agentes propios, ni requiere config; **no** agregarlo al baseline global seleccionado por defecto.
3. Los bloques de plugin se componen por `managed[]`; ausente/desactivado no deja instrucciones de una herramienta inexistente. No crear un tercer plugin `search` ni un campo nuevo de configuración.
4. Respetar el mapeo actual de otros engines. El core universal puede renderizar en todos; Codex conserva el contrato MCP genérico que ya implementa y no recibe `alwaysLoad` en TOML. Los prose engines mantienen omisión de bloques de plugins y warnings existentes. No agregar adapters en v1.
5. Mantener `omitClaudeMd` ausente/false en los agentes Navori. La política completa vive en CLAUDE.md; el fragmento por agente sólo vincula su responsabilidad y habilita el grant. No sumar otra copia en `.claude/rules/`, SessionStart o skills preload.
6. Actualizar inventarios declarativos que el proyecto verifica: features/plugins, catálogo de plugins, golden config con ambos plugins y docs de extensibilidad. Derivar el conteo de las carpetas presentes después de la limpieza, no copiar el número anterior.
7. No reaprovechar ids de bloques retirados. Si la limpieza registró `codegraph`/`tgrep` en `RETIRED_PLUGINS`, quitar sólo esas entradas al reintroducir sus manifests y conservar ids antiguos en el registro de bloques retirados; los nuevos ids `*-v2` nunca deben estar en un registro de purga. Probar este caso. No reintroducir migraciones de scripts viejos.

### 3.5 Desactivación y conflictos

- Probar `enabled: true → false → true`, y `navori remove` seguido de render. Retirar entry MCP, permisos managed, extensiones de routing y subbloques propios. No borrar índices ni parar procesos: son datos/runtime del usuario.
- Antes de retirar un subbloque v2 de un agente, usar su marcador intacto como evidencia de propiedad del grant generado. Eliminar sólo el token exacto `mcp__codegraph__*` que añadió ese subbloque, y sólo si ningún plugin activo todavía lo requiere. Preservar todos los grants de otros servidores y tokens personalizados. Si el bloque fue alterado manualmente o es de versión más nueva, conservarlo y reportar conflicto, no forzar.
- Implementar esa reconciliación en el helper genérico de agentes y la fase de plugin disable, con tests de regresión; no hacer replace global de `mcp__` ni tocar el contrato de frontmatter de todos los agentes.
- Un MCP de otro nombre o una regla `deny`/`ask` del usuario se conserva. Una entry llamada `codegraph` pasa a ser la clave reservada del plugin al habilitarlo, conforme al contrato existente de registro por id; hacer visible el diff en preview y mantener backup. No borrar configuraciones globales ni eliminar aliases externos.
- Si el host carga otro CodeGraph global bajo un alias distinto, registrar el conflicto de doble proveedor y solicitar que el dueño retire/desactive ese alias. No escribir configuración global para resolverlo silenciosamente.
- No utilizar `--force` para hacer pasar aceptación; skipped/conflictos impiden afirmar que el dogfood está instalado correctamente.

## 4. Política persistente exacta y adaptación de agentes

Los tres bloques siguientes suman como máximo **350 palabras** de cuerpo managed. Medir con el helper `countWords` existente, excluyendo marcadores y frontmatter. Son tres unidades de ownership, una política lógica; esa composición evita un nuevo renderer condicional.

### 4.1 Core: `code-discovery-routing.md`

```markdown
## Code discovery routing

Choose by the missing information, not by keywords or a fixed tool sequence.
- Enough current evidence in this context: do not search.
- Known file and a bounded local change: Read/Edit directly. Knowing a path does not answer relationship or impact questions.
- Filename/path patterns: Glob.
- Behavior, definitions, architecture, relationships or impact: structural discovery.
- Strings, regex, comments, configuration or literal occurrences: textual discovery.
- Use the enabled provider below; otherwise use scoped native search and reading.
- Mixed tasks: locate the literal first when it is the entry clue; understand structure first when the entry clue is a feature. Add the second provider only for the unanswered dimension.
- Do not repeat successful discovery just to verify it. Read missing, stale or editor-required content only. Stop when evidence is sufficient.
- Validate changes with the project's compiler, linter and tests; discovery is not validation.
```

### 4.2 CodeGraph: `codegraph-search-v2.md`

```markdown
### Structural provider: CodeGraph

Use `codegraph_explore` for structural discovery when available. Pass the current checkout's absolute `projectPath`; do not substitute another worktree's index. Treat sufficient fresh verbatim source returned to this context as already read. Respect stale/disabled-watch warnings and report unresolved relationships; the graph is not proof of completeness. Never initialize an index during ordinary discovery. If this project is unindexed or the provider fails, use scoped native exploration. Do not call tgrep merely to confirm the same symbol. Source unavailable in this context is missing evidence, even if another agent saw it.
```

### 4.3 tgrep: `tgrep-search-v2.md`

```markdown
### Textual provider: tgrep

Use `tgrep search [flags] -- PATTERN ROOT`. Prefer `-F` for literals. Scope by directory/type; broad queries start with `-l`, then selected files and `-C 2`. Positive `-g` can bypass indexing. Use `--hidden` only for intended hidden paths. Missing index can fall back to scanning. For edits that must be visible now, use `--no-index`; status is not proof of freshness. Exit 1 means no matches, 2 means error. Preserve stderr. If unavailable, use native Grep. Do not install, start servers or reindex during ordinary discovery.
```

No añadir a esos bloques todos los ejemplos, flags o fuentes de este documento. Esos detalles quedan en el runbook.

### 4.4 Fragmento de agente y modificaciones concretas

`codegraph-access-v2.md` lleva frontmatter `name: codegraph-access-v2`, `description: Use when this agent needs structural discovery.`, `type: behavior`, `maxWords: 60`. Cuerpo:

```markdown
### Structural discovery access

Apply Code discovery routing from the project instructions. Use the available `codegraph_explore` capability for missing structural evidence, not as a mandatory preflight. Continue with scoped native tools if unavailable.
```

No duplicar ese fragmento como siete archivos fuente. Las siete entradas del manifest referencian el mismo archivo.

Modificar fuentes de roles/protocolos así:

| Fuente | Cambio prescrito |
| --- | --- |
| `agents/explorer.md` | Sustituir el mandato de recorrer entrypoints hacia hojas por obtener el mapa con el provider estructural; traversal manual sólo como fallback. Conservar formato de entrega y prohibición de modificar producto. |
| `agents/researcher.md` | Resolver la pregunta acotada usando routing, no cargar structural-search obligatoriamente para toda pregunta. |
| `agents/implementer.md` | Contexto desconocido → provider estructural; archivo/alcance conocidos → lectura directa. Conservar tests, review y límites del rol. |
| `agents/reviewer.md`, `agents/auditor.md`, `agents/ticket-audit.md` | Aplicar routing antes de recopilar evidencia; impacto estructural no se demuestra con ocurrencias. Mantener sus criterios de revisión. |
| `agents/leader.md` | No delegar sólo para envolver una consulta; cuando la delegación ya corresponde, transferir pregunta pendiente, evidencia relevante, paths y freshness. No afirmar que el subagente comparte el contexto. |
| `skills/structural-search.md` | Mantener id/path público; convertirlo en receta de lectura acotada, fallback y búsqueda de formas AST. Eliminar escalera textual-first, verificación ritual de memoria y cuotas heredadas. Mantener ast-grep para patrones sintácticos, no como reemplazo de call graphs. Cap de cuerpo managed 600 palabras y composed 600 al no inyectar rungs. |
| `skills/debug-error.md`, `skills/loop-back-debug.md`, `skills/solution-design.md`, `skills/review-diff.md` | Retirar únicamente instrucciones que fuercen discovery duplicado. No tocar lógica de debugging, requisitos de seguridad ni gates. Referir al routing del proyecto. |

No cambiar los umbrales de delegación del harness como parte de Search v2. Los agentes nativos Explore/Plan no garantizan cargar la política: usar los roles custom cuando se necesite esta integración. Si el host selecciona un agente nativo, el mensaje delegado debe llevar la regla corta por intención y la evidencia; no dar por aprobada paridad sin traza real.

## 5. Semántica operativa y fallos

### 5.1 Árbol de decisión obligatorio

1. ¿La evidencia suficiente ya está en este contexto y no cambió? Responder/actuar sin discovery.
2. ¿Sólo faltan nombres de archivos por patrón? Glob.
3. ¿Archivo exacto + tarea local delimitada, sin relaciones desconocidas? Read/Edit.
4. ¿Sólo texto/literales/regex? tgrep.
5. ¿Definición, comportamiento, relaciones, arquitectura, impacto? CodeGraph.
6. ¿Mixta? Literal como pista → tgrep primero; feature como pista → CodeGraph primero. Segunda herramienta sólo para información que la primera no responde.
7. ¿No se puede usar el provider? Fallback acotado; declarar límites. No transformar la tarea en reparación de infraestructura.

No usar cuotas duras de llamadas. No tratar `where`, `find` o la presencia de un nombre exacto como clasificación suficiente. `AuthService` en comentarios es texto; dependencias de `AuthService` son estructura.

### 5.2 Comandos de búsqueda canónicos

```bash
tgrep search -n -F -- "DATABASE_URL" .
tgrep search -l -t ts -- "TODO|FIXME" packages/cli/src
tgrep search -n -C 2 -F -- "mensaje exacto" packages/cli/src/lib
tgrep search -n -F -- "serve" .
tgrep search --no-index -n -F -- "texto recién agregado" .
tgrep search --hidden -n -F -- "permissions" .claude
tgrep search -g '*.md' -n -F -- "AuthService" .
```

El último ejemplo usa glob positivo por necesidad textual y puede escanear: no venderlo como consulta indexada. Las rutas son ejemplos del runbook; el agente debe usar el scope de su tarea. Quote seguro de los argumentos, sin interpolar texto del usuario como código shell.

No truncar silenciosamente con `head`. Si una consulta sale truncada, acotar/repetir sólo la parte faltante o entregar un listado de archivos; no llamar al resultado “todas las ocurrencias”. `-m` limita por archivo, no impone un límite global de contexto.

### 5.3 Freshness y recuperación

| Situación | Acción exacta |
| --- | --- |
| CodeGraph devuelve suficiente source fresh en este contexto | No Read/Grep/tgrep del mismo fragmento por verificación. |
| CodeGraph señala archivo stale u omite el source necesario | Read de ese archivo/rango; no reconstruir todo el módulo. |
| El editor exige lectura nativa previa | Hacer esa lectura acotada y registrar razón `editor-precondition`; no contarla como redundancia. |
| Índice CodeGraph ausente para ese proyecto | Fallback durante el resto de la tarea; no init automático. Puede mencionarse setup al usuario. |
| projectPath equivocado | Corregir una vez al checkout real; si sigue fallando, fallback. |
| Error interno transitorio | Una repetición como máximo; luego fallback. Negativa de seguridad: cero intentos de elusión. |
| tgrep sin índice | La búsqueda puede escanear; no declararlo fallo de instalación. |
| tgrep sin servidor pero con índice viejo | Si se requiere actualidad, `--no-index`; no reindexar por cada edición. |
| tgrep server activo tras edición | Para confirmación inmediata usar `--no-index`, no polling del agente. |
| tgrep exit 1 | Resultado vacío, no fallo. Revisar scope/ignores sólo si contradice evidencia concreta. |
| tgrep exit 2, binario ausente o error de infraestructura | Leer stderr; corregir argumento evidente una vez o usar Grep. No ocultar resultados parciales como completos. |
| No hay Bash o permiso adecuado | Usar herramientas nativas permitidas por el host; no ampliar permisos automáticamente. |

## 6. Setup, índices y Git

### 6.1 Secuencia del setup autorizado

1. Confirmar que la limpieza terminó. Registrar SHA base y estado Git; no hacer stash/reset ni borrar cambios ajenos.
2. Crear branch desde `main` para la implementación. Si hay archivos de otra sesión pendientes, esperar su resolución o usar un worktree nuevo desde el commit de limpieza confirmado; nunca mezclar esos cambios en el PR.
3. Verificar `command -v codegraph tgrep claude`, `codegraph --version`, `tgrep --version`, `claude --version`. No instalar si ya existe binario funcional.
4. Implementar fuentes y pruebas deterministas antes de activar dogfood.
5. Activar ambos plugins en `navori.config.json` del dogfood. Regenerar y revisar MCP/settings/agents.
6. Ejecutar explícitamente `codegraph init .` en la raíz del checkout autorizado, sin `--force`. Rechazar ofertas de hooks/configuración de otros hosts. Comprobar `codegraph status .` y revisar el diff de archivos auxiliares.
7. Abrir Claude desde esa raíz. Aprobar el MCP de proyecto mediante el flujo normal del host; no autoaprobar todos los MCP. Verificar una llamada real a explore.
8. Para tgrep, consultar `tgrep status .`. Si hay server operativo en esa raíz, reutilizarlo. Si no hay, iniciar **una vez** `tgrep serve .` en terminal dedicada. Si esa terminal no puede persistir, usar `tgrep index .` y documentar el modo disco.
9. No usar `tgrep serve . &` dentro de un hook ni deducir vida del servidor sólo porque existe `.tgrep/serve.json`. El usuario cierra su terminal para terminar el proceso que inició; Navori no mata procesos externos.
10. No agregar `codegraph.json` si los defaults bastan. Usar exclusiones existentes; no ignorar carpetas de producto para acelerar artificialmente las pruebas.

### 6.2 `.gitignore` sin violar `off`

- Extender el input `GitignoreConfig` interno con `plugins?: NavoriConfig["plugins"]`.
- Para `local`/`full`, derivar `.codegraph/` sólo con CodeGraph activo y `.tgrep/` sólo con tgrep activo; quitar la regla incondicional de CodeGraph si sobrevive la limpieza. Mantener los demás entries de Cubo A/B intactos, orden estable y sin duplicados internos.
- Para `off`, no escribir `.gitignore` en render, aunque los plugins estén activos.
- En el setup explícito del dogfood con `off`, comprobar cobertura con `git check-ignore --no-index -q -- .codegraph/probe .tgrep/probe` de forma individual por path. Esos paths son probes lógicos: no crear archivos para comprobarlos.
- Añadir manualmente sólo la regla que falta como cambio explícito del setup autorizado. No repetir una regla equivalente ya vigente. Mantener cualquier regla escrita por `codegraph init` que ya resuelva el caso.
- Si una negación posterior vuelve a incluir un índice, el check lo detecta; corregirlo en setup con diff visible, no sobrescribir reglas de usuario desde render.
- Comprobar que `git ls-files -- .codegraph .tgrep` no devuelve archivos. Si ya están trackeados, reportar el hallazgo; no ejecutar una limpieza ajena automáticamente.
- Desactivar un plugin no borra su índice. Con modos managed, advertir en el runbook que el usuario debe conservar una regla manual si mantiene el directorio tras retirar su regla managed.

## 7. Orden de implementación y pruebas deterministas

No avanzar de una etapa con tests fallidos a la siguiente. Los tests nuevos no recuperan assertions de la integración antigua; se escriben desde estos contratos.

### P0 — Baseline

- Registrar SHA de limpieza, versiones y `git status` en `docs/research/search-v2-results.md`.
- Leer las instrucciones locales vigentes y `docs/DIRECTION.md`.
- Ejecutar `pnpm check` sobre ese baseline después de terminar la limpieza; registrar fallos preexistentes sin atribuirlos a v2.
- En caso de fallo previo, no rebajar thresholds ni borrar tests. Separar causa baseline de causa v2 en el reporte.

### P1 — Plugins y contratos públicos

Crear manifests/paquetes, registros y lockfile. Añadir `packages/cli/src/lib/__tests__/search-v2-manifests.test.ts`:

| Test | Assertions mínimas |
| --- | --- |
| M01 | Ambos manifests pasan `PluginManifestSchema`; todos los assets referenciados existen dentro de su packageRoot. |
| M02 | CodeGraph args, env y alwaysLoad coinciden con §3.2; permiso exacto explore; ningún permiso de install/index/sync ni hook/script. |
| M03 | tgrep no tiene MCP, hooks, scripts, skills ni postInstall; sólo permisos de §3.3. |
| M04 | Siete destinos únicos de CodeGraph, un único archivo fuente; ninguno es commit-pr-pilot ni un agente inexistente. |
| M05 | El artefacto de build incluye ambos manifests y assets; no incluye índices, fixtures de runtime o scripts de benchmark. |
| M06 | Plugins ausentes no se habilitan por default; presets no activan v2 implícitamente. |

### P2 — Routing, agentes y render

Añadir `packages/cli/src/engines/claude/__tests__/search-v2-render.test.ts`. Usar `renderClaudeEngine` y `NavoriConfigSchema.parse` como las suites existentes. Fixtures con `mkdtemp`, cleanup `afterEach/afterAll` y protección del HOME/backups de Vitest. No usar el repositorio real como fixture.

Matriz `00`, `10`, `01`, `11` = CodeGraph/tgrep desactivado/activado. Para cada combinación:

| Test | Assertions mínimas |
| --- | --- |
| R01 | Bloque core exactamente una vez; bloque de cada provider si y sólo si su plugin está activo. |
| R02 | `.mcp.json` sólo recibe CodeGraph cuando corresponde; tgrep nunca aparece; servidor ajeno `fixture-server` y claves top-level ajenas sobreviven. |
| R03 | Permisos exactos, deduplicados; reglas `deny` y `ask` preexistentes sobreviven. |
| R04 | Cada uno de los siete roles habilitados tiene subbloque/grant CodeGraph cuando corresponde; mantiene sus tools nativas. Agent deshabilitado no se recrea por el injectInto. |
| R05 | Segundo render devuelve cero escrituras/cambios, además de archivos byte-idénticos. No basta comparar texto ignorando el resultado del plan. |
| R06 | Dry-run no crea ni modifica archivos, no índices y no procesos de las herramientas. Usar ejecutables sentinel en PATH que registren cualquier ejecución y fallen. |
| R07 | Texto user-section y bloques de otros plugins sobreviven a render y disable. |
| R08 | True→false→true y remove→render no dejan entry MCP, allow rule, subbloque ni grant generado huérfanos; reactivar no duplica. |
| R09 | Bloque manipulado por usuario/nueva versión se conserva y aparece skipped; no reportar instalación correcta. |
| R10 | No hay `codegraph sync`, prompt-hook, tgrep-session, auto-index, wrapper, o regla `Bash(tgrep *)` en los assets v2/render. Comprobar campos/artefactos propios, no escanear texto de tests/docs donde esos nombres son ejemplos negativos. |
| R11 | Suma de palabras de los tres cuerpos managed ≤350; fragmento por agente ≤60. Sin templates pendientes. |
| R12 | Config workspace minimal no duplica bloques root-only ni crea agentes locales que hereda de la raíz. |
| R13 | Retired registries no purgan ids v2 activos; no se restauran rungs/scripts antiguos. |

Añadir `packages/cli/src/lib/__tests__/search-v2-policy.test.ts`:

- Assert de las distinciones no-search, known-file, filename, literal, structural, mixed y validation en los bloques específicos; no un test que sólo busque las palabras CodeGraph/tgrep en todo el repo.
- Assert de ausencia de las instrucciones conflictivas reemplazadas en los assets modificados: textual-first universal, confirmar todo resultado con otra búsqueda, recorrer entrypoints obligatoriamente y cargar siempre structural-search.
- Mantener tests genéricos de word caps, triggers, invariants y wiring MCP. Si un auditor sólo reconoce wildcard de permiso, extenderlo para reconocer también el permiso exacto de una tool, con casos positivos/negativos; no ampliar el permiso de producción para satisfacer un test defectuoso.
- No crear un clasificador fake que devuelva la ruta esperada y presentarlo como prueba del modelo. La conducta del modelo se mide en §9.

### P3 — Lifecycle declarativo, compatibilidad e ignores

Extender suites genéricas de `agent-mcp-tools`, gitignore y lifecycle; añadir `packages/cli/src/engines/__tests__/search-v2-compat.test.ts`:

| Test | Assertions mínimas |
| --- | --- |
| C01 | grant v2 generado se retira al desactivar; grants de Engram/usuario sobreviven; bloques alterados no se fuerzan. |
| C02 | `.gitignore` byte-idéntico en modo off; local/full derivan índices sólo con plugins activos y sin duplicados internos. |
| C03 | Reglas base Cubo A/B, preservación manual, backups y dry-run de ignores siguen pasando. |
| C04 | Codex no recibe `alwaysLoad` en TOML ni paths `.claude` que su adaptador deba transformar; el contrato MCP genérico sigue válido. |
| C05 | Prose engines no prometen tools MCP que no configuran; preservan sus warnings de omisiones. |
| C06 | Cambios de v2 no alteran los fragmentos de settings, MCP ni hooks aportados por plugins ajenos. |
| C07 | Repos sin binarios instalados siguen renderizando y doctor sólo informa ausencia; ninguna dependencia de red en estas suites. |

### P4 — Integración y gate local

Comandos desde raíz, en este orden:

```bash
pnpm --filter navori build
pnpm --filter navori exec vitest run search-v2
pnpm --filter navori typecheck
pnpm render:apply
pnpm --filter navori test:golden
pnpm check
```

Leer el diff de golden de cada engine y del espejo. No actualizar snapshots en bloque sin revisar. Si el formato falla, formatear sólo archivos propios; no correr una escritura global que altere trabajo concurrente. No sustituir `test:coverage` por `test` ni bajar el coverage floor. El alias `pnpm check` es la autoridad, no copiar su expansión a nuevos scripts.

## 8. Pruebas de binarios reales, sin LLM

### 8.1 Harness de pruebas externas

Crear `scripts/search-v2/runtime.test.mjs` usando `node:test` y `node:assert/strict`, más `fixture.mjs` y `mcp-client.mjs` como helpers. Sin dependencia npm nueva. Ejecutar explícitamente:

```bash
node --test --test-concurrency=1 scripts/search-v2/runtime.test.mjs
```

No incluirlo en `pnpm check`: requiere binarios externos. Al invocarlo, ausencia de un binario es **fallo de precondición**, no un skip verde. CI determinista sigue siendo independiente de instalaciones locales; el reporte final debe incluir la ejecución externa.

Contrato del runner:

- Resolver ejecutables antes de aislar HOME. Usar `spawn` con array de argumentos y `shell: false`.
- Cada suite usa directorio temporal propio y subdirectorios `home`, `repo`, `outside`; inicializar Git en repo para ignore semantics.
- Usar HOME/XDG_CONFIG_HOME temporales en procesos de las herramientas. No tocar credenciales/config reales.
- Para CodeGraph del runtime test, env `CODEGRAPH_NO_DAEMON=1`, `CODEGRAPH_EXPLORE_DEDUP=0`, `CODEGRAPH_MCP_TOOLS=explore`, `CODEGRAPH_TELEMETRY=0`. NO agregar NO_DAEMON al manifest de producción.
- Setup de índices con `codegraph init --yes <fixtureRoot>` y `tgrep index <fixtureRoot>`; uso de `--yes` permitido sólo en fixture desechable. No ejecutar `codegraph install`.
- Timeout init/index: 120 s; request MCP: 30 s; polling watcher: cada 250 ms hasta 15 s. Deadline vencido = fallo con stdout/stderr, nunca sleep fijo y asumir éxito.
- Capturar stdout, stderr y exit code separados. No ocultar códigos 1 de tgrep como excepción genérica ni aceptar 2 como vacío.
- Registrar todos los child handles. En finally: cerrar stdin del MCP, esperar hasta 3 s, SIGTERM al proceso propio, esperar 3 s y SIGKILL sólo al proceso propio si sigue vivo. Esperar salida antes de remover fixture. No `pkill`, `killall` ni manipular PID ajeno leído de disco.
- Cleanup corre también si una assertion falla. Un proceso propio sin terminar hace fallar el test.

### 8.2 Fixture única controlada

Crear estos archivos en el repo temporal; sin secretos reales:

```text
src/entry.ts       handleRequest(token) llama createSession(token)
src/session.ts     createSession(token) valida token y llama saveSession(token)
src/repository.ts  saveSession(token) retorna `stored:${token}`
src/unused.ts      unusedHelper(), sin callers
src/types.ts       tipos auxiliares, sin side effects
config/app.json    { "apiEnvName": "DATABASE_URL" }
docs/notes.md      AuthService; serve; a+b[0]; /legacy-api/; --literal-v2
tests/session.test.ts  importa y llama createSession
.hidden/config.md  HIDDEN_SEARCH_V2
dist/ignored.txt   IGNORED_SEARCH_V2
.gitignore        dist/, node_modules/, .codegraph/, .tgrep/
```

Contenido exacto de los archivos que participan en los oráculos (terminar cada archivo con newline):

`src/entry.ts`:

```typescript
import { createSession } from './session.ts';
export function handleRequest(token: string): string {
  return createSession(token);
}
```

`src/session.ts`:

```typescript
import { saveSession } from './repository.ts';
export const revision = 'BASELINE_V2';
// TODO SEARCH_V2_AUTH
export function createSession(token: string): string {
  if (!token) throw new Error("SESSION_EXPIRED_V2");
  return saveSession(token);
}
```

`src/repository.ts`:

```typescript
export function saveSession(token: string): string {
  return `stored:${token}`;
}
```

`src/unused.ts` contiene `export function unusedHelper(): string { return 'unused'; }`.
`src/types.ts` contiene `export type SessionToken = string;`.

`tests/session.test.ts`:

```typescript
import assert from 'node:assert/strict';
import test from 'node:test';
import { createSession } from '../src/session.ts';
test('creates a stored session', () => {
  assert.equal(createSession('token'), 'stored:token');
});
test('rejects an empty token', () => {
  assert.throws(() => createSession(''), /SESSION_EXPIRED_V2/);
});
```

Crear `package.json` con `{"private":true,"type":"module"}`. Node 24 del proyecto puede ejecutar esta fixture con `node --test tests/session.test.ts` sin instalar dependencias. El escenario J modifica el contrato de retorno; debe actualizar el expected de su test a `saved:token` y ejecutar ambos tests. No editar el caso de token vacío para hacer pasar la prueba.

`config/app.json` contiene exactamente el objeto mostrado en el árbol. `docs/notes.md` contiene los cinco textos del árbol, uno por línea. Los dos archivos hidden/ignored contienen únicamente su marcador. El oráculo conoce los cuerpos porque los escribe: no obtiene sus expected de CodeGraph ni de tgrep. `SESSION_EXPIRED_V2` aparece en el throw y en su test; el escenario C debe distinguir emisor de assertion.

### 8.3 tgrep: casos obligatorios

| ID | Preparación y acción | Resultado requerido |
| --- | --- | --- |
| T01 | Sin índice/server, `search -F -- DATABASE_URL ROOT` | Exit 0, match de config/app.json; warning de scan conservado; no se crea índice por buscar. |
| T02 | Índice en disco, ejecutar el mismo search | Mismo conjunto de matches que `--no-index`; comparar paths/líneas normalizados, no tiempos. |
| T03 | Tras indexar, crear nuevo archivo con `NEW_FILE_V2`; buscar fresco | `--no-index` encuentra el archivo. No afirmar que modo disco esté actualizado ni exigir un falso negativo como condición de éxito. |
| T04 | `serve` sin índice previo | Esperar disponibilidad/build con deadline; consulta conocida funciona; sólo un child server creado por runner. |
| T05 | Con server, editar BASELINE_V2→UPDATED_V2 y crear/eliminar archivos | `--no-index` refleja cambios inmediatamente; búsqueda normal converge dentro de deadline. |
| T06 | Finalizar el server propio; cambiar source; buscar fresco | No bloqueo; `--no-index` sigue correcto aunque quede índice en disco. |
| T07 | Buscar `serve`, `a+b[0]`, patrón que empieza con `-` usando `-F --` | Literales exactos; no se interpretan como subcomandos, flags o regex. |
| T08 | Regex TODO/FIXME, `-l`, `-t ts`, `-g '*.md'`, `-C 2` | Scope/output correctos; `-l` no devuelve cuerpos de archivos; no exigir que glob positivo utilice índice. |
| T09 | Sin matches y regex inválida | Exit 1 para vacío; exit 2 para regex inválida, stderr no vacío. |
| T10 | Ignored y hidden | Sin override no aparece ignored/hidden; con `--hidden` aparece HIDDEN_SEARCH_V2, sin incluir dist ignorado. |
| T11 | ROOT con espacios | Ningún error de quoting; mismas rutas relativas/conjunto de matches. |

### 8.4 CodeGraph: protocolo y casos obligatorios

El helper MCP implementa únicamente transporte de test: JSON-RPC 2.0 por líneas, ids correlacionados, `initialize`, `notifications/initialized`, `tools/list`, `tools/call`; responder `roots/list` con URI de la fixture si el servidor lo pide y `ping` con objeto vacío. Proponer protocolVersion `2025-03-26`, registrar la respuesta; fallar con diagnóstico si no se negocia una versión soportada por el helper. No publicar ese helper como producto.

Lanzar `codegraph serve --mcp --path <fixtureRoot>`. Args de explore: únicamente `query` y `projectPath`, sin inventar opciones de truncado. Guardar initialize/tools-list y stderr como evidencia local.

| ID | Acción | Resultado requerido |
| --- | --- | --- |
| G01 | tools/list con fixture indexada | Único nombre `codegraph_explore`; inputSchema acepta query/projectPath. |
| G02 | Query `handleRequest createSession saveSession` | Source y números de línea para las funciones; relaciones entre ellas. Contrastarlas con los imports/calls conocidos de fixture. |
| G03 | Consultar impacto de createSession | Incluye handleRequest como consumidor; no inventa caller unusedHelper. No exigir formato textual exacto del resumen upstream. |
| G04 | Repetir consulta en misma conexión y en una nueva | Source necesario presente en ambas con dedup=0; no aceptar únicamente una referencia a source de un contexto previo. |
| G05 | Servidor lanzado fuera de proyectos indexados, dos proyectos hijos indexados | Explore sigue visible; query con projectPath de cada hijo responde desde el hijo correcto. No default ambiguo. |
| G06 | Consultar proyecto sin índice | Mensaje recuperable o error descriptivo, ningún init automático; no depender de `isError` para identificar ausencia de índice. |
| G07 | Editar la fixture con watcher activo | Hasta converger, respuesta puede entregar source actual o advertencia de stale; no aceptar source viejo presentado como fresh. Después del deadline source/relación nuevos deben verse. |
| G08 | Arrancar con `--no-watch`, consultar, luego editar | Respuesta informa watcher desactivado/stale o sirve source actual; la política permite Read. No sync hook. |
| G09 | Dos checkouts/worktrees con literal distinto en mismo símbolo | projectPath de cada checkout obtiene su variante; jamás mezclar source/rangos del otro. |
| G10 | source suficiente y operación Edit en Claude real | Se verifica en §9: si el editor requiere Read previo, registrar editor-precondition y hacer sólo esa lectura. |

G05–G09 corren en fixtures independientes para no reutilizar índices contaminados. Para G09 usar dos checkouts temporales; añadir además un smoke manual en worktree Git real desechable del dogfood antes de declarar soporte de worktrees. No montar symlinks a índices.

## 9. Benchmark funcional con Claude Code real

### 9.1 Protocolo reproducible

Crear `scripts/search-v2/scenarios.json` y `scripts/search-v2/benchmark.mjs`. El runner guarda NDJSON crudo fuera del corpus consultado y genera métricas JSON; no se instala en el harness ni corre en cada sesión.

- Dos capas: fixture controlada de §8 para oráculo exacto y smoke read-only del repositorio Navori después de limpiar/implementar.
- Comparar baseline sin plugins de búsqueda contra v2 en clones temporales separados del mismo source. Ambos usan el mismo modelo, permisos base y contexto común; el fixture no incluye expected answers en archivos indexados.
- Resolver una vez un modelo permitido por la cuenta y registrar el id efectivo de la respuesta. Usar ese mismo id en todas las corridas; no cambiar silenciosamente de modelo si falla. No fijar un nombre inventado o asumir acceso a un modelo específico.
- Ejecutar A–F tres veces por condición en sesiones nuevas, alternando baseline/v2 por ronda. Añadir G/H y pruebas de agentes una vez. Nunca `--continue`/`--resume` entre escenarios.
- Invocar con argv, no command string: `claude -p <prompt> --model <effective-model-id> --output-format stream-json --verbose --no-session-persistence --setting-sources project --strict-mcp-config --mcp-config <absolute-mcp-file>`.
- Verificar esos flags con `claude --help` de la versión probada. No usar `--dangerously-skip-permissions`, no forzar la herramienta esperada mediante `--tools`, no incluir “usa CodeGraph/tgrep” en los prompts de routing.
- Mantener las tools nativas disponibles para que una selección equivocada sea observable. No crear un benchmark donde Grep/Read estén prohibidos y después afirmar que Claude prefirió CodeGraph.
- Prompt común: tarea read-only, no modificar código de producto. El escenario de edición usa sólo la fixture desechable y el flujo normal del implementer.
- Preparar ambos clones con la CLI recién compilada y configuración `preset: custom`, `engines: [claude]`, `branchBase: main`, `gitignoreHarness: off`, qualityGate fast/full `node --test tests/session.test.ts`. No habilitar plugins ajenos para la fixture controlada. Baseline omite ambos plugins de búsqueda; v2 los habilita. Renderizar con `node <absolute-cli-dist>/index.js render --apply --cwd <fixtureRoot>`. Cuando baseline no genere `.mcp.json`, pasar al flag MCP un archivo externo que contenga `{"mcpServers":{}}`.
- Sólo v2 inicializa índices. Iniciar el server tgrep una vez por clone v2; mantenerlo entre escenarios y registrar esa condición warm. Cada llamada Claude usa sesión nueva. Registrar separadamente el tiempo de indexación/setup para no mezclarlo con latencia warm.
- Registrar permission_denials. Una negativa por setup incompleto invalida la corrida, no demuestra que una herramienta sea lenta o inútil. Corregir setup legítimo y repetir esa corrida; no saltarse una negativa de seguridad.
- Las credenciales de Claude permanecen en su mecanismo normal; no copiarlas a fixtures ni al reporte. `--setting-sources project` no se presenta como aislamiento de todos los tipos de memoria. Registrar instrucciones globales que todavía apliquen y mantenerlas iguales entre condiciones.
- Antes de la primera tarea, comprobar en una sesión separada que MCP, políticas y permisos llegaron al agente. Esta sonda de setup no cuenta como parte de la tarea medida.
- Timeout por corrida: 180 s. Si vence, conservar traza y clasificar timeout. Ejecutar secuencialmente; no sesgar comparación saturando CPU con varios índices/modelos.

### 9.2 Prompts y oráculos

| ID | Prompt fixture (sin nombrar herramientas) | Ruta esperada / oráculo |
| --- | --- | --- |
| A | Explain how an incoming token is validated and turned into the returned session value. Cite the participating functions. | CodeGraph primero; handleRequest → createSession → saveSession; aclarar que la fixture retorna una string, no persiste en una base de datos. |
| B | Find every literal occurrence of DATABASE_URL in this repository. | tgrep; config/app.json, sin CodeGraph. |
| C | Find where SESSION_EXPIRED_V2 is emitted and explain the execution path that produces it. | tgrep → CodeGraph; token vacío y la cadena correcta. |
| D | Read src/repository.ts and explain its return value. Do not investigate other files. | Read; `stored:${token}`; sin discovery. |
| E | What callers would be affected by changing createSession? | CodeGraph; entry/test caller según fixture; distinguir impacto probable de prueba de exhaustividad. |
| F | Find TODO/FIXME comments under src. | tgrep; comentario SEARCH_V2_AUTH; sin CodeGraph. |
| G | List files matching tests/**/*.test.ts. | Glob. |
| H | Given `export const mode = 'safe';`, what string does mode hold? Answer from this snippet only. | Ninguna búsqueda. |
| I | Explain session creation, then find associated environment-variable names in configuration. | CodeGraph → tgrep, si hace falta texto/config; no segunda búsqueda del mismo símbolo. |
| J | In src/repository.ts change `stored:` to `saved:` and verify the change. | Read/Edit del implementer y comprobación fresca; sin discovery estructural por ritual. |

Casos negativos adicionales, una corrida por caso en clones separados:

| ID | Estado controlado | Prompt y aceptación |
| --- | --- | --- |
| K | Plugin CodeGraph habilitado, binario presente, ningún índice de ese clone ni ancestros | Usar A. Fallback nativo, respuesta correcta, no init y como máximo un diagnóstico de falta de índice. |
| L | Plugin tgrep habilitado, ejecutable shadow de test en un PATH exclusivo que termina con error de herramienta no disponible | Usar B. Grep permitido, respuesta correcta; no instalar/reindexar ni repetir en bucle. El shadow sólo existe en fixture, no en producto. |
| M | Plugin CodeGraph habilitado, comando MCP de fixture apunta a ejecutable inexistente | Usar E. Fallback correcto; no ejecutar herramientas MCP alternativas inventadas ni modificar configuración para esconder fallo. |
| N | Ambas herramientas desactivadas | Usar A y B. No referencias obligatorias a los providers; native discovery correcto. |

Los estados K–N se inyectan exclusivamente en clones temporales. Guardar la configuración efectiva con la traza y etiquetar fault injection; no incorporar esos cambios a los assets ni reutilizarlos como evidencia de configuración production.

Smoke Navori, tres preguntas fijas con símbolos locales reales:

1. “Explica cómo renderClaudeEngine usa computeRenderPlan y termina escribiendo los archivos managed.”
2. “Encuentra las ocurrencias literales de gitignoreHarness bajo packages/cli/src.”
3. “Qué consumidores se afectarían si cambiamos computeRenderPlan.”

Si la limpieza renombró alguno, localizar el símbolo equivalente durante preparación y congelar el prompt en scenarios.json antes de correr ambas condiciones; no adaptar el prompt después de ver resultados. Para debugging con error real de Navori, elegir el primer literal de `throw new` en orden de path/línea bajo `packages/cli/src/lib`, registrar path/línea y congelarlo antes de las corridas.

### 9.3 Contexto de agentes y editor

- Un escenario de handoff lanza el custom `explorer` mediante Agent y le encarga A; inspeccionar los tool_use del subagente, no sólo el resumen del principal.
- Repetir con custom `researcher` para B y `reviewer` para E. Son pruebas de integración explícitas, no nuevos agentes de producto.
- Confirmar que las allowlists reales permiten Bash y explore según configuración y que el custom agent recibe CLAUDE.md. Un archivo generado correcto no basta como evidencia.
- En una sesión, el principal consulta createSession; después un subagente con contexto fresco consulta ese símbolo. Debe recibir source, no sólo “ya enviado”.
- Para J, conservar el error del editor si exige lectura nativa; esa lectura tiene reason `editor-precondition` y no se elimina por ahorrar llamadas. No afirmar que CodeGraph sustituye la precondición del host sin comprobarlo.
- La política no prohíbe delegación del flujo existente: clasificar aparte llamadas de coordinación/memoria/gates y llamadas de discovery. La ruta esperada se evalúa en el agente responsable de resolver la tarea.

### 9.4 Métricas y criterio de aprobación

Cada resultado registra:

```text
scenarioId, condition, repetition, modelId, cliVersions, sourceCommit,
sessionId, elapsedMs, toolCallsTotal, discoveryCalls,
discoverySequence, returnedUtf8Bytes, returnedLines,
inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
redundantCalls, nativeReadReasons, fallbackReason,
permissionDenials, correctness, routingPass, outcome
```

- Extraer tool_use/tool_result por id, contando una llamada una vez. Incluir subagentes vía `parent_tool_use_id`. No doble contar eventos parciales de streaming.
- `returnedUtf8Bytes` mide los payloads textuales de resultados de discovery; no es una medición exacta de tokens. Campos de usage inexistentes son null, no cero. Separar cache usage cuando el host lo reporte.
- Redundante = mismo propósito y fragmento ya suficientemente cubierto en **ese contexto**, sin edición, stale, truncado ni precondición nueva. Etiquetar manualmente cada candidato con ids de tool call y motivo. No llamar redundante a toda secuencia CodeGraph→Read.
- Calificar correctness contra la fixture y citas; un resumen fluido no equivale a respuesta correcta. Resultados incompletos que se presentan como exhaustivos fallan.
- Aprobar A–F sólo con 3/3 respuestas correctas y routing esperado o una excepción concreta respaldada por traza. Cero llamadas redundantes injustificadas en todas las corridas v2. G/H deben pasar; agentes y editor también.
- No exigir reducción numérica en todos los escenarios. Reportar medianas y rangos baseline/v2. Si no hay mejora medible, decirlo; no rebajar correctness ni forzar menos tools para fabricar una ganancia.
- Si una corrida revela doctrina contradictoria, corregir la fuente, regenerar y repetir **todos** los escenarios afectados. Después de dos ciclos sin cumplir criterios, entregar estado NO APROBADO con trazas; no expandir alcance con hooks/routers para disimular el problema.

## 10. Trazabilidad, entrega y definición de terminado

### Matriz de requisitos → evidencia

| Requisito | Evidencia obligatoria |
| --- | --- |
| CodeGraph disponible y mínimo | M02, R02/R04, G01/G02, A/E y smoke Navori |
| tgrep textual, sin MCP adicional | M03, T01–T11, B/F |
| No cascadas ni verificación ritual | R10/R11, policy tests, métricas A–J |
| Source fresh reutilizable en mismo contexto | G04/G07/G08, handoff y editor |
| Paths/known-file/no-search | D/G/H/J |
| Configuración opt-in y reversible | M06, matriz render, R08/R13, C01 |
| Respeto a usuario/seguridad | R03/R07/R09, C02/C03/C06 y revisión de preview |
| Monorepo/worktree correcto | R12, G05/G09, smoke de worktree |
| Degradación no bloqueante | R06, C07, T01/T06/T09, G06 y corrida Claude sin cada provider |
| Correctness sigue en gates | `pnpm check`, no regresiones, reporte honesto de pruebas externas |

### Entrega de implementación

Actualizar `docs/research/search-v2-results.md` con:

1. Baseline **posterior a limpieza**, SHA y arquitectura de discovery encontrada; no confundir restos previos con baseline final.
2. Fuentes separadas en documentación CodeGraph, código CodeGraph, tgrep, Claude y fuentes secundarias (ninguna requerida).
3. Arquitectura final, configuración y decisiones de este documento.
4. Lista exacta de archivos modificados, motivo y requisito/test que cubre cada grupo.
5. Resultados deterministas, runtime y Claude: PASS/FAIL/NOT RUN por id. NOT RUN nunca es PASS.
6. Tabla de métricas, fallbacks, lecturas justificadas y limitaciones de la medición.
7. Riesgos observados y pasos de rollback; no riesgos genéricos para rellenar.

No commitear índices, logs crudos con datos del proyecto ni credenciales. Guardar trazas en un directorio temporal fuera del corpus y entregar su ubicación; el reporte versionado lleva resultados y referencias a ids, no miles de líneas de source.

Rollback de activación: deshabilitar plugins y ejecutar render con el build correspondiente; verificar que se retiran instrucciones/permisos/entry MCP. No desinstalar binarios, borrar índices o matar procesos del usuario. Los bugs en contrato de render/ownership bloquean merge; una limitación upstream se documenta y el fallback se prueba, no se oculta.

### Checklist final

- [ ] La limpieza ajena terminó y el baseline está identificado.
- [ ] No se recuperó la implementación anterior.
- [ ] Plugins y bloques proceden de fuentes; mirror y golden están sincronizados.
- [ ] Matriz on/off, ownership, permisos y otros engines pasan.
- [ ] `pnpm check` pasa sin bajar umbrales ni borrar pruebas.
- [ ] Runtime real T/G ejecutado y procesos propios terminados.
- [ ] Claude real: routing, contexto aislado, editor y fallbacks comprobados.
- [ ] Reporte distingue rendimiento observado de expectativas.
- [ ] Ningún índice/config global/archivo ajeno se incluye en el diff.
- [ ] PR apunta a main; commit atómico Conventional en español MX sólo cuando se solicite.

**Fuera de alcance:** supervisores, auto-index por edición, nuevos MCP/tools, wrappers, agentes de búsqueda dedicados, telemetría permanente, reescritura del pipeline de render, cambiar el modelo de delegación y habilitar Search v2 globalmente en todos los repos. No implementarlos sin una solicitud nueva.

## Key Learnings:

1. El código de CodeGraph v1.6.0 y su referencia MCP discrepan sobre ausencia de índice; el contrato de tools/projectPath debe verificarse con el binario.
2. Deduplicar source entre llamadas no equivale a compartir contexto entre agentes; v2 desactiva esa deduplicación del servidor.
3. Los tests de manifests/render prueban cableado; sólo trazas de Claude real prueban selección de herramientas y ausencia de cascadas.
4. `gitignoreHarness: off`, las allowlists de agentes y los permisos por subcomando son contratos que la integración debe respetar, no excepciones que pueda omitir.
