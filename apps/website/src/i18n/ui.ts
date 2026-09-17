export const languages = {
  es: "Español",
  en: "English",
} as const;

export const defaultLang = "es" as const;

export type Lang = keyof typeof languages;

/**
 * Every visible string on the site, in both languages.
 *
 * The `en` block is not optional decoration: a landing that ships bilingual and
 * only updates one half ends up describing two different products. Add a key to
 * both at once — `UIKey` is derived from `es`, so a missing `en` key is a type
 * error at the call site, not a silent fallback.
 *
 * Numbers in this copy come from `../consts.ts` where they can be asserted
 * against the repo. Do not hardcode a count here.
 */
export const ui = {
  es: {
    "site.tagline": "El harness multi-agente para cualquier repo",
    "site.description":
      "navori instala en cualquier repo un harness multi-agente + SDD reproducible: agentes, skills, hooks, permisos y memoria, versionados en un solo config y renderizados a Claude Code, Codex, Cursor, Copilot y AGENTS.md.",
    "nav.docs": "Docs",
    "nav.quickstart": "Quickstart",
    "nav.deepdive": "A fondo",
    "nav.github": "GitHub",
    "nav.npm": "npm",
    "lang.switchTo": "English",

    "hero.eyebrow": "open source · 5 engines",
    "hero.headlineA": "El harness multi-agente",
    "hero.headlineB": "para cualquier repo.",
    "hero.subhead":
      "Agentes, skills, hooks, permisos y memoria — versionados en un solo config y reconstruibles con un comando. Se renderiza a Claude Code, Codex, Cursor, Copilot y AGENTS.md sin pisar una línea de lo tuyo.",
    "hero.cta.primary": "Empezar",
    "hero.cta.secondary": "Ver en GitHub",
    "hero.install.label": "Instalación",

    // ── el recorrido: un prompt entrando al harness ───────────────────
    "graph.eyebrow": "Anatomía de una sesión",
    "graph.title": "Sigue un prompt por dentro del harness",
    "graph.subtitle":
      "Sin harness, tu frase llega sola a un modelo que decide por su cuenta. Esto es todo lo que navori pone en el camino — ocho paradas, de la frase al commit, y de vuelta a la memoria.",
    "graph.aria":
      "Diagrama del recorrido de un prompt: entra, se le carga el contexto del repo, el orchestrator lo descompone, las herramientas de búsqueda lo ubican en el código, los subagentes trabajan en paralelo, los guardas y los gates de calidad lo filtran, y termina en un commit cuya decisión vuelve a la memoria.",
    "graph.hint": "El recorrido avanza solo. Toca una parada para saltar a ella.",
    "graph.pause": "Pausar",
    "graph.play": "Reanudar",
    "graph.replay": "Volver a empezar",
    "graph.prompt": "arregla el bug del login que reportó soporte",
    "graph.promptLabel": "tu prompt",
    "graph.stationOf": "Parada {n} de {total}",

    "graph.s1.name": "Entra",
    "graph.s1.title": "Escribes una frase. Todavía no piensa nadie.",
    "graph.s1.body":
      "Antes de que el modelo lea tu prompt, un hook de arranque ya corrió. Es la diferencia entre un asistente que empieza en blanco cada mañana y uno que abre la sesión sabiendo dónde está parado.",
    "graph.s2.name": "Contexto",
    "graph.s2.title": "Cuatro fuentes entran antes que tu frase",
    "graph.s2.body":
      "Las reglas de este repo, la guía de esta tarea, los hechos que valen para todo el workspace y lo que ya se decidió en sesiones pasadas. Nada de esto se lo tienes que contar tú otra vez.",
    "graph.s3.name": "Orquesta",
    "graph.s3.title": "El agente con el que hablas no hace el trabajo",
    "graph.s3.body":
      "Lee, decide en cuántas piezas se parte y a quién le toca cada una. Es el único que ve la tarea completa — y el único que corre en el modelo caro, porque su trabajo es juzgar, no leer archivos.",
    "graph.s4.name": "Ubica",
    "graph.s4.title": "Primero encontrar, después leer",
    "graph.s4.body":
      "Dos preguntas distintas con dos herramientas distintas: dónde vive un símbolo y qué se rompe si lo tocas, contra qué archivos contienen esta cadena. Sin esto, un agente abre veinte archivos para encontrar uno.",
    "graph.s5.name": "Trabaja",
    "graph.s5.title": "Tres especialistas, en paralelo, sin estorbarse",
    "graph.s5.body":
      "Cada uno corre en su propia ventana de contexto y devuelve la conclusión, no el volcado de lo que leyó. Por eso el hilo principal no se llena de ruido y por eso el modelo caro no paga por leer.",
    "graph.s6.name": "Protege",
    "graph.s6.title": "Lo que el agente NO puede hacer",
    "graph.s6.body":
      "Un hook intercepta cada herramienta antes de que corra, y los permisos declaran qué pasa sin preguntar, qué pregunta y qué está prohibido. El `rm -rf` con una variable se bloquea aquí, no después.",
    "graph.s7.name": "Filtra",
    "graph.s7.title": "Nada se da por terminado porque alguien lo diga",
    "graph.s7.body":
      "Seguridad y duplicación sobre el diff, el quality gate del repo corriendo de verdad, y un reviewer con contexto fresco que aprueba o rechaza con motivos. Cuatro filtros que no son opiniones.",
    "graph.s8.name": "Cierra",
    "graph.s8.title": "El commit no es el final: la decisión se guarda",
    "graph.s8.body":
      "Sale el commit con el formato del repo y su PR. Y lo que se decidió —y por qué— vuelve a la memoria, que es de donde saldrá el contexto de la sesión del lunes. El ciclo se cierra solo.",

    "graph.chip.sessionstart": "arranca el harness",
    "graph.chip.claudemd": "las reglas de este repo",
    "graph.chip.skills": "la guía de esta tarea",
    "graph.chip.dominio": "hechos de todo el workspace",
    "graph.chip.engram": "lo que ya se decidió",
    "graph.chip.orchestrator": "descompone y reparte",
    "graph.chip.codegraph": "dónde vive · quién lo llama",
    "graph.chip.tgrep": "qué archivos lo contienen",
    "graph.chip.scout": "mapea o investiga",
    "graph.chip.implementer": "escribe el código",
    "graph.chip.auditor": "busca lo que duele",
    "graph.chip.guard": "bloquea lo destructivo",
    "graph.chip.permissions": "allow · ask · deny",
    "graph.chip.semgrep": "seguridad en el diff",
    "graph.chip.jscpd": "duplicación",
    "graph.chip.gate": "lint · tests · formato",
    "graph.chip.reviewer": "aprueba o rechaza",
    "graph.chip.commit": "commit + PR",
    "graph.chip.memory": "guarda la decisión",
    "graph.loop": "lo guardado vuelve al contexto de la próxima sesión",
    "graph.loopIn": "de la sesión anterior",

    "problem.eyebrow": "El problema",
    "problem.title": "Cada repo reinventa lo mismo",
    "problem.subtitle":
      "Si trabajas con varios proyectos y agentes de IA, sabes a qué nos referimos.",
    "problem.card1.title": "Cada repo, su propio harness",
    "problem.card1.body":
      "Copias y pegas .claude/ de un proyecto a otro. Mantenerlo sincronizado es manual y propenso a errores.",
    "problem.card2.title": "Cada engine, su propia config",
    "problem.card2.body":
      "Claude tiene .claude/, Cursor tiene .cursor/, Copilot tiene .github/copilot-instructions.md. La misma intención, tres archivos.",
    "problem.card3.title": "El SDD se erosiona",
    "problem.card3.body":
      "Las skills, los hooks y las convenciones de Spec-Driven Development se pierden con el tiempo si no hay una forma de versionarlas y actualizarlas.",

    // ── los tres alcances ─────────────────────────────────────────────
    "scopes.eyebrow": "Alcances",
    "scopes.title": "El harness ya no vive solo en el repo",
    "scopes.subtitle":
      "Tres alcances aditivos, cada uno opt-in. Ninguno degrada al de abajo: el de la máquina se hace a un lado en cuanto encuentra un repo con navori.",
    "scopes.repo.tag": "por repo",
    "scopes.repo.title": "El repo",
    "scopes.repo.body":
      "navori.config.json checked-in es la fuente de verdad. render reconstruye CLAUDE.md, .claude/ y progress/ desde ahí, idempotente y sin tocar lo que escribiste tú.",
    "scopes.repo.cmd": "navori init",
    "scopes.global.tag": "por máquina",
    "scopes.global.title": "La máquina",
    "scopes.global.body":
      "Las sesiones que arrancan fuera de un repo con navori —un scratch, un repo ajeno, tu home— hoy no tienen harness de ninguna clase. La capa global instala un piso de doctrina en ~/.claude, y se aparta sola cuando el repo trae el suyo.",
    "scopes.global.cmd": "navori global init",
    "scopes.workspace.tag": "por organización",
    "scopes.workspace.title": "El workspace",
    "scopes.workspace.body":
      "Defaults de toda la org —quality gate, branch base, convenciones— y el Dominio: los hechos durables que cruzan repos y no caben en el CLAUDE.md de ninguno. Un modelo de datos, un contrato entre servicios, un gotcha compartido.",
    "scopes.workspace.cmd": "navori workspace · navori dominio",
    "scopes.footnote":
      "Huella cero sin opt-in: sin el init correspondiente, navori no escribió un solo byte fuera de tu repo.",

    "how.eyebrow": "Cómo funciona",
    "how.title": "5 capas en cascada, una sola fuente de verdad",
    "how.subtitle":
      "Cada capa se compone sobre la anterior. Tú decides cuánto control quieres a nivel proyecto.",
    "how.layer1.name": "Core",
    "how.layer1.body":
      "El baseline gestionado por navori: agentes, skills, hooks y los bloques de doctrina. Siempre presente.",
    "how.layer2.name": "Preset",
    "how.layer2.body":
      "Configuración por stack — Next.js, NestJS, Astro, Expo, Medusa, monorepos y más. ¿Falta el tuyo? Creas uno local con `navori preset init`.",
    "how.layer3.name": "Workspace",
    "how.layer3.body":
      "Reglas de toda tu organización compartidas entre repos, más el Dominio del workspace.",
    "how.layer4.name": "Project",
    "how.layer4.body":
      "Lo específico del repo en navori.config.json: quality gate, áreas críticas, rutas legacy y los plugins que habilitas.",
    "how.layer5.name": "Adapters",
    "how.layer5.body":
      "Renderizado por engine para Claude Code, Codex, Cursor, Copilot y AGENTS.md, todos sobre el mismo pipeline.",
    "how.config.label": "navori.config.json",

    "flow.eyebrow": "En vivo",
    "flow.title": "Mira qué aporta cada capa",
    "flow.subtitle":
      "Haz click en una capa para resaltar qué parte del harness genera. Los adapters lo materializan en el formato nativo de cada engine.",
    "flow.all": "Todas",
    "flow.engineLabel": "Engine adapters →",
    "flow.hint": "Selecciona una capa para ver su aporte.",
    "flow.core.note": "Baseline: agents, skills y los bloques de reglas siempre presentes.",
    "flow.preset.note": "Skills específicas del stack — acá, Next.js.",
    "flow.workspace.note": "Defaults heredados de tu org: quality gate, branch base.",
    "flow.project.note": "Lo del repo: los plugins que habilitas (engram) y su protocolo.",

    // ── la caja de herramientas del agente ────────────────────────────
    "toolbox.eyebrow": "Caja de herramientas",
    "toolbox.title": "navori no ejecuta las herramientas, le enseña a usarlas",
    "toolbox.subtitle":
      "Cada plugin es un bundle: trae su skill, su bloque de protocolo, sus permisos y su check de doctor. Habilitas el que quieres y el harness sabe cuándo recurrir a él — y cuándo no.",
    "toolbox.codegraph.title": "Buscar por estructura",
    "toolbox.codegraph.body":
      "Un grafo AST local del repo. Dónde vive un símbolo, quién lo llama y qué se rompe si lo cambias — una consulta en vez de una ronda de greps y lecturas.",
    "toolbox.tgrep.title": "Buscar por contenido",
    "toolbox.tgrep.body":
      "Índice de trigramas sobre el repo. Qué archivos contienen esta cadena, con el contrato de exit code intacto y sin pelear con el motor que tenga la máquina.",
    "toolbox.semgrep.title": "Seguridad",
    "toolbox.semgrep.body":
      "Análisis estático de patrones peligrosos sobre el diff, integrado al gate del reviewer en lugar de quedar como un paso que alguien tiene que acordarse de correr.",
    "toolbox.jscpd.title": "Duplicación",
    "toolbox.jscpd.body":
      "Detecta copy-paste antes de que se vuelva deuda. Un agente que no ve el código que ya existe lo reescribe; esto es lo que se lo enseña.",
    "toolbox.engram.title": "Memoria persistente",
    "toolbox.engram.body":
      "Decisiones, causas raíz y convenciones que sobreviven al cierre de sesión y a las compactaciones de contexto. No vuelves a explicar el lunes lo que decidiste el viernes.",
    "toolbox.gh.title": "GitHub",
    "toolbox.gh.body":
      "Issues, PRs y checks por gh. El agente lee el ticket, abre el PR con el formato del repo y sabe leer un CI en rojo.",
    "toolbox.acli.title": "Jira",
    "toolbox.acli.body":
      "Lectura y escritura de tickets por acli, con la cuenta correcta. El intake de un ticket empieza por el ticket, no por una descripción pegada a mano.",
    "toolbox.note":
      "navori genera el harness; no corre grep, ni los tests, ni el linter por el agente. Dicta qué herramienta usar y con qué doctrina — el resto lo ejecuta quien corresponde.",

    // ── observabilidad ────────────────────────────────────────────────
    "audit.eyebrow": "Observabilidad",
    "audit.title": "El harness que se audita a sí mismo",
    "audit.subtitle":
      "Escribir doctrina es fácil; saber si alguien la siguió, no. navori audit responde las dos preguntas que ninguna otra cosa responde: a dónde se fueron los tokens y qué instrucciones nadie obedeció.",
    "audit.point1.title": "A dónde se fueron los tokens",
    "audit.point1.body":
      "Facturable, arranque y por agente. El costo del harness deja de ser una intuición y pasa a ser un número que puedes atacar.",
    "audit.point2.title": "Qué instrucciones nadie siguió",
    "audit.point2.body":
      "Hallazgos con severidad sobre el ruteo real: la skill que se ignoró, la búsqueda que fue por el camino caro, la delegación que no ocurrió.",
    "audit.point3.title": "Tres fuentes que no se sustituyen",
    "audit.point3.body":
      "El log que escriben los hooks (qué hizo el harness), el transcript (el único lugar donde viven los tokens) y los eventos OTel del host (qué permiso se aprobó y qué skill estaba activa).",
    "audit.point4.title": "Opt-in y por sesión",
    "audit.point4.body":
      "Sin un --start previo no hay log que auditar y navori no observa nada. El reporte queda en markdown y JSON dentro de ~/.navori/audits/.",

    "commands.eyebrow": "Comandos",
    "commands.title": "El ciclo completo, comando a comando.",
    "commands.subtitle":
      "Todos los subcomandos que el CLI registra, agrupados por el momento en que los necesitas. Cada uno tiene su página de referencia.",
    "commands.group.start": "Empezar",
    "commands.group.render": "Renderizar y actualizar",
    "commands.group.operate": "Operar",
    "commands.group.observe": "Observar",
    "commands.group.scale": "Escalar",
    "commands.docsCta": "Ver la referencia completa",

    "commands.init.desc":
      "Detecta el stack, hace unas preguntas y deja el repo listo en un minuto.",
    "commands.adopt.desc":
      "Toma un archivo del harness que escribiste a mano y lo pone bajo gestión, sin cambiar lo que dice.",
    "commands.add.desc": "Habilita un plugin, o sugiere cuáles según tu stack.",
    "commands.remove.desc": "Desactiva un plugin y limpia los bloques y scripts que había dejado.",
    "commands.preset.desc":
      "Crea un preset local cuando tu stack no tiene uno oficial, y lo deja conectado al config.",
    "commands.configure.desc":
      "Edita el config sin abrirlo a mano: quality gate, áreas críticas, rutas legacy.",
    "commands.render.desc":
      "Reconstruye todos los engines configurados. Preview por default; --apply escribe.",
    "commands.sync.desc":
      "Actualiza solo los bloques managed. Con --interactive resuelves los conflictos bloque por bloque.",
    "commands.update.desc":
      "Detecta que el bundle avanzó y te dice qué cambiaría antes de tocarlo.",
    "commands.migrations.desc": "Aplica las migraciones de config entre versiones del CLI.",
    "commands.backup.desc":
      "La red de seguridad: cada escritura deja antes un snapshot restaurable.",
    "commands.doctor.desc":
      "Drift, plugins rotos, invariants, harness ajeno en conflicto y próximos pasos.",
    "commands.status.desc": "Snapshot al vuelo: config, plugins, drift y qué hacer ahora.",
    "commands.scan.desc": "Recorre un monorepo y asigna preset a cada workspace.",
    "commands.registry.desc": "Qué presets, plugins y engines tiene disponible esta versión.",
    "commands.bench.desc": "Mide render sobre N corridas y reporta p50/p95.",
    "commands.audit.desc":
      "Cómo corrió el harness de verdad: tokens por agente y doctrina que nadie siguió.",
    "commands.global.desc":
      "El harness base por máquina en ~/.claude, para las sesiones fuera de un repo con navori.",
    "commands.workspace.desc":
      "Config cross-repo y render del estándar a todos los repos de la org.",
    "commands.dominio.desc": "La base de conocimiento del workspace: los hechos que cruzan repos.",
    "commands.ticket.desc": "Tickets como archivos versionables dentro del workspace.",

    "engines.eyebrow": "Multi-engine",
    "engines.title": "Una config, cinco engines.",
    "engines.subtitle":
      "El mismo harness materializado en el formato nativo de cada uno, sobre un solo pipeline de render. Agregar el sexto cuesta una tabla declarativa, no reescribir nada.",
    "engines.claude.detail": "agentes · skills · hooks · settings.json con permisos",
    "engines.codex.detail": "agentes propios · skills · hooks · servidores MCP",
    "engines.agentsmd.detail": "spec universal · la leen Cursor, Codex, Gemini y Copilot",
    "engines.cursor.detail": "reglas .mdc · contexto de proyecto",
    "engines.copilot.detail": "instrucciones de workspace",
    "engines.status": "disponible",

    "quickstart.eyebrow": "Quickstart",
    "quickstart.title": "De cero a productivo en tres pasos",
    "quickstart.step1.title": "Instala",
    "quickstart.step1.body": "Sin instalación global. Usa npx.",
    "quickstart.step2.title": "Inicializa",
    "quickstart.step2.body":
      "Responde unas preguntas y obtén navori.config.json + el harness renderizado.",
    "quickstart.step3.title": "Renderiza cuando cambies algo",
    "quickstart.step3.body":
      "Edita el config, corre 'render --apply' y commitea. Todo idempotente.",

    "faq.eyebrow": "Preguntas frecuentes",
    "faq.title": "Lo que probablemente te estás preguntando",
    "faq.q1": "¿Y si ya tengo un .claude/ que armé a mano?",
    "faq.a1":
      "navori coexiste. init detecta tu harness existente y solo agrega bloques managed con marcadores; tu contenido personalizado queda intacto. Si quieres que navori se haga cargo de un archivo tuyo, 'navori adopt' lo envuelve sin cambiar una palabra de lo que dice. Y si tu setup ya trae su propia orquestación o SDD, blocks.exclude deja que navori opte por no renderear esos bloques para no competir con los tuyos.",
    "faq.q2": "¿Qué engines soporta hoy?",
    "faq.a2":
      "Cinco, todos entregados: Claude Code (.claude/), Codex nativo (agentes, skills, hooks y MCP), AGENTS.md universal, Cursor (.cursor/rules/) y Copilot. Corren sobre el mismo pipeline de render, así que un arreglo llega a todos a la vez en lugar de divergir en silencio.",
    "faq.q3": "¿Necesito Claude Code para usar navori?",
    "faq.a3":
      "No. navori es un scaffolder: genera el harness y se sale del camino. La herramienta corre en cualquier Node 20+ y renderiza a cinco engines distintos.",
    "faq.q4": "¿Qué tan invasivo es? ¿Puedo revertirlo?",
    "faq.a4":
      "render hace preview por default: sin --apply no toca disco. Cuando escribe, deja antes un snapshot restaurable con 'navori backup', y la escritura es atómica. Fuera del repo no existe nada que no hayas pedido por su nombre: sin 'global init' no hay capa global, sin '--start' no hay auditoría.",
    "faq.q5": "¿Cómo actualizo mi proyecto cuando sale una versión nueva?",
    "faq.a5":
      "npx navori@latest sync. Actualiza solo los bloques managed sin tocar tu código; con --interactive resuelves bloque por bloque lo que hayas editado a mano. 'navori update' te dice antes qué cambiaría.",
    "faq.q6": "¿No sale caro correr un harness multi-agente?",
    "faq.a6":
      "Menos de lo que parece, y ya no hace falta creerlo: 'navori audit' te dice a dónde se fueron los tokens de una sesión real. Cada agente corre con su modelo y su effort — el músculo solo donde hay juicio, lo mecánico en un modelo ligero — y cada subagente devuelve su conclusión en vez del volcado de lo que leyó.",

    "footer.tagline": "Open source, MIT. Hecho por developers que trabajan con muchos repos.",
    "footer.links": "Enlaces",
    "footer.legal": "Licencia",
  },
  en: {
    "site.tagline": "The multi-agent harness for any repo",
    "site.description":
      "navori drops a reproducible multi-agent + SDD harness into any repo: agents, skills, hooks, permissions and memory, versioned in one config and rendered to Claude Code, Codex, Cursor, Copilot and AGENTS.md.",
    "nav.docs": "Docs",
    "nav.quickstart": "Quickstart",
    "nav.deepdive": "Deep dive",
    "nav.github": "GitHub",
    "nav.npm": "npm",
    "lang.switchTo": "Español",

    "hero.eyebrow": "open source · 5 engines",
    "hero.headlineA": "The multi-agent harness",
    "hero.headlineB": "for any repo.",
    "hero.subhead":
      "Agents, skills, hooks, permissions and memory — versioned in one config and rebuildable with a single command. Renders to Claude Code, Codex, Cursor, Copilot and AGENTS.md without overwriting a line of yours.",
    "hero.cta.primary": "Get started",
    "hero.cta.secondary": "View on GitHub",
    "hero.install.label": "Install",

    // ── the walkthrough: a prompt entering the harness ────────────────
    "graph.eyebrow": "Anatomy of a session",
    "graph.title": "Follow one prompt through the harness",
    "graph.subtitle":
      "With no harness, your sentence reaches a model that decides alone. This is everything navori puts in its path — eight stops, from the sentence to the commit, and back into memory.",
    "graph.aria":
      "Diagram of a prompt's journey: it arrives, the repo's context is loaded around it, the orchestrator breaks it down, search tools locate it in the code, subagents work in parallel, guards and quality gates filter the result, and it ends in a commit whose decision returns to memory.",
    "graph.hint": "The walkthrough runs on its own. Tap a stop to jump to it.",
    "graph.pause": "Pause",
    "graph.play": "Resume",
    "graph.replay": "Start over",
    "graph.prompt": "fix the login bug support reported",
    "graph.promptLabel": "your prompt",
    "graph.stationOf": "Stop {n} of {total}",

    "graph.s1.name": "Arrives",
    "graph.s1.title": "You type a sentence. Nobody has thought yet.",
    "graph.s1.body":
      "Before the model reads your prompt, a startup hook has already run. That's the difference between an assistant that starts blank every morning and one that opens the session knowing where it stands.",
    "graph.s2.name": "Context",
    "graph.s2.title": "Four sources load ahead of your sentence",
    "graph.s2.body":
      "This repo's rules, this task's guide, the facts that hold across the workspace, and what past sessions already settled. None of it is yours to explain again.",
    "graph.s3.name": "Orchestrates",
    "graph.s3.title": "The agent you talk to doesn't do the work",
    "graph.s3.body":
      "It reads, decides how many pieces the task splits into and who gets each one. It's the only one seeing the whole task — and the only one on the expensive model, because its job is judgment, not reading files.",
    "graph.s4.name": "Locates",
    "graph.s4.title": "Find first, read second",
    "graph.s4.body":
      "Two different questions, two different tools: where a symbol lives and what breaks if you touch it, versus which files hold this string. Without them, an agent opens twenty files to find one.",
    "graph.s5.name": "Works",
    "graph.s5.title": "Three specialists, in parallel, not blocking each other",
    "graph.s5.body":
      "Each runs in its own context window and returns the conclusion, not a dump of what it read. That's why the main thread doesn't fill with noise, and why the expensive model never pays to read.",
    "graph.s6.name": "Guards",
    "graph.s6.title": "What the agent is NOT allowed to do",
    "graph.s6.body":
      "A hook intercepts every tool before it runs, and permissions declare what passes silently, what asks, and what is forbidden outright. An `rm -rf` behind a variable is blocked here, not afterwards.",
    "graph.s7.name": "Filters",
    "graph.s7.title": "Nothing is done just because someone says so",
    "graph.s7.body":
      "Security and duplication over the diff, the repo's quality gate actually running, and a reviewer with fresh context that approves or rejects with reasons. Four filters that aren't opinions.",
    "graph.s8.name": "Closes",
    "graph.s8.title": "The commit isn't the end: the decision is kept",
    "graph.s8.body":
      "Out comes the commit in the repo's format, with its PR. And what was decided — and why — returns to memory, which is where Monday's session will get its context. The loop closes itself.",

    "graph.chip.sessionstart": "boots the harness",
    "graph.chip.claudemd": "this repo's rules",
    "graph.chip.skills": "this task's guide",
    "graph.chip.dominio": "workspace-wide facts",
    "graph.chip.engram": "what was already settled",
    "graph.chip.orchestrator": "splits and delegates",
    "graph.chip.codegraph": "where it lives · who calls it",
    "graph.chip.tgrep": "which files hold it",
    "graph.chip.scout": "maps or investigates",
    "graph.chip.implementer": "writes the code",
    "graph.chip.auditor": "hunts what hurts",
    "graph.chip.guard": "blocks the destructive",
    "graph.chip.permissions": "allow · ask · deny",
    "graph.chip.semgrep": "security on the diff",
    "graph.chip.jscpd": "duplication",
    "graph.chip.gate": "lint · tests · format",
    "graph.chip.reviewer": "approves or rejects",
    "graph.chip.commit": "commit + PR",
    "graph.chip.memory": "saves the decision",
    "graph.loop": "what is saved returns as the next session's context",
    "graph.loopIn": "from the previous session",

    "problem.eyebrow": "The problem",
    "problem.title": "Every repo reinvents the same thing",
    "problem.subtitle":
      "If you work with multiple projects and AI agents, you know exactly what we mean.",
    "problem.card1.title": "Every repo, its own harness",
    "problem.card1.body":
      "You copy .claude/ from one project to the next. Keeping it in sync is manual and error-prone.",
    "problem.card2.title": "Every engine, its own config",
    "problem.card2.body":
      "Claude has .claude/, Cursor has .cursor/, Copilot has .github/copilot-instructions.md. Same intent, three files.",
    "problem.card3.title": "SDD erodes over time",
    "problem.card3.body":
      "Skills, hooks, and Spec-Driven Development conventions decay when there's no way to version and roll them forward.",

    "scopes.eyebrow": "Scopes",
    "scopes.title": "The harness no longer lives only in the repo",
    "scopes.subtitle":
      "Three additive scopes, each opt-in. None degrades the one below it: the machine layer steps aside the moment it finds a repo with navori.",
    "scopes.repo.tag": "per repo",
    "scopes.repo.title": "The repo",
    "scopes.repo.body":
      "A checked-in navori.config.json is the source of truth. render rebuilds CLAUDE.md, .claude/ and progress/ from it — idempotent, and without touching what you wrote.",
    "scopes.repo.cmd": "navori init",
    "scopes.global.tag": "per machine",
    "scopes.global.title": "The machine",
    "scopes.global.body":
      "Sessions that start outside a navori repo — a scratch dir, someone else's project, your home — have no harness at all. The global layer installs a floor of doctrine in ~/.claude, and steps aside on its own when the repo brings its own.",
    "scopes.global.cmd": "navori global init",
    "scopes.workspace.tag": "per organization",
    "scopes.workspace.title": "The workspace",
    "scopes.workspace.body":
      "Org-wide defaults — quality gate, branch base, conventions — plus the Dominio: durable facts that span repos and fit in no single CLAUDE.md. A data model, a contract between services, a shared gotcha.",
    "scopes.workspace.cmd": "navori workspace · navori dominio",
    "scopes.footnote":
      "Zero footprint without opt-in: without the matching init, navori has not written a single byte outside your repo.",

    "how.eyebrow": "How it works",
    "how.title": "Five cascading layers, one source of truth",
    "how.subtitle":
      "Each layer composes on top of the previous one. You choose how much control you want at project level.",
    "how.layer1.name": "Core",
    "how.layer1.body":
      "The baseline navori owns: agents, skills, hooks and the doctrine blocks. Always present.",
    "how.layer2.name": "Preset",
    "how.layer2.body":
      "Stack-specific defaults — Next.js, NestJS, Astro, Expo, Medusa, monorepos and more. Missing yours? Scaffold a local one with `navori preset init`.",
    "how.layer3.name": "Workspace",
    "how.layer3.body": "Org-wide rules shared across repos, plus the workspace Dominio.",
    "how.layer4.name": "Project",
    "how.layer4.body":
      "What's unique to this repo in navori.config.json: quality gate, critical areas, legacy paths and the plugins you enable.",
    "how.layer5.name": "Adapters",
    "how.layer5.body":
      "Per-engine rendering for Claude Code, Codex, Cursor, Copilot and AGENTS.md — all on one pipeline.",
    "how.config.label": "navori.config.json",

    "flow.eyebrow": "Live",
    "flow.title": "See what each layer contributes",
    "flow.subtitle":
      "Click a layer to highlight what it contributes. Adapters materialize it in each engine's native format.",
    "flow.all": "All",
    "flow.engineLabel": "Engine adapters →",
    "flow.hint": "Pick a layer to see what it adds.",
    "flow.core.note": "Baseline: agents, skills and the rule blocks that are always present.",
    "flow.preset.note": "Stack-specific skills — here, Next.js.",
    "flow.workspace.note": "Defaults inherited from your org: quality gate, branch base.",
    "flow.project.note": "Repo-level: the plugins you enable (engram) and its protocol.",

    "toolbox.eyebrow": "Toolbox",
    "toolbox.title": "navori doesn't run the tools, it teaches the agent to use them",
    "toolbox.subtitle":
      "Every plugin is a bundle: its skill, its protocol block, its permissions and its doctor check. Enable the ones you want and the harness knows when to reach for them — and when not to.",
    "toolbox.codegraph.title": "Search by structure",
    "toolbox.codegraph.body":
      "A local AST graph of the repo. Where a symbol lives, who calls it and what breaks if you change it — one query instead of a round of greps and reads.",
    "toolbox.tgrep.title": "Search by content",
    "toolbox.tgrep.body":
      "A trigram index over the repo. Which files hold this string, with the exit-code contract intact and no fight over which engine the machine happens to have.",
    "toolbox.semgrep.title": "Security",
    "toolbox.semgrep.body":
      "Static analysis for dangerous patterns over the diff, wired into the reviewer's gate instead of sitting there as a step someone has to remember to run.",
    "toolbox.jscpd.title": "Duplication",
    "toolbox.jscpd.body":
      "Catches copy-paste before it becomes debt. An agent that can't see the code that already exists rewrites it; this is what shows it.",
    "toolbox.engram.title": "Persistent memory",
    "toolbox.engram.body":
      "Decisions, root causes and conventions that survive session close and context compaction. You don't re-explain on Monday what you settled on Friday.",
    "toolbox.gh.title": "GitHub",
    "toolbox.gh.body":
      "Issues, PRs and checks through gh. The agent reads the ticket, opens the PR in the repo's format, and knows how to read a red CI.",
    "toolbox.acli.title": "Jira",
    "toolbox.acli.body":
      "Reading and writing tickets through acli, from the right account. Ticket intake starts at the ticket, not at a description pasted by hand.",
    "toolbox.note":
      "navori generates the harness; it does not run grep, the tests or the linter on the agent's behalf. It dictates which tool to use and under what doctrine — the rest is executed by whoever owns it.",

    "audit.eyebrow": "Observability",
    "audit.title": "The harness that audits itself",
    "audit.subtitle":
      "Writing doctrine is easy; knowing whether anyone followed it isn't. navori audit answers the two questions nothing else does: where the tokens went, and which instructions nobody obeyed.",
    "audit.point1.title": "Where the tokens went",
    "audit.point1.body":
      "Billable, startup, and per agent. The harness's cost stops being a hunch and becomes a number you can attack.",
    "audit.point2.title": "Which instructions nobody followed",
    "audit.point2.body":
      "Severity-ranked findings about real routing: the skill that got ignored, the search that took the expensive path, the delegation that never happened.",
    "audit.point3.title": "Three sources that don't replace each other",
    "audit.point3.body":
      "The event log the hooks write (what the harness did), the transcript (the only place tokens live), and the host's OTel events (which permission was approved, which skill was active).",
    "audit.point4.title": "Opt-in, one session at a time",
    "audit.point4.body":
      "With no prior --start there is no log to audit and navori observes nothing. The report lands as markdown and JSON under ~/.navori/audits/.",

    "commands.eyebrow": "Commands",
    "commands.title": "The whole lifecycle, command by command.",
    "commands.subtitle":
      "Every subcommand the CLI registers, grouped by when you actually need it. Each one has its own reference page.",
    "commands.group.start": "Get started",
    "commands.group.render": "Render and update",
    "commands.group.operate": "Operate",
    "commands.group.observe": "Observe",
    "commands.group.scale": "Scale",
    "commands.docsCta": "See the full reference",

    "commands.init.desc":
      "Detects the stack, asks a few questions, and leaves the repo ready in a minute.",
    "commands.adopt.desc":
      "Takes a harness file you wrote by hand and puts it under management, without changing what it says.",
    "commands.add.desc": "Enables a plugin, or suggests which ones fit your stack.",
    "commands.remove.desc":
      "Disables a plugin and cleans up the blocks and scripts it left behind.",
    "commands.preset.desc":
      "Scaffolds a local preset when your stack has no official one, and wires it into the config.",
    "commands.configure.desc":
      "Edits the config without opening it by hand: quality gate, critical areas, legacy paths.",
    "commands.render.desc": "Rebuilds every configured engine. Preview by default; --apply writes.",
    "commands.sync.desc":
      "Refreshes only the managed blocks. With --interactive you resolve conflicts block by block.",
    "commands.update.desc": "Detects that the bundle moved and tells you what would change first.",
    "commands.migrations.desc": "Applies config migrations between CLI versions.",
    "commands.backup.desc": "The safety net: every write leaves a restorable snapshot first.",
    "commands.doctor.desc":
      "Drift, broken plugins, invariants, conflicting foreign harness, and next steps.",
    "commands.status.desc": "At-a-glance snapshot: config, plugins, drift, and what to do next.",
    "commands.scan.desc": "Walks a monorepo and assigns a preset to each workspace.",
    "commands.registry.desc": "Which presets, plugins and engines this version ships.",
    "commands.bench.desc": "Times render over N runs and reports p50/p95.",
    "commands.audit.desc":
      "How the harness actually ran: tokens per agent, and doctrine nobody followed.",
    "commands.global.desc":
      "The per-machine base harness in ~/.claude, for sessions outside a navori repo.",
    "commands.workspace.desc": "Cross-repo config, and rendering the standard to every org repo.",
    "commands.dominio.desc": "The workspace knowledge base: the facts that span repos.",
    "commands.ticket.desc": "Tickets as versionable files inside the workspace.",

    "engines.eyebrow": "Multi-engine",
    "engines.title": "One config, five engines.",
    "engines.subtitle":
      "The same harness materialized in each one's native format, over a single render pipeline. Adding the sixth costs a declarative table, not a rewrite.",
    "engines.claude.detail": "agents · skills · hooks · settings.json with permissions",
    "engines.codex.detail": "custom agents · skills · hooks · MCP servers",
    "engines.agentsmd.detail": "universal spec · read by Cursor, Codex, Gemini and Copilot",
    "engines.cursor.detail": ".mdc rules · project context",
    "engines.copilot.detail": "workspace instructions",
    "engines.status": "available",

    "quickstart.eyebrow": "Quickstart",
    "quickstart.title": "From zero to productive in three steps",
    "quickstart.step1.title": "Install",
    "quickstart.step1.body": "No global install needed. Use npx.",
    "quickstart.step2.title": "Initialize",
    "quickstart.step2.body":
      "Answer a few prompts and get navori.config.json plus the rendered harness.",
    "quickstart.step3.title": "Render whenever you change something",
    "quickstart.step3.body": "Edit the config, run render --apply, commit. Fully idempotent.",

    "faq.eyebrow": "FAQ",
    "faq.title": "What you're probably wondering",
    "faq.q1": "What if I already have a hand-rolled .claude/?",
    "faq.a1":
      "navori coexists. init detects your existing harness and only adds managed blocks marked with delimiters; your custom content stays put. If you want navori to take over one of your files, 'navori adopt' wraps it without changing a word of what it says. And if your setup already ships its own orchestration or SDD, blocks.exclude lets navori opt out of rendering those blocks so it never competes with yours.",
    "faq.q2": "Which engines does it support today?",
    "faq.a2":
      "Five, all shipped: Claude Code (.claude/), native Codex (agents, skills, hooks and MCP), universal AGENTS.md, Cursor (.cursor/rules/) and Copilot. They run on one render pipeline, so a fix reaches all of them at once instead of diverging in silence.",
    "faq.q3": "Do I need Claude Code to use navori?",
    "faq.a3":
      "No. navori is a scaffolder: it generates the harness and gets out of the way. The tool runs on any Node 20+ and renders to five different engines.",
    "faq.q4": "How invasive is it? Can I roll it back?",
    "faq.a4":
      "render previews by default: without --apply it never touches disk. When it does write, it leaves a restorable snapshot first via 'navori backup', and the write is atomic. Outside the repo nothing exists that you didn't ask for by name: no 'global init', no global layer; no '--start', no audit.",
    "faq.q5": "How do I upgrade my project when a new version ships?",
    "faq.a5":
      "npx navori@latest sync. It refreshes only managed blocks without touching your code; with --interactive you resolve block by block whatever you edited by hand. 'navori update' tells you what would change first.",
    "faq.q6": "Isn't running a multi-agent harness expensive?",
    "faq.a6":
      "Less than you'd think — and you no longer have to take that on faith: 'navori audit' tells you where a real session's tokens went. Each agent runs with its own model and effort — the muscle only where judgment lives, mechanical work on a light model — and every subagent returns its conclusion instead of a dump of what it read.",

    "footer.tagline": "Open source, MIT. Built by developers who juggle many repos.",
    "footer.links": "Links",
    "footer.legal": "License",
  },
} as const;

export type UIKey = keyof (typeof ui)[typeof defaultLang];
