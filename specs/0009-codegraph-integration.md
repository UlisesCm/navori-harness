# Spec 0009 — Integración de codegraph (plugin de contexto quirúrgico vía MCP)

> Estado: **F1+F2 implementados** (plugin-bundle + gitignore/doctor) · 2026-07-29 · F3 (prompt opt-in en init) y F4 (validación en repo real con el binario) quedan como follow-ups. Deriva de `docs/audit-2026-07.md` §I2/N4 y de las
> Specs 0005 (eficiencia de búsqueda) y 0006 (reducción de contexto).
>
> Objetivo: integrar [codegraph](https://github.com/colbymchenry/codegraph) como un
> **plugin-bundle de navori** que da a los agentes contexto quirúrgico de código en una
> sola llamada MCP, extendiendo la escalera de `structural-search` con un índice AST
> pre-construido — el "índice barato" que la Spec 0005 dejó fuera cuando descartó LSP/Serena
> por overhead.

## 1. Motivación

`structural-search` (M2) es **doctrina de prompt**: le dice al agente "lee lo mínimo", pero
el agente sigue haciendo la escalera grep/read a mano (Rung 0-2). La Spec 0005 cortó en
Rung 2 y **excluyó LSP/Serena** por su overhead fijo (~3k tok/sesión + language server).

codegraph tiene un tradeoff distinto: **índice determinista, 100% local, sin API keys**,
consultable en 1 llamada. No forma parte del presupuesto always-on (es una tool MCP lazy),
así que ataca **P1 (caro/lento)** y **P3 (tokens)** sin el peso que 0005 rechazó. Es el
Rung "-1" de la escalera: un tool que **forma** la hipótesis (no solo la verifica).

## 2. Qué es codegraph (verificado 2026-07-29)

| Dato | Valor |
|------|-------|
| Versión | v1.5.0 (2026-07-21) · MIT · repo activo, ~6 meses (beta usable, no production-hardened) |
| Qué hace | Grafo AST (tree-sitter, ~31 lenguajes) en SQLite/FTS5 local; responde con fuente + call paths + blast-radius en 1 tool call |
| Instalación | `curl -fsSL .../install.sh \| sh` (macOS/Linux), `.ps1` (Windows), o `npm i -g @colbymchenry/codegraph`. **No requiere Rust ni Node** para el CLI/MCP (binario por plataforma) |
| Setup | `codegraph install` (auto-cablea agentes, **Claude Code y Codex incluidos**) → `codegraph init` (construye `.codegraph/codegraph.db`) |
| MCP | `codegraph serve --mcp` (stdio). Por default expone **1 sola tool** `codegraph_explore`; 7 más (`node/search/callers/callees/impact/files/status`) unlisted, se re-habilitan con `CODEGRAPH_MCP_TOOLS` |
| Frescura | File watcher nativo (FSEvents/inotify), debounce ~2s. `codegraph sync` manual. Desde ≥0.8 **ya no instala git hooks** |
| Métricas (self-reported) | 89% menos tool calls, 69% menos tokens, 60% más barato, 5× más rápido en repos grandes. **Sin replicación independiente → tratar como orden de magnitud, no hecho** |

**Multi-engine:** no hay dealbreaker. Claude Code y Codex CLI son soporte oficial de primera
clase, ambos hablan `codegraph serve --mcp` por stdio, ambos auto-cableados por
`codegraph install`. Encaja con el core multi-engine de navori.

## 3. Diseño de la integración: plugin-bundle `codegraph`

navori ya tiene el molde exacto — el plugin `engram` registra un `mcpServer` + `externalTool`
+ `managed` block. codegraph es el mismo patrón. `plugin.json` propuesto:

```json
{
  "id": "codegraph",
  "name": "CodeGraph — surgical code context",
  "description": "Pre-built AST code graph via MCP: symbols, call paths and blast-radius in one call, fewer grep/read loops",
  "version": "0.0.1",
  "managed": [
    { "id": "codegraph-protocol", "file": "managed/codegraph-protocol.md", "recommendedAgent": "leader" }
  ],
  "externalTool": {
    "name": "codegraph",
    "checkBinary": "codegraph",
    "install": {
      "darwin": "curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh",
      "linux": "curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh"
    },
    "postInstall": "codegraph install && codegraph init"
  },
  "mcpServer": {
    "command": "codegraph",
    "args": ["serve", "--mcp"]
  },
  "settingsFragment": {
    "permissions": { "allow": ["mcp__codegraph__*"] }
  },
  "skills": [
    {
      "id": "codegraph-search-extension",
      "file": "skills/codegraph-rung.md",
      "injectInto": ".claude/skills/structural-search/SKILL.md"
    }
  ],
  "invariants": ["codegraph_explore"]
}
```

Notas de diseño:
- **`settingsFragment` → permiso MCP** (frente de permisos): `mcp__codegraph__*` en `permissions.allow`
  para que las queries del grafo no pidan permiso en cada llamada. En Codex, el `mcpServer` ya lo
  renderiza el adapter a `config.toml` (patrón engram). ⚠️ El `injectInto` de `skills` asume la
  **forma-directorio de skills (#166)** — este spec DEPENDE de esa migración (`.claude/skills/structural-search/SKILL.md`).
  Si #166 no está mergeado, el `injectInto` apunta al path plano legacy.
- **`skills.injectInto`** inyecta un sub-bloque en la skill `structural-search` (patrón engram→leader):
  el "Rung -1" que enseña a consultar el grafo ANTES de la escalera grep. Así no re-proponemos
  la doctrina Rung 0-2 (M2), la extendemos con una tool real.
- **`invariants`**: `codegraph_explore` debe aparecer en el render mientras el plugin esté activo
  (guard de doctor contra que un refactor se coma la instrucción).

## 4. El bloque `codegraph-protocol.md` (contrato agente ↔ grafo)

Doctrina que se inyecta cuando el plugin está activo. Puntos clave (en inglés, como el resto del harness):
1. **Consulta el grafo primero**: para "¿dónde vive X? ¿qué llama a Y? ¿qué rompe si cambio Z?",
   llama `codegraph_explore` (query en NL o bolsa de símbolos) ANTES de grep/read. 1 call, no un crawl.
2. **Rung -1 de structural-search**: el grafo forma la hipótesis; la escalera grep/ast-grep sigue
   siendo el verificador. No sustituye a `structural-search`, la precede.
3. ⚠️ **NO confíes ciego en "verbatim, do not Read"** (ver §6 riesgos): en índice stale o nombres
   ambiguos codegraph puede devolver el símbolo equivocado afirmando que es exacto. Para cambios
   críticos, verifica el span real con Read/Grep antes de escribir.
4. **Monorepo**: `codegraph_explore` acepta `projectPath`, pero ese modo abre el sub-proyecto SIN
   watcher → mayor riesgo de stale. Un `codegraph init`/`sync` por sub-repo mitiga.

## 5. Frescura del índice y git

**Decisión: gitignorear `.codegraph/`, NO commitearlo.** A diferencia de graphify (que commitea un
`graph.json` union-mergeable), el índice de codegraph es un SQLite binario con WAL que cambia en cada
sync → committearlo genera churn y merge conflicts. El flujo limpio:
- `.codegraph/` va al `.gitignore` (navori puede sumarlo en el bootstrap del plugin).
- `codegraph init` corre en `postInstall` (setup) y el watcher nativo lo mantiene fresco.
- El repo comparte la *instrucción* de usar codegraph (el managed block, que sí se commitea), no el índice.

*(Esto contradice la idea inicial de "grafo commiteado como managed asset" del análisis de inspiraciones;
el research del binario real lo desaconseja para codegraph. graphify sí soporta ese modelo — ver §8.)*

## 6. Riesgos y mitigaciones (lo crítico para un harness)

codegraph tiene issues de correctness ABIERTOS en v1.5.0 que importan porque la tool instruye al
modelo a "no leer el archivo, confía en esto":

| Riesgo | Issue | Mitigación en navori |
|--------|-------|----------------------|
| Índice stale devuelve el símbolo equivocado como "verbatim" | #1474 | El protocolo NO propaga ciego "do not Read"; `codegraph init` en bootstrap; re-sync antes de tareas críticas |
| `callers/callees/impact` responden por un fuzzy-match distinto sin avisar | #1473 | Doctrina: verifica el nombre exacto; el grafo forma hipótesis, no veredicto |
| blast-radius "no tests found" con ~40% falsos | #1475 | No usar el impact como gate de cobertura; los tests reales siguen mandando |
| El LLM deja de llamar la tool en tareas largas | #914 | Reforzar en el managed block; medir uso real en el rollout |
| Concurrencia lenta en stdio no-daemon | #1465 | ⚠️ Relevante para el paralelismo de navori (N implementers): evaluar server persistente antes de fan-out pesado |

**Veredicto:** integrable y de alto ROI potencial, pero **opt-in** y con el protocolo escrito para
NO confiar ciegamente. Es beta, no production-hardened.

## 7. Detección / opt-in / doctor

- **Opt-in** (requiere binario externo): se activa con `navori add codegraph` o un prompt en `init`
  ("¿instalar codegraph para contexto quirúrgico? requiere el binario"). Default OFF.
- **doctor**: vía `externalTool.checkBinary` navori ya reporta si `codegraph` no está en PATH +
  el comando de install. Añadir un check de "¿`.codegraph/` existe y está fresco?" (correr `codegraph status`).
- **Rollout**: validar en 1 repo real (dashboard/moonar) antes de ofrecerlo a los 15 Bonum; medir
  el uso real de la tool y el ahorro de tokens (las métricas del proyecto son self-reported).

## 8. Alternativas consideradas

- **graphify** — soporta el modelo "grafo commiteado al repo" (union merge driver, `# WHY:` como nodos).
  Es el complemento natural si se quiere contexto pre-built versionado; podría ser un **segundo plugin**
  aparte (no excluyente). Más amplio (código + docs), pero también menos maduro de verificar.
- **codebase-memory-mcp / code-review-graph / GitNexus** — competidores MCP; codebase-memory-mcp gana
  en perf/lenguajes, code-review-graph en workflow de PR. codegraph gana en instalación sin fricción
  (0 deps, auto-wiring de Claude+Codex) y el diseño de 1-tool. Revisitar si codegraph no madura.

## 9. Fases de implementación

1. **F1 — plugin skeleton**: `packages/plugins/codegraph/` (plugin.json + `managed/codegraph-protocol.md`
   + `skills/codegraph-rung.md`). Registrar en `KNOWN_PLUGINS`. Tests de manifest + render (settingsFragment,
   mcpServer a Claude y Codex, injectInto). **Depende de #166 (forma-directorio de skills) para el injectInto.**
2. **F2 — doctor**: check de índice fresco (`codegraph status`) + `.gitignore` de `.codegraph/`.
3. **F3 — opt-in en init/add** + prompt.
4. **F4 — validación en repo real** + medición de uso/tokens antes del rollout.

## 10. Decisiones abiertas

- ¿`codegraph` o `graphify` como primer plugin? (recomendación: codegraph por instalación sin fricción
  y soporte Codex nativo; graphify como follow-up si se quiere grafo commiteado).
- ¿Habilitar las 8 tools MCP (`CODEGRAPH_MCP_TOOLS`) o quedarse con `explore` (default)? (recomendación:
  empezar con `explore` — el propio proyecto colapsó a 1 tool por el "context tax").
- ¿Server persistente vs stdio por-invocación dado el paralelismo de navori? (evaluar con #1465).
