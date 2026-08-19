# Inspiración de navori-harness

> Proyectos que inspiraron a navori y que sirven de referencia para revisitar más
> adelante cuando toque **reestructurar** el harness. navori ya creció mucho desde
> su MVP; el objetivo de este documento es mantener presentes estas fuentes para un
> análisis comparativo futuro.
>
> Última revisión de contenidos: 2026-08-19. Los datos (métricas, versiones,
> features, licencias) reflejan lo publicado por cada proyecto a esa fecha y
> conviene re-verificarlos antes de tomar decisiones. Varios de estos proyectos
> cambian rápido: entre la revisión anterior (2026-07-27) y esta, dos de ellos
> retiraron o dejaron de publicar cifras que este documento citaba.

## Índice

| Proyecto | Categoría | Qué aporta como referencia |
|----------|-----------|----------------------------|
| [gstack](#gstack) | Factory de skills + roles | Skills encadenadas por rol; multi-host; cross-model review |
| [gentle-ai](#gentle-ai) | Configurador de ecosistema | SDD + memoria persistente + routing por fase (muy cercano a navori) |
| [codegraph](#codegraph) | Code intelligence (MCP) | Contexto quirúrgico vía grafo; eficiencia de tokens (con contraparte) |
| [graphify](#graphify) | Code intelligence (MCP) | Knowledge graph multi-fuente (código+docs); extracción determinista sin LLM |
| [ponytail](#ponytail) | Ruleset anti-over-engineering | Escalera de decisión "lazy senior" (paralelo a structural-search) |
| [superpowers](#superpowers) | Metodología + skills | Flujo brainstorm→spec→plan→TDD; subagentes por tarea |
| [ejemplo-harness-subagentes](#ejemplo-harness-subagentes) | Referencia de harness | Patrón Leader/Implementer/Reviewer; estado en disco |
| [harness-sdd](#harness-sdd) | Referencia de harness + SDD | Máquina de estados en filesystem; EARS; traceability |
| [caveman](#caveman) | Compresión de output | Eficiencia de tokens vía skill de brevedad |
| [Goose](#goose) | Agente open source | MCP/ACP profundo; recipes YAML; subagentes |
| [Pi](#pi) | Harness minimalista | "Primitivas, no features"; skills on-demand; extensibilidad |

---

## gstack
- **URL**: https://github.com/garrytan/gstack — MIT.
- **Qué es**: CLI open source que convierte Claude Code en un "equipo de ingeniería
  virtual". Empaqueta 23 skills especializadas (CEO, designer, eng manager, QA lead,
  security officer, release manager, doc engineer) como slash commands.
- **Problema**: el coding con IA carece de estructura y proceso (roles, revisión de
  diseño, rigor de testing, seguridad de deploy).
- **Enfoque**: skills encadenadas que producen artefactos estructurados que consumen
  otras skills; ningún paso corre aislado (`/autoplan`, `/spec`, `/review`, `/ship`,
  `/retro`).
  > **Lectura nuestra, no cita**: en la revisión de julio describimos esto como una
  > "metodología de sprint Think → Plan → Build → Review → Test → Ship → Reflect".
  > Esa cadena de siete fases **no aparece con esas palabras** en la fuente, que
  > presenta un catálogo de roles y slash commands. La idea de pipeline sí está viva;
  > el nombre de las fases es interpretación propia y no debe publicarse como cita.
- **Stack**: TypeScript sobre **Bun v1.0+** (requisito, no preferencia); **Node.js
  solo en Windows** — no es un fallback general. Playwright + Chrome DevTools
  Protocol, Supabase/PGLite, memoria "GBrain".
- **Conceptos notables para navori**:
  - Skills que producen artefactos que consumen otras skills (pipeline de roles).
  - Auto-detección de host con un config por host → **multi-engine**, muy alineado
    con navori. Ya cubre 9 hosts (Claude Code, Codex CLI, OpenCode, Cursor, Factory
    Droid, Slate, Kiro, Hermes, GBrain); para Codex lee el `model` de `config.toml` y
    genera las skills correspondientes.
  - Cross-model review (`/codex`): revisión independiente de OpenAI Codex sobre el
    mismo diff, con tres modos (review con gate pass/fail, challenge adversarial,
    consulta abierta) y análisis cruzado cuando `/review` y `/codex` corrieron sobre
    la misma rama.
  - Safety por defecto: `/careful`, `/freeze`/`/unfreeze`, `/guard`, auditoría
    OWASP+STRIDE en `/cso`.
  - Memoria persistente de agentes entre sesiones (paralelo a Engram).
- **Nuevo desde 2026-07-27**: `/pair-agent` (coordinación multi-agente sobre un mismo
  navegador), `/spec` (spec author con gate de calidad de Codex), `gstack-egress`
  (auditor de egress con recibos hash-encadenados), `gstack-code-intelligence`
  (envuelve GBrain, Sourcebot y **Graphify** tras una sola interfaz),
  `gstack-verify-gate` (stop hook que bloquea el fin de turno hasta que pase el
  verify) y defensa contra prompt injection con clasificador ML local.

## gentle-ai
- **URL**: https://github.com/Gentleman-Programming/gentle-ai — MIT.
- **Qué es**: configurador de ecosistema que dota a agentes existentes (Claude Code,
  OpenCode, Cursor…) de memoria persistente, workflows estructurados y tooling
  unificado. No es un agente, es infraestructura que los aumenta.
- **Problema**: los agentes son "chatbots que escriben código" sin continuidad entre
  sesiones; fragmentación de contexto y tooling.
- **Enfoque**: **Organic Implementation Routing** (empareja complejidad de tarea con
  modo de ejecución: inline / subagente / estado SDD opcional; reglas en
  `docs/trigger-rules.md`). **Receipt-Driven Development (RDD)**: congela el candidato
  tras implementar y todos los gates de entrega (pre-commit → pre-push → pre-pr)
  validan **el mismo** recibo, así la confianza sale de los gates y no de la narración
  del agente.
  > **Ajuste 2026-08-19**: RDD **es opt-in y viene apagado por defecto**
  > (`gentle-ai review mode enable --scope global`). Apareció en `v1.47.0` y se volvió
  > la ruta estable soportada en `v2.2.0` (contrato público de review en `v2.1.6`).
  > La revisión anterior lo presentaba como el comportamiento por defecto.
- **Stack**: **Go 1.25.10+**, Engram (memoria cross-session), OpenSpec (artefactos
  versionados), releases verificados con minisign (el upgrader valida la firma de
  `checksums.txt`, el binding al repo + tag y el checksum del archivo antes de
  reemplazar el binario). Los artefactos SDD viven en Engram, en OpenSpec o híbrido.
  En Windows la distribución de binarios y Scoop está **temporalmente no disponible**
  (esperando firma Authenticode); ahí hay que instalar desde fuente.
- **Conceptos notables para navori**: **es el proyecto más cercano a navori** —
  SDD + Engram + routing de modelo por fase + review acotado. El routing orgánico y el
  "revisar el candidato solo después de implementar" son casi el mismo modelo que el
  bloque `## Role: orchestrator` de navori. Vale la pena comparar a fondo la capa de
  cascada y el modelo de routing.
- **Nuevo desde 2026-07-27**: **Pi es soporte de primera clase** — seleccionar Pi
  instala el harness `gentle-pi` con persona, modelos, SDD, chains y memoria Engram
  nativos de Pi (conecta dos entradas de este mismo documento). La matriz de agentes
  es Claude Code, OpenCode, Kilo Code, Cursor, Codex, Pi y Hermes. Supersede a
  *Agent Teams Lite*, ya archivado.

## codegraph
- **URL**: https://github.com/colbymchenry/codegraph — MIT.
- **Qué es**: grafo de conocimiento pre-indexado (símbolos, dependencias, call flows)
  expuesto como servidor MCP para agentes.
- **Problema**: los agentes descubren estructura de código de forma ineficiente
  (loops de grep/read), reconstruyendo call paths repetidamente.
- **Enfoque**: "contexto quirúrgico en una llamada" — símbolos relevantes + código +
  call paths + blast-radius juntos.

### ⚠️ Las métricas viejas fueron retiradas por el propio proyecto

La revisión de julio citaba *"89% menos tool calls, 60% menos costo, 69% menos tokens"*.
**Esas cifras ya no son las publicadas y el proyecto las repudió explícitamente**: su
brazo de control encontraba el CLI de `codegraph` y llegaba al grafo por Bash en 26 de
28 corridas, así que el experimento estaba contaminado. El README lo dice textual:
*"Earlier published figures were produced without this block."*

Las vigentes salen de una **re-medición del 2026-08-05** sobre Claude Opus 4.8, mediana
de 4 corridas por brazo, en 7 repos open source (VS Code, Excalidraw, Django, Tokio,
OkHttp, Gin, Alamofire), con el CLI bloqueado en **ambos** brazos vía `PATH` saneado +
hook `PreToolUse`:

> **88% menos tool calls · 53% más rápido · 62% menos tokens · 44% más barato ·
> cero lecturas de archivo en los siete repos.**

**No cites nunca las cifras viejas.**

### ⚠️ Contraparte: deja ~80% MÁS contexto residual

El mismo README publica una advertencia que juega **en contra** de la tesis de
reducción de contexto:

> CodeGraph deja **~80% más contexto de retrieval residente** al final de una sesión
> multi-turno que un agente que lee archivos — en VS Code, **67k tokens contra 18k**.

El mecanismo es el que lo hace rápido: devuelve un payload denso y verbatim que se
queda en la ventana, mientras que grep-and-read produce muchos resultados chicos que se
van desalojando. "Menos tokens procesados" y "mayor huella persistente" son ciertas a
la vez. Medido por repo en `docs/benchmarks/residual-context-occupancy.md`.

**Esto le pega directo a navori**: el plugin de codegraph está activo en este repo y lo
citamos como argumento de los specs **0005 (eficiencia de búsqueda)** y **0006
(reducción de contexto)**. La mitad favorable (menos tool calls, menos tokens
procesados) es real; la desfavorable (más contexto residente en sesiones largas)
también, y afecta justo al eje que 0006 quiere optimizar. Cualquier análisis futuro
tiene que cargar las dos.

### Resto
- **Stack**: kernel nativo en Rust con gramáticas tree-sitter **compiladas dentro**
  (20 lenguajes de primera clase; el resto cae a un motor portable con el mismo grafo),
  SQLite + FTS5 (`.codegraph/codegraph.db`, WAL), file watchers nativos
  (FSEvents/inotify/ReadDirectoryChangesW) con auto-sync debounced, servidor MCP stdio,
  100% local (*"No data leaves your machine"*).
  > GitHub clasifica el repo como C por las gramáticas vendorizadas; el kernel sigue
  > siendo Rust.
- **Conceptos notables para navori**: el diseño de instrucciones que aleja al modelo
  del file-reading redundante es la misma filosofía que `structural-search`.
- **Nuevo desde 2026-07-27**: soporte declarado para 9 agentes; instalación sin Node
  (bundle propio); `codegraph upgrade`; npm provenance y builds firmados; bridging
  iOS/React Native/Expo cross-lenguaje; y **producto hospedado comercial en waitlist**
  (getcodegraph.com) — el CLI sigue MIT, pero ya no es "solo un proyecto open source".

## graphify
- **URL**: https://github.com/Graphify-Labs/graphify — Apache-2.0.
  > ⚠️ **El default branch cambió de `main` a `v8`**: cualquier permalink del tipo
  > `github.com/Graphify-Labs/graphify/blob/main/...` da 404. Enlaza siempre la raíz
  > del repo; si hiciera falta un permalink, tiene que ser `/blob/v8/`.
- **Qué es**: convierte codebases en knowledge graphs consultables por agentes
  (skill `/graphify` + servidor MCP). *"Works in Claude Code, Cursor, Codex, Gemini
  CLI, GitHub Copilot, and 15+ more"*.
- **Problema**: los devs/agentes pierden tiempo grepeando archivos para entender
  estructura y relaciones; el contexto llega como file dumps crudos que desperdician
  tokens.
- **Enfoque**: modelo híbrido — extracción de código **determinista y 100% local**
  vía AST (tree-sitter, **~40 lenguajes**, sin LLM) + capa semántica para
  docs/PDFs/imágenes/video/audio usando el modelo del IDE. Cada relación se etiqueta
  `EXTRACTED` (explícita en la fuente) o `INFERRED` (resuelta por graphify). Detección
  de comunidades (Leiden) para particionar el grafo en subsistemas, con labels
  automáticos y **LLM-free**.
- **Stack**: **Python** — se instala con `uv tool install graphifyy` o `pipx`, y se
  publica en PyPI como `graphifyy`. tree-sitter, algoritmo Leiden, servidor MCP
  stdio/HTTP (extra `graphifyy[mcp]`, 7 tools: `query_graph`, `get_node`,
  `get_neighbors`, `shortest_path`, `list_prs`, `get_pr_impact`, `triage_prs`),
  múltiples backends LLM para la capa semántica, exports a HTML interactivo,
  Neo4j/FalkorDB, Obsidian y GraphML.
- **Conceptos notables para navori**:
  - Complementa a codegraph en los specs **0005/0006**: `graphify query` devuelve un
    subgrafo acotado en vez de un file dump, y `graphify path A B` traza la conexión
    entre dos nodos — razonar arquitectura sin leer archivos completos.
  - **Grafo commiteado al repo**: *"`graphify-out/` is meant to be committed to git so
    everyone on the team starts with a map"* — análogo a los managed assets de navori.
    Hooks post-commit lo mantienen fresco y un **merge driver de git** evita que
    `graph.json` quede con conflict markers (union-merge automático).
  - Comentarios `# NOTE:`/`# WHY:` (más citas ADR/RFC) como nodos de primera clase.
  - Extracción determinista y verificable (sin embeddings) → reproducibilidad, misma
    filosofía anti-alucinación que la doctrina de `structural-search`.
  - **Strict mode en Claude Code** (`graphify install --project --strict`): bloquea la
    primera lectura de fuente cruda de la sesión y la redirige al grafo, después vuelve
    al nudge suave. Es la doctrina de `structural-search` implementada como hook.
- **A saber antes de recomendarlo**: el **query logging local está activo por defecto**
  (`~/.cache/graphify-queries.log`, JSON Lines; los subgrafos completos no se guardan;
  opt-out con `GRAPHIFY_QUERY_LOG_DISABLE=1`). Y Graphify Labs es **YC S26** con una
  plataforma de pago en early access: el repo OSS es Apache-2.0, pero hay brazo
  comercial activo.

## ponytail
- **URL**: https://github.com/DietrichGebert/ponytail — MIT.
- **Qué es**: plugin/ruleset que fuerza a los agentes a generar código minimalista —
  "pensar como el senior dev más flojo de la sala". El badge oficial dice **"works with
  20 agents"** (20 exactos, sin "+").
- **Problema**: los agentes sobre-ingenierizan (deps innecesarias, wrappers verbosos).
- **Números vigentes**: **~54% menos código**, media de 12 tareas de feature sobre
  `fastapi/full-stack-fastapi-template`, Haiku 4.5, n=4, contra el mismo agente sin la
  skill; además **−22% tokens, −20% costo, −27% tiempo y 100% safe**. Llega a 94% donde
  el agente sobre-construye (un date picker: 404 → 23 líneas) y casi a cero donde el
  código ya es mínimo. Es el único brazo que baja todas las métricas **conservando** los
  guardrails: un prompt genérico de "YAGNI + one-liners" cae a 95% de seguridad.
  > El propio README aclara que su benchmark viejo de "80-94% menos código" era en parte
  > artefacto de un baseline conversacional; la cifra agéntica corregida es el ~54%.
  > Este documento nunca citó el 80-94%.
- **Enfoque**: escalera de decisión jerárquica *después* de entender el problema:
  ¿debe existir? → ¿ya está en el codebase? → ¿stdlib? → ¿feature nativa? → ¿dep
  instalada? → ¿una línea? → mínimo viable. "Flojo en la solución, nunca en la lectura".
- **Stack**: hooks Node.js (dos lifecycle hooks, Claude Code y Codex) + skill
  definitions; niveles `lite`/`full`/`ultra`/`off`, **default `full`** (configurable con
  `PONYTAIL_DEFAULT_MODE` o `~/.config/ponytail/config.json`). Si `node` no está en el
  PATH la skill sigue funcionando, solo se calla.
- **Conceptos notables para navori**: la escalera de decisión es un paralelo directo a
  la doctrina Rung 0-2 de `structural-search` y a la sección YAGNI del `implementer`.
  Marcador `ponytail:` para deuda diferida. **Inyecta su ruleset en cada subagente**
  lanzado con la herramienta Agent, acotable con `PONYTAIL_SUBAGENT_MATCHER` — que es
  exactamente el problema de "cómo hago que la regla llegue al worker, no solo al
  orquestador" que navori resuelve con managed blocks.

## superpowers
- **URL**: https://github.com/obra/superpowers — MIT.
- **Qué es**: metodología + framework de skills para agentes, multi-plataforma.
- **Problema**: los agentes saltan a codear sin validar specs, sin desglose de
  tareas, sin TDD ni review sistemático.
- **Enfoque**: fases secuenciales — brainstorm hasta sacar la spec → mostrarla en
  trozos digeribles → tras el visto bueno, plan de implementación → con un "go" arranca
  el proceso subagent-driven → TDD red/green + YAGNI + DRY → review → completion. Las
  skills se disparan automáticamente.
- **Plataformas**: 13 entradas en el índice actual — Claude Code, Antigravity, Codex
  App y Codex CLI (por separado, vía el marketplace oficial de plugins de OpenAI),
  Cursor, Factory Droid, Gemini CLI, Copilot CLI, Kimi, OpenCode, Devin CLI, Grok Build
  CLI, Hermes Agent y **Pi** (`pi install git:github.com/obra/superpowers`). La
  instalación es por plugin/marketplace de cada plataforma, no por npm.
- **Conceptos notables para navori**: "spec tan detallada que un junior entusiasta la
  puede seguir" (cita casi literal: *"clear enough for an enthusiastic junior engineer
  with poor taste, no judgement, no project context, and an aversion to testing to
  follow"*); **subagent-driven development** — agente fresco por tarea, y *"it's not
  uncommon for your agent to work autonomously for a couple hours at a time without
  deviating from the plan"*.
- **No verificable en la fuente pública** (lo citaba la revisión de julio; no publicarlo
  como dato del proyecto): el tamaño concreto de "tareas de 2-5 min" y el "review de dos
  etapas (compliance de spec + calidad)". La idea de tareas granulares y de inspeccionar
  el trabajo sí está; los detalles probablemente vengan de las skills internas.
- **Nuevo**: el README ya tiene sección de *Commercial Services*. La licencia sigue MIT.

## ejemplo-harness-subagentes
- **URL**: https://github.com/betta-tech/ejemplo-harness-subagentes
- **Qué es**: CLI mínima de notas en Python que demuestra principios de **Harness
  Engineering** dentro de un repo versionado con git. *"Lo importante no es qué hace,
  sino cómo está estructurado"*.
- **Problema**: hacer confiables los workflows multi-agente evitando cuellos de
  comunicación, decisiones no verificables y pérdida de historial.
- **Enfoque**: patrón de tres roles — **Leader** (orquesta, no edita código),
  **Implementer** (ejecuta, loguea a `progress/impl_*.md`), **Reviewer** (valida
  contra estándares, no modifica): *"el leader no implementa, el implementador no se
  autoaprueba, el revisor no edita código"*. "Especificación como repositorio"
  (`AGENTS.md`, `CHECKPOINTS.md`, `feature_list.json`) con disclosure progresivo —
  *"el agente no recibe todas las reglas de golpe, recibe un mapa para buscarlas bajo
  demanda"*.
- **Stack**: Python 3, argparse, JSON, pytest.
- **Conceptos notables para navori**: **anti-teléfono-descompuesto** — los agentes
  escriben reportes completos a archivos y por chat solo pasan referencias
  (`done -> progress/impl_<feature>.md`, la misma forma que usa navori). Estado en
  disco, no en chat efímero (*"sobreviven a reinicios y context windows reventadas"*).
  Una feature a la vez (`init.sh` rechaza más de un `in_progress`). Verificación
  ejecutable: *"`init.sh` corre los tests reales, no se fía de lo que diga el agente"*.
- **⚠️ Licencia (interno)**: el repo **no tiene archivo de licencia** (`license: null`),
  así que por defecto es "todos los derechos reservados". Enlazarlo y describirlo es
  citación normal y no hay problema; **copiar código de ahí a navori sin permiso
  explícito, no**. Sin commits desde 2026-04-29 y sin `description` ni topics en GitHub
  (cualquier tarjeta automática con metadata de la API saldría vacía).

## harness-sdd
- **URL**: https://github.com/betta-tech/harness-sdd
- **Qué es**: variante del anterior con foco explícito en **SDD**; misma CLI de notas
  como referencia de Harness Engineering con supervisión humana.
- **Enfoque**: patrón **Leader-Spec-Implementer-Reviewer** (4 roles sin solape:
  `leader.md`, `spec_author.md`, `implementer.md`, `reviewer.md`) — *"el leader no
  implementa, el spec_author no codifica, el implementer no se autoaprueba, el reviewer
  no edita código"*. Las features fluyen `pending` → `spec_ready` (**el leader para y
  pide aprobación humana**) → `in_progress` → `done`. **Filesystem como máquina de
  estados** (`specs/`, `progress/`).
- **Stack**: Python 3, argparse, JSON, pytest.
- **Conceptos notables para navori**: **notación EARS** para requisitos (`R1`, `R2`)
  mapeados a tests concretos; **traceability obligatoria** (*"cada `R<n>` se mapea a un
  test concreto; el reviewer rechaza si falta"*, y el `impl_<feature>.md` incluye un
  mapa `R<n> → test`) — el mismo mecanismo que usa navori. Specs residentes en disco que
  sobreviven resets de contexto; disclosure progresivo en `AGENTS.md`. La estructura
  `specs/<feature>/{requirements.md, design.md, tasks.md}` que navori adoptó está aquí, y
  el propio README la llama **"Kiro-style"**.
- **⚠️ Licencia (interno)**: igual que el anterior — **sin archivo de licencia**,
  todos los derechos reservados por defecto. Citar y enlazar sí; copiar código, no. Sin
  commits desde 2026-06-03, sin `description` ni topics.

## caveman
- **URL canónica**: https://github.com/JuliusBrussee/caveman — **ojo con el casing**: la
  URL en minúsculas (`juliusbrussee`) solo funciona por la redirección
  case-insensitive de GitHub. Sitio: https://caveman.so/. Versión de referencia: v2.1.0.
- **Qué es**: skill/plugin para Claude Code y 30+ agentes que comprime el output del
  agente **~65%** preservando exactitud técnica (*"code, commands, and errors stay
  byte-for-byte exact"*; tabla: 1214 → 294 tokens de promedio). El alcance ya es más
  amplio que "una skill": v2.1.0 trae `caveman wrap` (proxy local que enruta el tráfico
  del proveedor), servidor MCP con 5 herramientas, subagentes comprimidos
  (`cavecrew-investigator`, `cavecrew-builder`, `cavecrew-reviewer`), `caveman explore`,
  `caveman shrink`, `caveman browse` y **skills-as-images** (renderiza el cuerpo de cada
  `SKILL.md` a PNG; −61% medido sobre su propia skill).
- **Problema**: los agentes son innecesariamente verbosos → desperdician tokens de
  salida y suben costos.
- **Enfoque**: inyecta una skill basada en prompt que instruye a soltar relleno, usar
  fragmentos y preservar código/comandos/errores exactos.
- **⚠️ El "~46% menos tokens de entrada" no es verificable**: la revisión de julio se lo
  atribuía a `/caveman-compress`. El comando sigue existiendo (*"Smaller Markdown memory
  files, with the original backed up"*) pero **sin porcentaje asociado en la fuente**.
  No publicar esa cifra. La única cifra de tokens de **entrada** que publican hoy es de
  otro mecanismo: 33.2% menos input tokens reportados por el proveedor usando
  `caveman wrap`, en un benchmark fijado de 54 corridas de Claude Code.
- **⚠️ Matiz que el propio proyecto añadió al 65%** ("Honest number warning"): la skill
  **solo** comprime tokens de **salida**; entrada y razonamiento quedan intactos, y la
  propia skill **suma ~1–1.5k tokens de entrada por turno**. El ahorro de sesión completa
  es menor que el número de salida y **en cargas ya concisas puede ser net-negativo**.
  Su conclusión: *"The real win is readability and speed; cost savings are the bonus."*
  Como navori cita a caveman precisamente por eficiencia de tokens, este matiz tiene que
  viajar con la cifra.
- **⚠️ Licencia: ya no es MIT limpia**. GitHub reporta `NOASSERTION` porque es doble:
  - **MIT** — la skill, Agent SDK e initializer, la CLI, los SDKs (TS + Python), kit,
    evals/graders, contracts, catálogo de proveedores, shell de la extensión y los
    clientes finos de cavemem.
  - **BSL-1.1** — **Engine, Proxy, Cache Engine, rewriter, Browse, servidor MCP,
    `shrink`, el core Go de cavemem y la plataforma Go compartida.** Source-available:
    se puede leer, forkear y auto-hospedar para tráfico propio de primera parte, pero el
    uso hospedado/gestionado/embebido por terceros requiere licencia comercial. Cada
    versión BSL se convierte a Apache-2.0 el 2030-06-21 o cuatro años después de
    publicarse.

    Si algún texto de navori mete a caveman bajo un paraguas de "todo esto es open
    source MIT", con caveman ya no aplica.
- **Stack**: el núcleo hoy es **Go** (engine, proxy, core de cavemem, tree-sitter vía
  cgo con fallback puro Go) — la revisión de julio decía "Node.js ≥18" y quedó obsoleta.
  Se instala con `npm install -g @caveman-ai/cli`; Node 18+ solo lo exige el instalador
  completo. Siguen existiendo `install.sh` / `install.ps1`.
- **⚠️ El ecosistema relacionado está congelado**: `caveman-code` y `cavemem` están
  marcados **`frozen`** — *"Frozen repos still install and work; they are no longer in
  active development. Their best ideas live on here: cavemem's compressed-memory core
  ships inside caveman, and caveman-code's lesson became `caveman wrap`."* Citarlos como
  "ecosistema relacionado" sin esa aclaración induce a error.
- **Conceptos notables para navori**: eficiencia de tokens como skill transversal;
  "restricciones de brevedad invierten jerarquías de performance" — la tesis detrás del
  bloque de concisión de navori.

## Goose
- **URL (docs)**: https://goose-docs.ai/ · **Código**:
  https://github.com/aaif-goose/goose (Block donó goose a la Linux Foundation / AAIF en
  diciembre de 2025 junto con MCP y AGENTS.md; el repo ya **no** es `block/goose`).
- **Qué es**: agente de IA general open source (desktop, CLI, API), *"built in Rust for
  performance and portability"*, bajo la Agentic AI Foundation (Linux Foundation).
- **Problema**: automatizar trabajo (código, research, análisis) sin lock-in de
  plataforma ni de proveedor de LLM.
- **Enfoque**: multi-interfaz, vendor-neutral (15+ proveedores LLM), construido sobre
  dos estándares abiertos: **MCP** y **ACP** (Agent Client Protocol) — funciona como
  servidor ACP para varios editores.
- **Stack**: backend en Rust, 70+ extensiones MCP.
- **Conceptos notables para navori**: **Recipes** (configs YAML portables que capturan
  workflows para compartir en equipo y CI/CD) — análogo a los assets manejados de
  navori; **subagentes** para tareas paralelas; features de seguridad (detección de
  prompt injection, sandbox, adversary reviewer).

## Pi
- **URL**: https://pi.dev/ — **Pi Coding Agent**, de **Earendil Inc.**
- **Qué es**: harness de agente minimalista y extensible (CLI). *"Pi is a minimal agent
  harness. Adapt Pi to your workflows, not the other way around."*
- **Problema**: las herramientas monolíticas obligan a conformarse a workflows
  predefinidos; Pi deja que el dev moldee la funcionalidad sin bloat.
- **Enfoque**: cuatro modos (TUI interactivo, print/JSON, RPC sobre stdin/stdout, SDK
  para embeber). Filosofía **"primitivas, no features"**: explícitamente **no** hornea
  MCP, sub-agentes ni plan mode; los ofrece como puntos de extensión en TypeScript sobre
  tools, commands y events.
- **Conceptos notables para navori**:
  - **Skills** cargadas on-demand: *"Progressive disclosure without busting the prompt
    cache"* — mismo principio que la capa de skills de navori.
  - Context engineering: `SYSTEM.md` que reemplaza o extiende el prompt por proyecto,
    `AGENTS.md`, auto-compaction customizable por extensiones, inyección dinámica.
  - Sesiones en árbol (branches navegables), exportables a HTML (`/export`) o a un gist
    de GitHub (`/share`).
  - Model flexibility con switching a mitad de sesión (`/model`), 15+ proveedores.
- **Señal de vigencia**: dos proyectos de este mismo documento ya tratan a Pi como host
  de primera clase — superpowers se instala con `pi install`, y gentle-ai empaqueta el
  harness `gentle-pi`.

---

## Temas transversales (para el análisis de reestructuración)

Agrupando las fuentes, estos son los ejes que conviene revisar cuando toque
reestructurar navori:

1. **Multi-engine / multi-host** (gstack, ponytail, superpowers, caveman): auto-detección
   de host y un config por host. navori ya va por aquí (Claude + Codex + AGENTS.md).
2. **SDD como máquina de estados en disco** (harness-sdd, ejemplo-harness-subagentes,
   gentle-ai, superpowers): specs versionadas, gates de aprobación humana, EARS,
   traceability requisito↔test.
3. **Roles/subagentes con estado en filesystem** (harness-sdd, ejemplo-harness-subagentes,
   Goose, superpowers): Leader/Implementer/Reviewer, anti-teléfono-descompuesto.
4. **Eficiencia de tokens / contexto** (codegraph, graphify, ponytail, caveman, Pi):
   contexto quirúrgico, subgrafos acotados, escalera anti-over-engineering, compresión
   de output, skills on-demand. Conecta con specs **0005** y **0006** de navori.
   **Con una lección de esta revisión**: dos de los cuatro proyectos que citábamos por
   eficiencia matizaron su propia cifra en un mes — codegraph publicó que deja ~80% más
   contexto residual en sesiones multi-turno, y caveman que su compresión es solo de
   salida y puede ser net-negativa en cargas concisas. Ninguna métrica de ahorro de
   tokens de terceros entra a una decisión de navori sin su contraparte.
5. **Memoria persistente** (gstack/GBrain, gentle-ai/Engram, caveman/cavemem): navori
   ya usa Engram. Ojo: cavemem está frozen y su core vive dentro de caveman.
6. **Cross-model review** (gstack, gentle-ai/RDD): revisión independiente entre modelos
   sobre el mismo diff, confianza derivada de gates y no de narración.
7. **Extensibilidad vs. opinión** (Pi "primitivas, no features" vs. gstack/superpowers
   opinados): decisión de diseño clave para el rumbo de navori.
8. **Licencias y brazo comercial** (nuevo en esta revisión): caveman ya no es MIT limpia
   (núcleo BSL-1.1), los dos repos de betta-tech no tienen licencia, y codegraph y
   graphify tienen producto comercial activo. Para citar y enlazar no hay problema en
   ningún caso; para **copiar código o presentarlos como "todo open source MIT"**, sí.
