# Inspiración de navori-harness

> Proyectos que inspiraron a navori y que sirven de referencia para revisitar más
> adelante cuando toque **reestructurar** el harness. navori ya creció mucho desde
> su MVP; el objetivo de este documento es mantener presentes estas fuentes para un
> análisis comparativo futuro.
>
> **Este documento se revisa por tandas, y cada ficha lleva la fecha de la suya.**
>
> - **2026-08-19** — el grueso del documento: gstack, gentle-ai, codegraph, graphify,
>   ponytail, superpowers, los dos repos de betta-tech, caveman, Goose y Pi.
> - **2026-09-10** — alta de [claude-code-harness](#claude-code-harness-cch) y de
>   [awesome-harness-engineering](#awesome-harness-engineering), ambos con análisis
>   completo en `docs/research/`.
> - **2026-09-15** — alta de [ECC](#ecc-everything-claude-code),
>   [deepseek-harness](#deepseek-harness-dsh), [revfactory/harness](#revfactoryharness),
>   [learn-harness-engineering](#learn-harness-engineering) y
>   [OpenHarness](#openharness), más una re-revisión de CCH que **no** encontró cambios
>   upstream (detalle en su ficha). Las estrellas, forks, fechas de push y licencias de
>   esos cinco repos salen de `gh api` ese mismo día.
>
> Los datos (métricas, versiones, features, licencias) reflejan lo publicado por cada
> proyecto **a la fecha de su tanda** y conviene re-verificarlos antes de tomar
> decisiones. Varios de estos proyectos cambian rápido: entre la revisión de 2026-07-27
> y la de 2026-08-19, dos de ellos retiraron o dejaron de publicar cifras que este
> documento citaba.

## Índice

| Proyecto | Categoría | Qué aporta como referencia |
|----------|-----------|----------------------------|
| [gstack](#gstack) | Factory de skills + roles | Skills encadenadas por rol; multi-host; cross-model review |
| [gentle-ai](#gentle-ai) | Configurador de ecosistema | SDD + memoria persistente + routing por fase (muy cercano a navori) |
| [claude-code-harness](#claude-code-harness-cch) | Harness multi-engine + guardrails | Un motor de políticas para N hosts; guardrail con veredicto "indeterminado"; contratos JSON entre agentes |
| [ECC](#ecc-everything-claude-code) | Distribución multi-engine a escala | Catálogo congelado de 14 motores; plan/apply con estado sellado; política de admisión de MCP |
| [deepseek-harness](#deepseek-harness-dsh) | Runtime de agentes + disciplina documental | Presupuesto de palabras por documento con gate; registro central de gates; decisiones como corpus |
| [codegraph](#codegraph) | Code intelligence (MCP) | Contexto quirúrgico vía grafo; eficiencia de tokens (con contraparte) |
| [graphify](#graphify) | Code intelligence (MCP) | Knowledge graph multi-fuente (código+docs); extracción determinista sin LLM |
| [ponytail](#ponytail) | Ruleset anti-over-engineering | Escalera de decisión "lazy senior" (paralelo a structural-search) |
| [superpowers](#superpowers) | Metodología + skills | Flujo brainstorm→spec→plan→TDD; subagentes por tarea |
| [ejemplo-harness-subagentes](#ejemplo-harness-subagentes) | Referencia de harness | Patrón Leader/Implementer/Reviewer; estado en disco |
| [harness-sdd](#harness-sdd) | Referencia de harness + SDD | Máquina de estados en filesystem; EARS; traceability |
| [caveman](#caveman) | Compresión de output | Eficiencia de tokens vía skill de brevedad |
| [Goose](#goose) | Agente open source | MCP/ACP profundo; recipes YAML; subagentes |
| [Pi](#pi) | Harness minimalista | "Primitivas, no features"; skills on-demand; extensibilidad |
| [revfactory/harness](#revfactoryharness) | Meta-factory (competidor directo) | Taxonomía de capas del campo; matriz que decide qué fases correr; skill testing with-skill vs baseline |
| [learn-harness-engineering](#learn-harness-engineering) | Curso + scorer de harnesses | Framework de cinco subsistemas; `evals/evals.json`; `validate-harness.mjs` con umbral en CI |
| [OpenHarness](#openharness) | Runtime + doctrina de evaluación | `harness-eval`: nunca evaluar el harness sobre sí mismo; `Key Assertion` por área |
| [awesome-harness-engineering](#awesome-harness-engineering) | Índice del campo (meta) | Taxonomía por problema, no por vendor; bibliografía sobre activación de skills y permisos |

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

## claude-code-harness (CCH)
- **URL**: https://github.com/Chachamaru127/claude-code-harness — MIT. Revisado
  2026-09-10 sobre v5.15.0.
- **Re-revisado el 2026-09-15: el upstream no había cambiado.** HEAD `2b2b748`
  (2026-09-06), el mismo v5.15.0 que cubre el análisis del 2026-09-10 — no hace falta
  repetir la pasada hasta que se mueva la versión.
- **Análisis completo**: [`docs/research/claude-code-harness-lessons.md`](research/claude-code-harness-lessons.md).
  Lo de abajo es sólo el resumen.
- **Qué es**: harness de ciclo completo (`plan` → `work` → `review` → `sync` →
  `release`) para Claude Code, Codex CLI, Cursor y Grok, con un motor de guardrails
  en Go. El humano aprueba el contrato (`spec.md` + `Plans.md`), no lo escribe.
- **Problema**: mismo que navori en la capa multi-engine, pero resuelto desde el
  lado del producto: CCH **es** el harness; navori **genera** harnesses. No compiten
  en distribución.
- **Stack**: Go nativo (403 `.go`, ~55 paquetes), 430 scripts shell, 23 skills, 5
  agentes, 282 tests. Cuatro binarios de ~13 MB commiteados (no requiere Node.js).
- **Cableado (lo central)**:
  - Un binario Go es el **dispatcher único de hooks**: `hooks.json` declara 43 grupos
    de eventos y todos llaman `bin/harness hook <name>` (58 handlers). El JSON no
    tiene lógica; el bootstrap inline valida el plugin root y hace fail-open.
  - **`hosts.toml` = capacidades por host como dato** (evento, path, matcher,
    mecanismo de deny `exit2`/`permissionDecision`/`permission`, transport). `harness
    gen` materializa el hook nativo de cada host apuntando al **mismo** motor de
    políticas, y `gen --check` es el drift gate.
  - Skills con **metadata de diseño** (`kind`/`shape`/`role`/`base`/`pair`) y un gate
    de CI sobre el grafo: `wrap` obliga `base`, y **`role: evaluator` no puede tener
    tools de escritura**. Anti-triggers (`Do NOT load for: …`) dentro del propio
    `description`, que es el SSOT de ruteo.
  - Agentes con `disallowedTools` además de `tools`, `isolation: worktree`,
    `maxTurns`, y **contratos JSON versionados** entre ellos (`worker-report.v1`,
    `advisor-response.v1`, `test-wiring-audit.v1`).
- **Conceptos notables para navori** (detalle y prioridad en el análisis completo):
  - **Tercer veredicto "indeterminado"** en el guard de comandos: si no puede probar
    estáticamente el blanco de un `rm -rf`, no adivina — rutea a `ask`. Aplica directo
    al issue #655.
  - **Cola de operaciones diferidas**: el deny no mata el run; encola, devuelve al
    agente un contrato de conducta y el operador aprueba fuera de banda (un solo uso).
    Una regla impide que el agente se auto-apruebe.
  - **Ratchet del set de `deny`**: hash canónico contra baseline versionado; si encoge,
    el harness no arranca. Más detección de hooks inyectados en `settings.local.json`,
    que está gitignored y nunca pasa por review.
  - **Doctrina de blast radius por capa** (`permissions` y hooks alcanzan sólo al
    agente; `sandbox` lo impone el OS a todo el árbol de procesos) con checklist de
    5 puntos, y el asimétrico "las restricciones se heredan, las exenciones no".
  - **Paridad medida, no asumida**: tabla con fecha de medición de qué hace realmente
    cada capa por regla, admitiendo dónde la "doble defensa" es mito.
  - Self-review con evidencia y rebote automático sin gastar reviewer; red-log de TDD;
    auditor de red de tests con apelación acotada y lista literal de propuestas
    prohibidas; telemetría local de activación de skills.
- **Qué NO copiar**: 355 MB de repo con binarios versionados, CHANGELOG de 545 KB,
  `ARCHITECTURE.md` que describe una arquitectura que ya no existe, y doc core
  bilingüe sin contrato de idioma.

## ECC (everything-claude-code)
- **URL**: https://github.com/affaan-m/ECC — MIT. Revisado 2026-09-15 sobre `8321021`
  (HEAD 2026-09-12), v2.2.1. **259 409 ★ · 38 802 forks**, último push 2026-09-15: es el
  mayor del campo. JavaScript, 3 716 archivos, 91 MB. Se publica como `ecc-universal`.
- **Análisis completo**: [`docs/research/ecc-lessons.md`](research/ecc-lessons.md) — ahí
  viven las citas y la verificación en frío; los `§` de abajo remiten a ese documento.
- **Qué es**: un único árbol de contenido —292 skills, 68 agentes, 122 rules, 94
  commands— repartido a 14 motores.
- **Problema**: entregar un solo cuerpo de contenido a N hosts sin duplicarlo en el repo
  — el mismo que navori resuelve con render + managed blocks, resuelto aquí en **tiempo
  de instalación**.
- **Enfoque**: el contenido vive una sola vez en la raíz y lo reparten 15 adapters sobre
  tres manifiestos encadenados (7 perfiles → 37 módulos → 84 componentes). Su taxonomía
  no la ordena el formato sino **cuándo entra al contexto** —rules always-on, skills
  on-demand, instincts por relevancia, hooks fuera— y `commands/` es legacy (§3).
- **Stack**: Node/JavaScript plano — 8 devDependencies, 13 gates de CI encadenados con
  `&&`, 13 JSON Schema con ajv, ~50 hooks detrás de un runner único.
- **Conceptos notables para navori**, uno por línea:
  - **Capacidades por motor como dato congelado**, validado en el import, con el soporte
    parcial declarado (`guidedReady` en 3 de 14) en vez de escondido en un sí/no (§2.2).
  - **Plan y apply separados, y el plan ES el estado** (§2.3).
  - **`retainedPaths`**: sella cada destino al instalar y al desinstalar no borra lo que
    no coincide — la doctrina anti-rollback, aplicada a la desinstalación (§2.3).
  - **Política de admisión de MCP**, lo mejor del repo: regla de dos condiciones y una
    auditoría que retiró 6 connectors por defecto con veredicto por cada uno (§5).
  - **Instincts**: comportamiento aprendido con confianza, fuera del repo y con
    presupuesto duro de cuántos se inyectan por sesión (§4.1).
  - **Memory vault write-once**, sin upsert: el opuesto exacto del `topic_key`-upsert de
    Engram; vale como contraste, no como copia (§4.2).
  - **Stale-replay guard tras compactación**: el resumen se reinyecta marcado como
    referencia histórica, porque el modelo re-ejecutaba slash-commands con él (§7.1).
  - **Cómo se mide el contexto de verdad**: la suma de los tres contadores de tokens del
    turno, y lo inferido marcado como inferido (§7.1).
- **Hallazgo negativo verificado — cero grafo de código, cero capa de búsqueda**: sus
  3 716 archivos dan **0 hits** para `tree-sitter`, `ast-grep`, `ctags`, `symbol index`,
  `repo map` y `tgrep`, y ningún hook toca `Grep` ni `Glob` (§6).
  > **Lectura nuestra, no cita**: **no contradice** la retirada de `tgrep` y `codegraph`
  > del motor (`7c6930dc`, #803), y tampoco es evidencia en contra: ECC nunca midió el
  > ruteo de búsqueda y navori sí — **7,4 %** de adopción con la doctrina sola contra
  > **40,7 %** con el guard mecánico
  > ([`research/tgrep-como-funcionaba.md`](research/tgrep-como-funcionaba.md)). Prueba
  > que el harness más grande del campo se envía sin esa capa, no que no sirva.
- **Qué NO copiar**: el mismo bloque de defensa repetido verbatim en 79 archivos sin
  mecanismo de sincronización —el caso de uso canónico de los managed blocks—; 192
  archivos duplicados entre dot-dirs con un `catalog:check` que sólo cuenta; **225 de
  1 468 enlaces relativos rotos (15,3 %)** sin link-check en CI; y **ningún baseline de
  permisos en todo el árbol** — su guard principal es un gate de atención, no de
  autorización (§8.5, §10).

## deepseek-harness (dsh)
- **URL**: https://github.com/deepseek-ai/deepseek-harness — MIT. Revisado 2026-09-15
  sobre `0d1f500` (HEAD 2026-09-15). **225 561 ★ · 26 858 forks**, último push
  2026-09-15. TypeScript, monorepo pnpm, 11 228 archivos. Paper: arXiv:2608.25512.
- **Análisis completo**:
  [`docs/research/deepseek-harness-lessons.md`](research/deepseek-harness-lessons.md) —
  ahí viven las citas y la verificación en frío; los `§` remiten a ese documento.
- **Qué es**: **runtime** de agentes sobre [Cordis](https://github.com/cordiverse/cordis)
  —*"everything is a plugin"*—, en developer preview. No es un generador de harnesses:
  entra aquí por su **disciplina documental y de gates**.
- **Problema**: sostener reglas de prosa y de proceso en un monorepo enorme donde los
  agentes escriben la documentación, sin que el documento que los gobierna deje de
  leerse.
- **Enfoque**: casi todas sus reglas tienen un `verify-*` detrás (60 scripts), y las que
  no lo tienen lo declaran. El centro es un **presupuesto de palabras por documento**: un
  manifiesto mapea 8 rutas a un entero y un script de 58 líneas falla si el documento se
  pasa, si el techo es inválido o si el archivo presupuestado desapareció (§2.1).
- **Stack**: TypeScript, pnpm, Cordis, lefthook, CI de 9 jobs paralelos más un agregador
  que falla si alguno salió failure, cancelled **o skipped** (§6.2).
- **Conceptos notables para navori**, uno por línea:
  - **El orden de resolución del techo de palabras**: **1. Relocate · 2. Condense ·
    3. Raise**, con histéresis del 5 % y el diff del manifiesto justificado en el PR
    (§2.2, §2.3).
    > **Lectura nuestra, no cita**: navori ya cuenta palabras y falla en CI, pero **sobre
    > las skills empaquetadas** (`SKILL_TYPE_CAPS` + `skill-caps.test.ts`); lo que dsh
    > aporta es el manifiesto ruta→techo para **prosa**, no el conteo.
  - **Listas derivadas, no duplicadas**: el modo `doc-quick` del registro de gates no es
    una lista propia, es un filtro sobre la canónica (§4).
  - **Reparto de checks contra el gate monolítico**: su pre-push es `pnpm run typecheck`
    y nada más, porque CI es el dueño de la cobertura exhaustiva. Es la tesis opuesta al
    gate único de navori (§6).
  - **`dsh-trim-cot-leakage`**: nombra y testea la prosa cuyo punto de vista es la sesión
    que la escribió y no el repositorio, y la repara reformulándola, no borrándola (§10).
  - **Descripciones de skill que declaran el momento, no el tema**: citan frases del
    usuario, citan el string ofensor y declaran la no-superposición con la vecina (§9.1).
  - **Decisiones como corpus** (`.agents/notes/`): estado y clase **en el path**,
    `git mv` como única transición, sin front-matter y sin índice —eliminado por ser un
    punto de conflicto de merge previsible— (§8.1, §8.2).
  - **Anti-atrofia de gates**: un verificador declara un piso numérico de archivos y
    **falla** si el glob colapsa, en vez de pasar verde sobre cero (§5.4).
  - **Honestidad sobre lo que un gate prueba**: un verde confirma el par a esos
    contenidos exactos, no que la confirmación fuera sólida (§7).
  - **Reglas que deliberadamente no tienen gate**, y lo dicen: la nota de decisión por PR
    no trivial vive en prosa porque "no trivial" no es decidible por script (§8.4).
- **Un cable que NO se puede copiar tal cual**: proyectan el contenido a otros motores
  con symlinks (`.claude/skills -> ../.agents/skills`, `CLAUDE.md -> AGENTS.md`), y la
  doc oficial de Claude Code no los documenta para `.claude/skills/` (§9.5).
- **Qué NO copiar**: el tier `archived/` sellado con un manifiesto sólo se paga con sus
  629 notas archivadas sobre 3 082; el par bilingüe triplica el costo por nota; y de sus
  6 clases de notas, tres combinaciones están vacías (§12).

## codegraph

> **Retirado como plugin de navori el 2026-09-15** (Spec 0009). Lo de abajo es el análisis
> del proyecto upstream, que sigue vigente como referencia; lo que dejó de ser cierto es la
> frase "el plugin está activo en este repo". Se va a reimplementar junto con `tgrep`, con
> una integración pensada para que trabajen entre sí — acta del retiro y qué midió cada uno
> en [`research/tgrep-como-funcionaba.md`](research/tgrep-como-funcionaba.md).

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

**Esto le pega directo a navori**: el plugin de codegraph estuvo activo en este repo hasta
el 2026-09-15 y lo citamos como argumento de los specs **0005 (eficiencia de búsqueda)** y **0006
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

## revfactory/harness
- **URL**: https://github.com/revfactory/harness — **Apache-2.0**. Revisado 2026-09-15.
  8 998 ★ · 1 273 forks, último push 2026-07-24. 35 archivos, v1.2.0. Coreano, inglés y
  japonés.
- **Qué es**: **una meta-skill, no un CLI**. Todo el proyecto es
  `skills/harness/SKILL.md` (457 líneas) más 6 `references/` (2 210 líneas en total).
  **Cero código.** Convierte una frase de dominio en un equipo de agentes con sus skills.
- **Problema**: el mismo que navori — fabricar el harness en vez de escribirlo a mano.
  Por eso es el vecino más cercano de este documento: se autoclasifica en el cajón
  **L3 — Meta-Factory / Team-Architecture Factory**.
  > **Lectura nuestra, no cita**: la taxonomía es suya y navori **no** aparece en ella.
  > Ubicarnos en ese mismo cajón es lectura nuestra.
- **Enfoque**: pipeline de 7 fases — Phase 0 auditoría de estado → 1 análisis de dominio
  → 2 arquitectura de equipo → 3 generación de agentes → 4 generación de skills → 5
  integración/orquestación → 6 validación → 7 **evolución del harness**. Pero **nunca lo
  corre entero**: Phase 0 trae una **matriz de selección de fases** que, según el tipo de
  cambio (agregar agente / agregar skill / cambio de arquitectura), decide qué fases
  aplican.
- **Stack**: markdown puro distribuido como plugin de Claude Code.
- **Conceptos notables para navori**:
  - **La taxonomía del campo con sus vecinos**, que vale como mapa de qué auditar después:

    | Capa | Qué hace | Proyecto |
    |------|----------|----------|
    | **L3 — Meta-Factory / Team-Architecture Factory** | frase de dominio → equipo de agentes + skills | revfactory/harness (ellos) |
    | L3 — Meta-Factory / Runtime-Configuration Factory | configuraciones de runtime deterministas | `coleam00/Archon` |
    | L3 — Meta-Factory / Codex Runtime Port | mismo concepto, runtime Codex | `SaehwanPark/meta-harness` |
    | L2 — Cross-Harness Workflow | estandarizar skills/rules/hooks entre harnesses | [`affaan-m/ECC`](#ecc-everything-claude-code) |

    Archon y meta-harness quedan **pendientes de auditar**, como `ruvnet/metaharness`.
  - **Detección de drift en Phase 0 §3**: coteja los agentes y skills que hay en disco
    contra el registro declarado en `CLAUDE.md`. El inventario declarado y el real son
    dos fuentes que se separan solas.
  - **6 patrones de arquitectura de equipo** con nombre: Pipeline · Fan-out/Fan-in ·
    Expert Pool · Producer-Reviewer · Supervisor · Hierarchical Delegation. Tenerlos
    nombrados da el vocabulario para discutir cuál toca en cada dominio, en vez de
    asumir que siempre es el mismo.
  - **`references/skill-testing-guide.md` §3 — With-skill vs Baseline**: ejecución
    comparativa del mismo prompt con y sin la skill, capturando timing; §4 puntúa por
    assertions y advierte contra la **"Non-discriminating assertion"**, la que pasa en
    ambos brazos y por lo tanto no mide nada.
  - **`references/qa-agent-guide.md` — "Boundary Mismatch"**: verificación cruzada de
    API contra hook de frontend con el principio *"lee ambos lados a la vez"*, y el
    momento del QA: *"QA corre justo después de cada módulo, no después del build."*
  - Phase 6-4 "trigger verification" y 6-5 dry-run: comprobar que la skill **se dispara**
    antes de dar por buena la generación.
- **Qué NO copiar**: con cero código, la validación de Phase 6 y el drift-check de Phase
  0 son instrucciones al modelo, no gates ejecutables.
  > **Lectura nuestra, no cita**: el proyecto no se declara así; es lo que se deduce de
  > que no haya nada que ejecutar.

## learn-harness-engineering
- **URL**: https://github.com/walkinglabs/learn-harness-engineering — MIT. Revisado
  2026-09-15. 15 261 ★ · 1 525 forks, último push 2026-08-26. TypeScript.
- **Qué es**: un **curso** de harness engineering (14 lecciones, 8 proyectos, 15
  idiomas) que además envía la herramienta para puntuar el harness del alumno. 2 478
  archivos, 1 913 de ellos en `docs/`.
- **Problema**: no hay vocabulario compartido para decir qué le falta a un harness, ni
  forma de puntuarlo sin un juez LLM.
- **Enfoque**: **framework de cinco subsistemas** — `instructions · tools · environment ·
  state · feedback`. El scorer usa una variante operativa de los mismos cinco ejes:
  `instructions, state, verification, scope, lifecycle`.
- **Stack**: TypeScript y scripts Node (`.mjs`) sin dependencias pesadas; el grueso del
  repo es documentación.
- **Conceptos notables para navori**:
  - **`skills/harness-creator/` es la forma de navori empaquetada como skill**:
    `metadata.json` con `compatibility.agents: [claude-code, codex-cli, cursor,
    windsurf, generic]` y 15 `triggers`, más 7 `references/`, 6 `templates/`, 5
    `scripts/` y un directorio **`evals/`**. Es el contraste directo con las skills de
    navori, que son un `.md` plano cada una.
  - **`evals/evals.json`**: cada eval es `{id, name, prompt, expected_output, files[],
    expectations[]}` — assertions verificables escritas en prosa. La #4, "Verification
    Workflow Design", arranca con el prompt *"My agent says 'done' but the tests fail"*.
    Es el material más concreto del campo sobre el eje de **evals de skills** que ya
    mapea [awesome-harness-engineering](#awesome-harness-engineering).
  - **`scripts/validate-harness.mjs`** (43 líneas) puntúa **cualquier** repo en los cinco
    subsistemas y sale 1 si no llega a `--min-score` (default 70): score por subsistema =
    `max(1, round(passed/total*5))`, overall = `round(total/(5*5)*100)`. Una barra de CI
    portable, que se puede correr sobre un repo ajeno.
  - **Honestidad de reporte**: el bottleneck se reporta **sólo si un subsistema es más
    débil que el resto** — *"When every subsystem already maxes out, reporting one is
    misleading."*
  - **`scripts/run-benchmark.mjs` se prueba a sí mismo antes de juzgar**: andamia un
    harness desechable en un tmpdir y lo valida (*"proves the scripts work"*), luego
    puntúa el target, luego chequea cobertura de evals. Y declara su límite: *"This is a
    structural benchmark, not an LLM judge."* Es el contraste útil con `navori bench`,
    que mide min/p50/p95/max de `runRender` en dry-run — latencia, no estructura.
  - Sección "Frontier Harness Design Breakdowns" (ago-2026): aplica los cinco subsistemas
    a Pi, Claude Code, Codex y DeepSeek — análisis comparativo ya hecho de cuatro
    referencias que este documento cubre por separado.
  - Lección 14, para la discusión de orquestación: *"A loop is a graph with one node."*
- **Qué NO copiar**: el volumen documental — 1 913 de 2 478 archivos viven en `docs/` y
  se publican en 15 idiomas.
  > **Lectura nuestra, no cita**: para un curso ese volumen ES el producto; en un harness
  > sería el multiplicador de traducción que ya se le señala a ECC.

## OpenHarness
- **URL**: https://github.com/HKUDS/OpenHarness — MIT. Revisado 2026-09-15. 15 760 ★ ·
  2 562 forks, último push **2026-06-04** — el más quieto de los revisados en esta tanda.
  Python, 479 archivos.
- **Qué es**: runtime de agentes con un agente personal (`ohmo`) encima: 43 tools y 114
  tests.
- **Problema**: cómo probar un harness sin que el sujeto de la prueba sea el repo que lo
  escribe.
- **Enfoque**: lo condensa en `.claude/skills/harness-eval/SKILL.md`, cinco principios de
  evaluación, apoyados por `references/feature-matrix.md`, que tabula `Test | What to
  Verify | Key Assertion` por área (Engine & Tools, Swarm & Coordinator,
  Hooks/Skills/Plugins, Memory/Session/Config).
- **Stack**: Python.
- **Conceptos notables para navori**:
  - **El primer principio es el que justifica la ficha**: *"Test on an unfamiliar project
    — never test on OpenHarness itself (the agent modifies its own code). Clone a real
    project as the workspace."* navori **se auto-hospeda**: su harness se prueba sobre el
    repo que lo genera, así que ese sesgo viene de fábrica y hay que nombrarlo antes de
    leer cualquier resultado propio como evidencia.
  - Los otros cuatro, citables tal cual: *"Use real API calls — no mocks."* ·
    *"Multi-turn conversations — always test 2+ turns."* · *"Combine features — test
    hooks+skills+agent loop together, not in isolation."* · *"Verify tool execution —
    inspect tool call lists and output files, not just model text."*
  - **`Key Assertion` como columna obligatoria**: cada prueba de la matriz declara qué
    afirmación concreta la hace pasar. Es el mismo papel que juegan las `expectations[]`
    de [learn-harness-engineering](#learn-harness-engineering), y el antídoto contra la
    "non-discriminating assertion" que advierte
    [revfactory/harness](#revfactoryharness): tres fuentes independientes convergiendo en
    que la unidad de un eval es la afirmación, no el escenario.

## awesome-harness-engineering
- **URL**: https://github.com/ai-boost/awesome-harness-engineering — CC0. Revisado
  2026-09-10 (ver las tandas de revisión en la cabecera).
- **Análisis completo**: [`docs/research/awesome-harness-engineering.md`](research/awesome-harness-engineering.md).
- **Qué es**: no es un proyecto sino un **índice curado** de 477 recursos sobre
  harness engineering. Entra a este documento por excepción: no nos inspiró un
  patrón, nos da el mapa del campo y la bibliografía.
- **Verificado por nosotros**: 463 URLs únicas sobre 477 entradas (14 duplicadas);
  19/19 repos de una muestra existen; `everything-claude-code` y `ECC` son el mismo
  repo listado dos veces en la misma sección, con la cifra de estrellas de la nota
  desactualizada. Índice usable como mapa, no como fuente de cifras sin verificar.
- **Conceptos notables para navori**:
  - **Taxonomía por problema, no por vendor** (12 primitivas de diseño). Usada como
    lente de auditoría, deja tres huecos nuestros a la vista: **observabilidad**,
    **evals de skills** y **runner/cola de tareas**.
  - Gate de PR que copiaría: nota obligatoria por entrada, **ninguna sección con más
    de ~10 entradas sin razón clara**, y un verificador de links en CI.
  - **Bibliografía sobre nuestro 2% → 57% de activación**: Stripe *"You can't whisper
    at an AI agent"* (*si tu guía no estaba en el contexto cargado, no ocurrió* —
    confirma nuestra causa raíz de forma independiente), LangChain *Evaluating Skills*
    (82% vs 9% con skills curadas; **≤12 skills** rinde más que un catálogo extenso),
    OpenAI *Testing Agent Skills with Evals*, y `mgechev/skillgrade` (CLI que mide si
    el agente **descubre e invoca** una skill, con umbral para CI).
  - **Dos papers sobre permisos que hay que responder**: *When "Do Not" Is Not Deny*
    (481 `CLAUDE.md` públicos, sólo ~4% de las reglas tienen un control que las
    respalde — la mejor evidencia externa **a favor** de la arquitectura de navori) y
    *Do User-Authored Permission Policies…* (las políticas pre-escritas bloquearon
    ~20 pp **menos** overreach que la aprobación por acción — evidencia **en contra**
    de parte de lo que generamos).
  - **`isolated` vs `forked`** para subagentes (LangChain): forkear workers que
    continúan una investigación, aislar verificadores que deben juzgar solos. navori
    lo hace implícito; ellos publicaron la regla.
  - **`INCONCLUSIVE` como veredicto de eval** (AgentAssay): converge con el
    "indeterminado" de `shellscan` en [CCH](#claude-code-harness-cch) — no forzar un
    binario cuando la evidencia no lo sostiene.
  - De sus templates, la idea que vale: una tabla **"componente / existe porque / se
    puede quitar cuando"**. El harness tiene que poder encoger, no sólo crecer.
- **Dato de posicionamiento**: navori **no está listado**, y la sección donde encajaría
  (*Generators & Meta-Harnesses*) está dominada por harnesses que se auto-optimizan
  contra un benchmark. `ruvnet/metaharness` es ahí el competidor descrito más cercano
  a navori y queda pendiente de auditar.

---

## Temas transversales (para el análisis de reestructuración)

Agrupando las fuentes, estos son los ejes que conviene revisar cuando toque
reestructurar navori:

1. **Multi-engine / multi-host** (gstack, ponytail, superpowers, caveman): auto-detección
   de host y un config por host. navori ya va por aquí (Claude + Codex + AGENTS.md).
   **Lo que suma esta revisión**: ECC lleva el modelo al extremo —capacidades de 14
   motores como array congelado validado en el import, soporte parcial declarado
   (`guidedReady` en 3 de 14), plan/apply separados y `retainedPaths` que se niega a
   borrar un destino modificado— y dsh proyecta el mismo contenido por symlink
   (`.claude/skills -> ../.agents/skills`), cable que habría que verificar contra la doc
   oficial antes de heredarlo. Contraejemplo en la misma fuente: los dot-dirs que ECC sí
   commitea como copias ya divergieron (35 de 39, 33 de 33) porque su check sólo cuenta.
2. **SDD como máquina de estados en disco** (harness-sdd, ejemplo-harness-subagentes,
   gentle-ai, superpowers): specs versionadas, gates de aprobación humana, EARS,
   traceability requisito↔test. **Variante de dsh**: las decisiones viven como corpus
   (`.agents/notes/`) con el estado **en el path** y `git mv` como única transición, sin
   front-matter y sin índice —eliminado por ser un punto de conflicto de merge
   previsible—; el tier `archived/` queda congelado y sellado con un manifiesto de
   hashes.
3. **Roles/subagentes con estado en filesystem** (harness-sdd, ejemplo-harness-subagentes,
   Goose, superpowers): Leader/Implementer/Reviewer, anti-teléfono-descompuesto.
   **Nuevo vocabulario**: revfactory nombra **6 patrones de arquitectura de equipo**
   (Pipeline · Fan-out/Fan-in · Expert Pool · Producer-Reviewer · Supervisor ·
   Hierarchical Delegation), y ECC pone el freno que falta en el otro extremo:
   *"Decompose only when the work cannot fit in one context... depth is an outcome, not
   a plan"*, escrito tras ver agentes de research spawneando hijos y devolviendo
   "waiting" como respuesta final.
4. **Eficiencia de tokens / contexto** (codegraph, graphify, ponytail, caveman, Pi):
   contexto quirúrgico, subgrafos acotados, escalera anti-over-engineering, compresión
   de output, skills on-demand. Conecta con specs **0005** y **0006** de navori.
   **Con una lección de esta revisión**: dos de los cuatro proyectos que citábamos por
   eficiencia matizaron su propia cifra en un mes — codegraph publicó que deja ~80% más
   contexto residual en sesiones multi-turno, y caveman que su compresión es solo de
   salida y puede ser net-negativa en cargas concisas. Ninguna métrica de ahorro de
   tokens de terceros entra a una decisión de navori sin su contraparte.
   **ECC añade tres piezas y una advertencia**: la taxonomía cuyo criterio es *cuándo*
   entra cada capa al contexto (rules always-on, skills on-demand, hooks fuera del
   contexto), el progressive disclosure movido a **tiempo de instalación** (6 de 37
   módulos por defecto) y la medición correcta del tamaño de turno
   (`input + cache_read + cache_creation`, *"their sum is the true context size"*). La
   advertencia: sus dos skills de presupuesto de tokens son sólo prompt, sin tokenizer,
   y una lo admite (*"heuristic estimation — no real tokenizer"*). Un "budget advisor"
   sin tokenizer es prosa, no medición.
5. **Memoria persistente** (gstack/GBrain, gentle-ai/Engram, caveman/cavemem): navori
   ya usa Engram. Ojo: cavemem está frozen y su core vive dentro de caveman.
   **ECC es el contraste más fuerte**: su vault es **write-once sin upsert** —evolucionar
   es enlazar y marcar `superseded`—, con trust fijo en `unreviewed` porque *"Team memory
   is not trusted merely because it is committed to Git"*, rechazo de secretos en el
   write path y **sin poda automática** (política de contención, no de curación). Es el
   opuesto exacto del `topic_key`-upsert de Engram, y sus *instincts* añaden un eje
   distinto: presupuesto duro de cuántos recuerdos se inyectan por sesión y umbral de
   confianza para entrar.
6. **Cross-model review** (gstack, gentle-ai/RDD): revisión independiente entre modelos
   sobre el mismo diff, confianza derivada de gates y no de narración. **ECC aporta una
   variante barata**: `path_instructions` por glob en los revisores automáticos —el
   prompt del revisor cambia según el path tocado, así que `skills|commands|agents|rules`
   se revisan contra prompt injection y tool-permission creep, y los workflows contra
   acciones sin pinear.
7. **Extensibilidad vs. opinión** (Pi "primitivas, no features" vs. gstack/superpowers
   opinados): decisión de diseño clave para el rumbo de navori. **Los dos extremos
   nuevos**: dsh/Cordis lleva "todo es un plugin" hasta *"There is no privileged core to
   patch"*, con registros que son efectos y un disposer exacto por registro; ECC es el
   polo opinado —292 skills— pero **en cuarentena**: nadie recibe las 292 salvo el perfil
   `full`, y el núcleo curado real son 47.
8. **Guardrails y capas de defensa** (claude-code-harness, gstack/`gstack-egress`): motor
   de reglas con ID por regla, un tercer veredicto para lo que no se puede probar
   estáticamente, deny que encola en vez de matar el run, ratchet sobre la superficie de
   `deny`, y doctrina escrita de blast radius por capa (`permissions` y hooks alcanzan
   sólo al agente; `sandbox` lo impone el OS a todo el árbol de procesos). Es el eje
   donde navori tiene más que aprender de una sola fuente — ver
   [`docs/research/claude-code-harness-lessons.md`](research/claude-code-harness-lessons.md).
   **Los dos repos grandes no confirman esa receta, y eso es información**: ECC no tiene
   baseline de permisos en todo el árbol —su guard principal es un gate de atención, no
   de autorización, y **publica en cada denegación la variable que lo apaga**— y dsh
   directamente no usa denylist de comandos: apuesta por confinamiento de OS, fail-closed
   (*"silent unconfined passthrough is forbidden"*) y un seam de aprobación. Lo que sí
   comparten es honestidad sobre el límite: *"Sandboxing, approval prompts, and
   permission controls... do not guarantee isolation or prevent damage"* (dsh), *"The
   safety boundary is not the system prompt. It is the policy that sits BETWEEN the model
   and the action"* (ECC). Lo más concreto que deja ECC en este eje es su **sidecar de
   fingerprints de hooks**: SHA-256 del par `{matcher, hooks}` validado en CI, con
   `--update-fingerprints` como única ruta declarada para moverlo — cambiar un matcher
   deja de ser una edición silenciosa.
9. **Medir el harness, no sólo construirlo** (awesome-harness-engineering, y por
   contraste claude-code-harness): evals de skills con umbral en CI, observabilidad de
   lo que el harness provoca, veredictos no binarios para flujos no deterministas, y
   reportar capacidad a nivel **modelo-harness** y no del modelo solo. Es el eje donde
   el campo se movió más y donde navori tiene los tres huecos declarados
   (observabilidad, evals de skills, runner). Conecta con `navori bench` y con
   `docs/research/activacion-subagentes-y-skills.md`.
   **Es también el eje que más creció el 2026-09-15**, con tres fuentes que convergen:
   learn-harness-engineering trae el formato de eval (`{prompt, expected_output, files,
   expectations}`) y un scorer portable con umbral y exit code que se puede correr sobre
   cualquier repo; revfactory trae el diseño del experimento (**with-skill vs baseline**)
   y su trampa (la *"non-discriminating assertion"*, la que pasa en los dos brazos);
   OpenHarness trae la condición previa a todo lo anterior — *"never test on OpenHarness
   itself (the agent modifies its own code)"*. navori se auto-hospeda, así que ese sesgo
   es de fábrica y cualquier eval propio tiene que declararlo. Las tres coinciden además
   en la unidad de medida: la **afirmación** (`Key Assertion`, `expectations[]`), no el
   escenario.
10. **Licencias y brazo comercial** (eje abierto el 2026-08-19): caveman ya no es MIT limpia
   (núcleo BSL-1.1), los dos repos de betta-tech no tienen licencia, y codegraph y
   graphify tienen producto comercial activo. Para citar y enlazar no hay problema en
   ningún caso; para **copiar código o presentarlos como "todo open source MIT"**, sí.
   De la tanda del 2026-09-15: ECC, deepseek-harness, learn-harness-engineering y
   OpenHarness son **MIT**; revfactory/harness es **Apache-2.0**.
11. **Presupuesto documental y anti-duplicación** (deepseek-harness, ECC,
   learn-harness-engineering — eje nuevo del 2026-09-15): un harness también se degrada
   por volumen de prosa, y hay mecanismos para medirlo. De dsh, el manifiesto ruta→techo
   de palabras con gate, el orden **Relocate → Condense → Raise** y la histéresis
   (*"Ceilings are guardrails, not reduction targets"*), más las listas **derivadas** en
   vez de duplicadas (`doc-quick` = filtro sobre `doc-sync`) y su vacuna contra la
   atrofia del gate (si el glob colapsa, falla en vez de pasar verde sobre cero
   archivos). Del otro lado, ECC muestra la factura de no tenerlo: 15,3 % de enlaces
   relativos rotos sin link-check, 192 archivos duplicados sin paridad y el mismo bloque
   de 6 viñetas copiado verbatim en 79 archivos — el caso de uso canónico de los managed
   blocks, sin resolver. navori ya cuenta palabras y falla en CI **sobre las skills
   empaquetadas** (`SKILL_TYPE_CAPS` + `skill-caps.test.ts`); lo que estas fuentes
   agregan es la misma disciplina aplicada a la prosa.
