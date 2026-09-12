# awesome-harness-engineering: el mapa del campo, leído desde navori

> Revisión de [ai-boost/awesome-harness-engineering](https://github.com/ai-boost/awesome-harness-engineering)
> — CC0, 4,111 ★, creado 2026-03-29, último push 2026-09-10 — hecha el 2026-09-10.
>
> Esto **no** es una comparación de arquitectura como
> [`claude-code-harness-lessons.md`](claude-code-harness-lessons.md): no hay
> arquitectura que comparar. Es un índice curado de 477 recursos. El valor para
> navori es de otro tipo: (a) una taxonomía del campo que sirve de lente de
> auditoría, (b) una cosecha dirigida de fuentes que tocan problemas que navori
> ya tiene abiertos y medidos, y (c) un dato de posicionamiento.

---

## TL;DR

1. **La taxonomía es el activo principal.** Doce "design primitives" organizados
   *por el problema que resuelven, no por vendor*. Sirve como checklist de
   cobertura: navori cubre bien 6, parcialmente 3 y nada 3.
2. **Hay cuatro fuentes que atacan directamente el problema que navori midió**
   (tasa de activación de skills 2% → 57%), incluida una que confirma nuestra
   causa raíz de forma independiente y una CLI que ya hace lo que nos falta.
3. **Hay dos papers que son evidencia *en contra* de una parte de la tesis de
   navori** (las políticas de permisos escritas por el usuario). Hay que leerlos
   y responderlos, no ignorarlos.
4. **navori no está listado**, y la sección donde encajaría —
   *Generators & Meta-Harnesses*, 22 entradas — está dominada por un paradigma
   que no tenemos: harnesses que se auto-optimizan contra un benchmark.
5. **Calidad del índice: usable con reservas.** Los links son reales (19/19 en
   mi muestra), pero hay 14 URLs duplicadas y al menos un repo listado dos veces
   en la misma sección bajo dos nombres, con cifras de la nota desactualizadas.

---

## 1. Qué es y si se puede confiar

Un *awesome-list* con badge `awesome.re`, CC0. El README son 650 líneas /
246 KB — cada entrada es una línea larga con el formato obligatorio
`- [Título](URL) — nota de 1–2 frases explicando por qué vale la pena`.

Su `AGENTS.md` (que es también su `CLAUDE.md`, por symlink) fija tres reglas
que explican la calidad del resultado:

> - Las secciones se organizan **por el problema que se resuelve**, no por
>   vendor ni por modelo.
> - Las notas deben ser **opinionadas**: explican *por qué* importa el recurso,
>   no qué es.
> - No se agregan recursos sin nota.

Y un gate de PR: URLs alcanzables, nota en cada entrada, **ninguna sección con
más de ~10 entradas sin una razón clara**, y el README renderiza. Traen un
`verify_urls.py` (concurrente, con reintentos, caché y salida JSON para CI) que
verifica el link-rot.

### Lo que verifiqué yo

| Medición | Resultado |
|---|---|
| Entradas totales | 477 |
| URLs únicas | 463 → **14 duplicadas** |
| Composición | 236 github.com · 63 arxiv.org · 25 anthropic.com · 17 blog.langchain.com · 9 openai.com |
| Muestra de 19 repos de GitHub | **19/19 existen** — cero links muertos |
| ¿navori aparece? | **No**, cero menciones |

**Las 14 duplicadas** son, en su mayoría, los posts canónicos de Anthropic y
OpenAI apareciendo tanto en *Foundations* como en la primitiva correspondiente
(`Beyond Permission Prompts` ×3, `Demystifying Evals` ×3, `harness-engineering`
de OpenAI ×3). Para un awesome-list eso es defendible como cross-listing.

**Lo que no es defendible**: `everything-claude-code` y `ECC` están listados
como dos entradas distintas **en la misma sección**, con notas distintas — y son
el mismo repo: la API de GitHub redirige ambos a `affaan-m/ECC`. Además la nota
dice "Anthropic Hackathon Winner (140K+ stars)" y la API reporta 255,684 ★ con
38,283 forks y **1,292 watchers**. La cifra de la nota está desactualizada, y el
ratio ★:watchers es atípico para un repo de ese tamaño. Registro el dato
porque nuestra propia disciplina de `inspiration.md` lo exige (ninguna métrica
de terceros entra a una decisión sin su contraparte); no le atribuyo intención.

**Veredicto**: índice legítimo y bien mantenido — un push el mismo día de la
revisión —, con el ruido normal de un awesome-list en crecimiento. Sirve como
mapa; no sirve como fuente de cifras sin verificar cada una.

---

## 2. La taxonomía como lente de auditoría

Esta es la parte que vale la pena internalizar. Doce primitivas de diseño, más
cuatro secciones de implementaciones y transversales:

| Primitiva | Entradas | ¿navori la cubre? |
|---|---|---|
| Agent Loop | 21 | **Sí** — bloque `orquestacion` (R1/R2/R2-fan/R3), `continuous-execution` |
| Planning & Task Decomposition | 12 | **Sí** — SDD, `spec-bootstrap`, `tasks.md` con trazabilidad `R<n>` |
| Context Delivery & Compaction | 30 | **Sí** — specs 0005/0006, `precompact-session-summary`, arranque/cierre de sesión |
| Tool Design | 15 | **Parcial** — consumimos tools (MCP, tgrep, codegraph); no diseñamos las nuestras |
| Skills & MCP | 41 | **Sí** — es el core del producto |
| Permissions & Authorization | 16 | **Sí** — `settings.json` + `guard-destructive` + doctrina de operaciones seguras |
| Memory & State | 28 | **Sí** — Engram, `progress/`, Dominio |
| Task Runners & Orchestration | 40 | **Parcial** — orquestamos subagentes; no hay runner ni cola |
| Verification & CI Integration | 14 | **Parcial** — quality gate y `verify-before-done`; **sin evals de skills** |
| Observability & Tracing | 16 | **No** — no hay trazas ni telemetría de lo que el harness provoca |
| Debugging & Developer Experience | 16 | **Sí** — `debug-error`, `loop-back-debug`, `doctor` |
| Human-in-the-Loop | 12 | **Parcial** — gates de aprobación en el ticket flow; sin diseño de HITL propio |

Los tres huecos —**observabilidad**, **evals de skills** y **runner/cola**— no
son casualidad: son exactamente donde nuestra propia investigación de activación
tuvo que improvisar instrumentación para poder medir.

> **Regla que copiaría del `AGENTS.md` de este repo**: "ninguna sección con más
> de ~10 entradas sin una razón clara". Aplicado a navori sería un gate sobre el
> catálogo de skills — y conecta con el hallazgo de LangChain de la §3.1.

---

## 3. Cosecha dirigida: lo que toca problemas abiertos de navori

No transcribo el índice. Estas son las entradas que atacan algo que ya tenemos
medido o decidido.

### 3.1 — Activación de skills (nuestro 2% → 57%)

Cuatro fuentes, en orden de utilidad inmediata:

- **[You can't whisper at an AI agent](https://stripe.dev/blog/ai-steering-experiments)**
  (Stripe, mayo 2026) — estudio de cómo los agentes consumen guías de SDK y CLI:
  la documentación pasiva se ignora; las señales duras colocadas **en el
  contexto cargado** (archivos de skill, mensajes de error, prompts del CLI)
  sí cambian el comportamiento. Su principio —*"si tu guía no estaba en el
  contexto cargado, no ocurrió"*— es **confirmación independiente de nuestra
  propia causa raíz** (`c2bb0d7`: el bloque de orquestación nunca llegaba al
  agente). Vale citarlo en `docs/research/activacion-subagentes-y-skills.md`.
- **[mgechev/skillgrade](https://github.com/mgechev/skillgrade)** (704 ★) — CLI
  que convierte la verificación de una skill en tests repetibles: genera pares
  task/grader desde un `SKILL.md`, corre evals multi-trial contra Claude, Codex,
  Gemini u OpenCode, y reporta tasa de aprobación con umbral listo para CI.
  Es literalmente el hueco entre "publiqué la skill" y "sé que el agente la
  descubre e invoca". **Candidato directo a comparar contra `navori bench`**, o
  a integrar como plugin.
- **[Evaluating Skills](https://blog.langchain.com/evaluating-skills/)**
  (LangChain) — metodología con sandbox Docker. Dos hallazgos que nos tocan:
  Claude Code completó **82%** de tareas con skills curadas vs **9%** sin ellas,
  y **consolidar a ≤12 skills mejoró la precisión** frente a catálogos
  extensos. navori embarca 12 core + libs detectadas + project-local: el total
  que ve el agente en un repo real ya pasa de 17. Es una hipótesis concreta
  sobre por qué la activación era baja, y es medible.
- **[Testing Agent Skills Systematically with Evals](https://developers.openai.com/blog/eval-skills)**
  (OpenAI) — cuatro dimensiones de eval (outcome, process, style, efficiency),
  captura de trazas en JSONL para checks **deterministas** (secuencia de
  comandos, presupuesto de tokens, limpieza del repo) y LLM-as-judge **sólo**
  donde el check determinista no alcanza. El principio de capas —el juez caro
  se agrega únicamente donde reduce riesgo real— es lo que evita que un pipeline
  de evals de skills se vuelva impagable.

Complementos del mismo cluster, para después: `microsoft/SkillOpt` (skills como
parámetros optimizables con feedback de ejecución, produce `best_skill.md`),
[AIP](https://arxiv.org/abs/2606.04781) (compilar skills de prosa a grafos de
ejecución tipados: 53% → 67% de pass rate, y skills auditables y reparables),
`microsoft/skills` (versionado y distribución de skills entre plataformas) y
SkillNet/SkillsBench (benchmark de 86 tareas en 11 dominios).

### 3.2 — Permisos: dos papers que van *contra* parte de nuestra tesis

- **[When "Do Not" Is Not Deny: Security Rules in CLAUDE.md vs Built-In Controls](https://arxiv.org/abs/2608.23550)**
  — analiza **481 archivos `CLAUDE.md` públicos** y encuentra que sólo ~**4%**
  de las reglas de seguridad en lenguaje natural tienen un control built-in que
  las respalde. *"Las instrucciones del harness no son guardrails salvo que
  mapeen a enforcement determinista."*
  **Esto es a favor de navori**: es exactamente el hueco que cerramos al
  renderizar la regla `deny` y el hook junto al texto, en vez de sólo escribir
  el texto. Es la mejor cita externa que tenemos para justificar la
  arquitectura.
  > Ojo con una coincidencia numérica: este 4% **no** tiene relación con el
  > 4% → 57% de nuestro `activacion-subagentes-y-skills.md`, que mide tasa de
  > activación sobre oportunidades. Mismo número, fenómenos distintos.
- **[Do User-Authored Permission Policies Improve Protection Against AI Agent Overreach?](https://arxiv.org/abs/2608.27443)**
  — estudio con 113 participantes no técnicos (agosto 2026) comparando
  aprobación HITL por acción, revisión automática por modelo, y reglas
  allow/ask/never escritas por el usuario. Hallazgo: las políticas
  pre-escritas bloquearon ~**20 puntos porcentuales menos** de overreach que la
  aprobación por acción, porque los usuarios ponen "ask" casi en todo y luego
  aprueban igual — el pre-compromiso estático degenera en prompts en runtime
  sin ganar protección.
  **Esto es evidencia en contra** de una parte de lo que navori genera. No la
  invalida (nuestro `deny` y el hook no son "ask"), pero sí obliga a una
  postura explícita: **cuánto de nuestra superficie es `ask`, y qué hacemos para
  que un `ask` no sea sólo fatiga de aprobación.** Conecta directo con la cola
  de operaciones diferidas de CCH.
- **[Claude Code Auto Mode: A Safer Way to Skip Permissions](https://www.anthropic.com/engineering/claude-code-auto-mode)**
  — el post de Anthropic con el dato que sostiene el paper anterior: los
  usuarios aprueban el **93%** de los prompts, lo que vacía de sentido la
  aprobación. Su diseño: clasificador de dos etapas (compuerta rápida de un
  token, razonamiento sólo sobre lo marcado), **eliminar los mensajes del
  asistente del contexto del clasificador** para que el agente no pueda
  racionalizar una acción peligrosa, y **deny-and-continue en vez de halt**.
  Los tres son decisiones que navori documenta de otra forma en el bloque de
  modos de permiso; la tercera es la misma idea que la cola diferida.
- **[Open Agent Passport (OAP)](https://arxiv.org/abs/2603.20953)** —
  especificación abierta de autorización **pre-acción determinista**: intercepta
  la llamada a tool antes de ejecutar, la evalúa contra una política declarativa
  y emite un registro de auditoría firmado. Mediana de 53 ms; en un testbed
  adversarial con bounty de $5,000, política restrictiva 0% de éxito de ataque
  vs 74.6% con política permisiva. Distingue explícitamente **autorización
  pre-acción**, **sandbox** y **screening por modelo** como capas
  complementarias y distintas — la misma asimetría que CCH documenta en su
  `defense-layer-blast-radius.md`.

### 3.3 — Cuánto contexto recibe un subagente

**[Organizing Context in a Multi-Agent Harness](https://www.langchain.com/blog/organizing-context-in-a-multi-agent-harness)**
(LangChain, septiembre 2026) — introduce *context modes* para subagentes:
`isolated` arranca en limpio (aislamiento como firewall), `forked` hereda toda
la conversación del supervisor —con la tool call final excise-ada, la
descripción de tarea reescrita como mensaje de usuario y el prompt caching
preservado por diseño—.

La regla de decisión que publican:

> **forkear a los workers** que continúan una investigación en curso;
> **aislar a los verificadores** que deben juzgar de forma independiente.

Es la guía publicada más clara para una pregunta que todo harness multi-agente
enfrenta y casi ninguno documenta. navori la resuelve implícitamente (el
`reviewer` es fresh-context, el `implementer` recibe scope explícito), pero no
la tiene escrita como regla ni la expone como opción. Conecta con el
`context: fork` que CCH pone en el frontmatter de varias skills.

### 3.4 — Verificar lo no determinista

- **[AgentAssay](https://arxiv.org/abs/2603.02601)** — ataca el problema central
  del CI de agentes: el pass/fail binario es inútil en flujos no deterministas.
  Fingerprinting de comportamiento detecta **86%** de las regresiones vs **0%**
  del testing binario; veredictos estocásticos **PASS / FAIL / INCONCLUSIVE**
  fundados en test de hipótesis recortan **78%** del costo en tokens; y un modo
  offline corre las regresiones contra trazas de producción a costo cero de
  inferencia.
  > **Convergencia notable**: el veredicto `INCONCLUSIVE` de AgentAssay y el
  > "indeterminado" de `shellscan` en CCH son la misma idea en dominios
  > distintos — *no forzar una decisión binaria cuando la evidencia no la
  > sostiene*. Dos fuentes independientes llegando ahí es señal de que es un
  > principio, no un truco.
- **[Harness-Bench](https://arxiv.org/abs/2605.27922)** — benchmark diagnóstico
  que aísla la capa de ejecución (contexto, tools, estado, recuperación)
  evaluando pares modelo-harness sobre tareas compartidas. Sobre 5,194
  trayectorias concluye que **la capacidad debe reportarse a nivel de
  configuración modelo-harness, no atribuirse al modelo base**. Es el argumento
  metodológico que le falta a `navori bench` para que sus números signifiquen
  algo fuera de nuestra máquina.

### 3.5 — El paradigma que no tenemos: meta-harness

La sección *Generators & Meta-Harnesses* (22 entradas) es donde encajaría
navori, y está dominada por algo que no hacemos: **harnesses que se optimizan
solos** midiendo contra un benchmark.

El patrón recurrente, en sus propias palabras: *el humano escribe la directiva
de optimización (`PROGRAM.md` / `program.md`), el agente ejecuta el bucle de
ingeniería del harness* — mina las trazas de fallo, propone ediciones mínimas al
scaffolding, y las valida contra regresiones. Referencias del cluster:
`stanford-iris-lab/meta-harness` (implementación oficial del paper),
`neosigmaai/auto-harness`, `kevinrgu/autoagent`, `retro-harness` (RHO: mejora
usando sólo trayectorias propias, sin labels — SWE-Bench Pro 59% → 78% en una
ronda), `sethkarten/continual-harness` (tool `evolve_harness` en pleno episodio)
y `raphaelchristi/harness-evolver` (worktrees git aislados + guards de
regresión).

Dos entradas de esa sección son las que más se parecen a navori, y conviene
mirarlas de cerca:

- **[ruvnet/metaharness](https://github.com/ruvnet/metaharness)** (644 ★) —
  *"scaffold factory que convierte cualquier repo en un harness de agente
  con marca propia, con su propio CLI `npx`, servidor MCP, memoria con scope y
  política de gobernanza"*. Es la descripción más cercana a navori que he visto
  en el campo. **Es el competidor directo a auditar en la próxima sesión.**
- **[Exo](https://github.com/exoharness/exo)** (1,382 ★) — harness que puede
  editar sus propios prompts, memoria, tools y política *porque hay un event log
  inmutable que es lo único que no puede reescribir*. Es el mismo principio que
  el ratchet de `deny` de CCH, generalizado: **la auto-modificación es segura
  sólo si existe un ancla que el sistema no puede tocar.** navori tiene la
  versión parcial (bloques managed con hash + anti-rollback); no tiene el log.

> **Lectura nuestra**: navori está en la categoría pero no en el paradigma. La
> pregunta estratégica que abre esta sección no es "¿deberíamos auto-optimizar
> el harness?" sino "¿qué tendríamos que medir para que auto-optimizar
> signifique algo?" — y la respuesta empieza por los huecos de la §2:
> observabilidad y evals de skills.

---

## 4. Los templates

Cuatro archivos en `templates/`, con la instrucción explícita de *preservar la
estructura de comentarios porque los comentarios son el valor*. Son genéricos y
menos desarrollados que los assets de navori — nuestro SDD, los bloques managed
y la doctrina de permisos van bastante más lejos. Tres cosas sí valen:

1. **`PLAN.md`: cada milestone declara su comando de verificación** —
   `- [ ] **M1: <nombre>** — <qué significa listo> | verify: <comando>`, con la
   regla de no marcar completo hasta que el gate pase. Nuestro `tasks.md`
   declara los `R<n>` que cubre; **no** obliga a declarar el comando que lo
   prueba. Es un cambio chico con efecto directo sobre `verify-before-done`.
2. **`PLAN.md`: "Out of scope" explícito.** Escribir lo que queda fuera, no sólo
   lo que entra. Barato y previene la mitad de las discusiones de alcance.
3. **`HARNESS_CHECKLIST.md`: la tabla final.** Esta es la idea que me llevaría:

   > Cada componente del harness existe porque el modelo todavía no puede hacer
   > algo. Documenta qué mejora de capacidad lo volvería innecesario.
   >
   > | Componente | Existe porque | Se puede quitar cuando |

   navori acumula bloques managed, hooks y skills sin fecha de caducidad. Una
   columna de "se puede quitar cuando" en `DIRECTION.md` —o en el propio
   frontmatter de cada asset— convierte el harness en algo que puede
   **encoger**, y no sólo crecer. Es la contraparte disciplinada del framing del
   propio README de la lista: *"los mejores harnesses se diseñan sabiendo que
   sus componentes se volverán innecesarios a medida que los modelos mejoren"*.

El resto del `HARNESS_CHECKLIST.md` (permisos mínimos, contexto acotado, gates
de verificación, el agente puede correr él mismo el comando de verificación) es
una lista razonable para auditar el harness que navori **renderiza** en un repo
ajeno, no el repo de navori.

---

## 5. Posicionamiento: navori no está en la lista

Cero menciones. Los criterios de `CONTRIBUTING.md` son tres y navori los cumple:
resuelve un problema específico de harness engineering, vale el tiempo de
alguien, y es *vendor-agnostic por principio* (el patrón generaliza aunque hoy
rendericemos sobre todo a `.claude/`).

Encajaría en **Generators & Meta-Harnesses**, con una nota del estilo:

> *navori — CLI que renderiza un harness multi-agente + SDD dentro de un repo
> existente desde una sola config, con bloques managed sincronizables y
> adaptadores por engine. A diferencia de los meta-harnesses que optimizan el
> scaffolding contra un benchmark, resuelve el problema anterior: mantener el
> mismo harness reproducible y actualizable en N repos.*

**Es una decisión tuya, no la ejecuté.** Dos cosas a considerar antes: la lista
premia notas con métricas verificables (tenemos las de
`activacion-subagentes-y-skills.md`, que son honestas y propias), y estar en un
índice de 477 entradas rinde poco si el repo no aguanta la visita que trae.

---

## 6. Acciones propuestas

| # | Acción | Esfuerzo | Por qué |
|---|---|---|---|
| 1 | Citar Stripe *"You can't whisper at an AI agent"* en `activacion-subagentes-y-skills.md` | XS | Confirmación externa e independiente de nuestra causa raíz |
| 2 | Citar *When "Do Not" Is Not Deny* (481 `CLAUDE.md`, ~4%) en `DIRECTION.md` | XS | La mejor evidencia externa a favor de la arquitectura de navori |
| 3 | Postura escrita frente a *Do User-Authored Permission Policies…* | S | Es evidencia en contra de parte de lo que generamos; hay que responderla, no ignorarla |
| 4 | Evaluar `mgechev/skillgrade` contra `navori bench` | S | Ya hace lo que nos falta: saber si el agente descubre e invoca la skill |
| 5 | Medir el catálogo de skills contra el hallazgo de ≤12 de LangChain | S | Hipótesis concreta y medible sobre la tasa de activación |
| 6 | `verify: <comando>` obligatorio por task en `tasks.md` | S | Cierra el hueco entre "tarea hecha" y "tarea verificada" |
| 7 | Columna "se puede quitar cuando" para los assets managed | M | El harness tiene que poder encoger, no sólo crecer |
| 8 | Regla `isolated` vs `forked` escrita en el bloque de orquestación | M | Hoy es implícita; LangChain publicó la regla de decisión |
| 9 | Auditar `ruvnet/metaharness` | M | El competidor más cercano descrito en el campo |
| 10 | Veredicto `INCONCLUSIVE` en el gate de evals (AgentAssay) | M | Converge con el "indeterminado" de CCH: no forzar binario sin evidencia |

Las tres primeras son de esta semana y no requieren decisión de producto.

---

## 7. Cierre

La lista no aporta arquitectura: aporta **mapa y bibliografía**. Su mejor idea
es organizativa —clasificar por problema, no por vendor— y su segundo mejor
aporte es la disciplina del gate de PR (nota obligatoria, ~10 entradas por
sección, verificador de links).

Para navori el rendimiento inmediato son cinco fuentes concretas sobre dos
problemas que ya tenemos medidos —activación de skills y diseño de permisos—,
más un dato incómodo y útil: la sección donde competimos está llena de proyectos
que **miden** su harness y lo evolucionan contra esa medición. Nosotros
renderizamos un harness excelente y recién empezamos a medirlo. Esa brecha, no
la de features, es la que conviene cerrar.

---

## Apéndice — listas hermanas que indexa

Por si toca ampliar el barrido: `RUCAIBox/awesome-agent-harness`,
`Picrew/awesome-agent-harness`, `jiji262/awesome-harness-engineering`,
`EvoMap/awesome-agent-evolution`, `hesreallyhim/awesome-claude-code`,
`bradAGI/awesome-cli-coding-agents`, `danielrosehill/AI-Harnesses`,
`RyanAlberts/best-of-Agent-Harnesses`,
`YennNing/Awesome-Code-as-Agent-Harness-Papers`,
`Meirtz/Awesome-Context-Engineering`.
