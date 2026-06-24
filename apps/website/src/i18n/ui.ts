export const languages = {
  es: "Español",
  en: "English",
} as const;

export const defaultLang = "es" as const;

export type Lang = keyof typeof languages;

export const ui = {
  es: {
    "site.tagline":
      "El harness multi-agente para cualquier repo",
    "nav.docs": "Docs",
    "nav.quickstart": "Quickstart",
    "nav.github": "GitHub",
    "nav.npm": "npm",
    "lang.switchTo": "English",

    "hero.eyebrow": "open source · Claude Code",
    "hero.headlineA": "El harness multi-agente",
    "hero.headlineB": "para cualquier repo.",
    "hero.subhead":
      "Harness multi-agente + SDD en segundos: skills, hooks y agents desde una sola config. Hoy para Claude Code; multi-engine (Cursor, Copilot, AGENTS.md) en el roadmap.",
    "hero.cta.primary": "Empezar",
    "hero.cta.secondary": "Ver en GitHub",
    "hero.install.label": "Instalación",

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

    "how.eyebrow": "Cómo funciona",
    "how.title": "5 capas en cascada, una sola fuente de verdad",
    "how.subtitle":
      "Cada capa se compone sobre la anterior. Tú decides cuánto control quieres a nivel proyecto.",
    "how.layer1.name": "Core",
    "how.layer1.body": "Assets gestionados por navori. Siempre presentes.",
    "how.layer2.name": "Preset",
    "how.layer2.body":
      "Configuraciones por tipo de stack (Next.js, NestJS, monorepo). ¿Falta el tuyo? Creas uno local con `navori preset init`.",
    "how.layer3.name": "Workspace",
    "how.layer3.body": "Reglas de toda tu organización compartidas entre repos.",
    "how.layer4.name": "Project",
    "how.layer4.body": "Lo específico del repo en navori.config.json, incluidos los plugins que habilitás.",
    "how.layer5.name": "Adapters",
    "how.layer5.body": "Renderizado por engine. Hoy Claude Code; multi-engine en el roadmap.",
    "how.config.label": "navori.config.json",

    "flow.eyebrow": "En vivo",
    "flow.title": "Mirá qué aporta cada capa",
    "flow.subtitle":
      "Hacé click en una capa para resaltar qué parte del harness genera. El engine (Claude) materializa todo en .claude/ + CLAUDE.md.",
    "flow.all": "Todas",
    "flow.engineLabel": "Claude engine →",
    "flow.hint": "Seleccioná una capa para ver su aporte.",
    "flow.core.note": "Baseline: agents, skills y los bloques de reglas siempre presentes.",
    "flow.preset.note": "Skills específicas del stack — acá, Next.js.",
    "flow.workspace.note": "Defaults heredados de tu org: quality gate, branch base.",
    "flow.project.note": "Lo del repo: los plugins que habilitás (engram) y su protocolo.",

    "commands.eyebrow": "Comandos",
    "commands.title": "El ciclo completo, comando a comando.",
    "commands.init.desc":
      "Detecta el stack, hace unas preguntas y deja el repo listo en un minuto.",
    "commands.add.desc":
      "Registra plugins (engram, semgrep, jscpd, acli, gh, cognitive) o sugiere según tu stack.",
    "commands.render.desc":
      "Reconstruye CLAUDE.md y .claude/ desde el config. Preview por default; --apply escribe.",
    "commands.sync.desc":
      "Actualiza solo los bloques managed. Con --interactive resolvés cada conflicto por bloque.",
    "commands.doctor.desc":
      "Audit: drift, plugins rotos, invariants y próximos pasos sugeridos.",
    "commands.status.desc":
      "Snapshot al vuelo: config, plugins, drift y qué hacer ahora.",
    "commands.bench.desc":
      "Mide render sobre N corridas y reporta p50/p95. Detecta regresiones locales.",
    "commands.preset.desc":
      "Crea un preset local en .navori/presets/ cuando tu stack no tiene uno oficial; lo deja conectado al config.",

    "engines.eyebrow": "Multi-engine",
    "engines.title": "Una config, lista para multi-engine.",
    "engines.subtitle":
      "Hoy navori renderiza Claude Code (.claude/). El core es engine-agnostic por diseño: Cursor, Copilot y AGENTS.md están en el roadmap.",

    "quickstart.eyebrow": "Quickstart",
    "quickstart.title": "De cero a productivo en tres pasos",
    "quickstart.step1.title": "Instala",
    "quickstart.step1.body": "Sin instalación global. Usa npx.",
    "quickstart.step2.title": "Inicializa",
    "quickstart.step2.body":
      "Responde unas preguntas y obtené navori.config.json + .claude/ listos.",
    "quickstart.step3.title": "Renderiza cuando cambies algo",
    "quickstart.step3.body":
      "Edita el config, corré 'render --apply' y commitea. Todo idempotente.",

    "faq.eyebrow": "Preguntas frecuentes",
    "faq.title": "Lo que probablemente te estás preguntando",
    "faq.q1": "¿Y si ya tengo un .claude/ que armé a mano?",
    "faq.a1":
      "navori coexiste. El comando init detecta tu harness existente y solo agrega bloques managed con marcadores. Tu código personalizado queda intacto.",
    "faq.q2": "¿Cuándo sale soporte para Cursor y Copilot?",
    "faq.a2":
      "El core ya es engine-agnostic por diseño. Hoy navori renderiza .claude/ (Claude Code). Los adapters para Cursor, Copilot y AGENTS.md están en el roadmap, sin fecha comprometida.",
    "faq.q3": "¿Por qué un monorepo y no un solo paquete?",
    "faq.a3":
      "@navori/core es engine-agnostic y publicable como librería. @navori/cli es el binario. Los plugins viven en @navori/plugin-*. Mantiene límites claros.",
    "faq.q4": "¿Necesito Claude Code para usar navori?",
    "faq.a4":
      "No. navori es un scaffolder. Genera el harness para Claude Code, pero la herramienta corre en cualquier Node 20+.",
    "faq.q5": "¿Cómo actualizo mi proyecto cuando sale una versión nueva?",
    "faq.a5":
      "npx navori@latest sync. Actualiza solo los bloques managed sin tocar tu código.",

    "footer.tagline":
      "Open source, MIT. Hecho por developers que trabajan con muchos repos.",
    "footer.links": "Enlaces",
    "footer.legal": "Licencia",
  },
  en: {
    "site.tagline": "The multi-agent harness for any repo",
    "nav.docs": "Docs",
    "nav.quickstart": "Quickstart",
    "nav.github": "GitHub",
    "nav.npm": "npm",
    "lang.switchTo": "Español",

    "hero.eyebrow": "open source · Claude Code",
    "hero.headlineA": "The multi-agent harness",
    "hero.headlineB": "for any repo.",
    "hero.subhead":
      "Multi-agent harness + SDD in seconds: skills, hooks and agents from one config. Claude Code today; multi-engine (Cursor, Copilot, AGENTS.md) on the roadmap.",
    "hero.cta.primary": "Get started",
    "hero.cta.secondary": "View on GitHub",
    "hero.install.label": "Install",

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

    "how.eyebrow": "How it works",
    "how.title": "Five cascading layers, one source of truth",
    "how.subtitle":
      "Each layer composes on top of the previous one. You choose how much control you want at project level.",
    "how.layer1.name": "Core",
    "how.layer1.body": "Assets owned by navori. Always present.",
    "how.layer2.name": "Preset",
    "how.layer2.body":
      "Stack-specific defaults (Next.js, NestJS, monorepo). Missing yours? Scaffold a local one with `navori preset init`.",
    "how.layer3.name": "Workspace",
    "how.layer3.body": "Org-wide rules shared across repos.",
    "how.layer4.name": "Project",
    "how.layer4.body": "What's unique to this repo in navori.config.json, including the plugins you enable.",
    "how.layer5.name": "Adapters",
    "how.layer5.body":
      "Per-engine rendering. Claude Code today; multi-engine on the roadmap.",
    "how.config.label": "navori.config.json",

    "flow.eyebrow": "Live",
    "flow.title": "See what each layer contributes",
    "flow.subtitle":
      "Click a layer to highlight the part of the harness it generates. The engine (Claude) materializes everything into .claude/ + CLAUDE.md.",
    "flow.all": "All",
    "flow.engineLabel": "Claude engine →",
    "flow.hint": "Pick a layer to see what it adds.",
    "flow.core.note": "Baseline: agents, skills and the rule blocks that are always present.",
    "flow.preset.note": "Stack-specific skills — here, Next.js.",
    "flow.workspace.note": "Defaults inherited from your org: quality gate, branch base.",
    "flow.project.note": "Repo-level: the plugins you enable (engram) and its protocol.",

    "commands.eyebrow": "Commands",
    "commands.title": "The whole lifecycle, command by command.",
    "commands.init.desc":
      "Detects the stack, asks a few questions, and leaves the repo ready in a minute.",
    "commands.add.desc":
      "Registers plugins (engram, semgrep, jscpd, acli, gh, cognitive) or suggests based on your stack.",
    "commands.render.desc":
      "Rebuilds CLAUDE.md and .claude/ from the config. Preview by default; --apply writes.",
    "commands.sync.desc":
      "Updates only managed blocks. With --interactive you resolve each conflict block by block.",
    "commands.doctor.desc":
      "Audit: drift, broken plugins, invariants and suggested next steps.",
    "commands.status.desc":
      "At-a-glance snapshot: config, plugins, drift, and what to do next.",
    "commands.bench.desc":
      "Times render over N runs and reports p50/p95. Spots local regressions.",
    "commands.preset.desc":
      "Scaffolds a local preset under .navori/presets/ when your stack has no official one; wires it into the config.",

    "engines.eyebrow": "Multi-engine",
    "engines.title": "One config, ready for multi-engine.",
    "engines.subtitle":
      "Today navori renders Claude Code (.claude/). The core is engine-agnostic by design: Cursor, Copilot and AGENTS.md are on the roadmap.",

    "quickstart.eyebrow": "Quickstart",
    "quickstart.title": "From zero to productive in three steps",
    "quickstart.step1.title": "Install",
    "quickstart.step1.body": "No global install needed. Use npx.",
    "quickstart.step2.title": "Initialize",
    "quickstart.step2.body":
      "Answer a few prompts and get navori.config.json + .claude/ ready.",
    "quickstart.step3.title": "Render whenever you change something",
    "quickstart.step3.body":
      "Edit the config, run render --apply, commit. Fully idempotent.",

    "faq.eyebrow": "FAQ",
    "faq.title": "What you're probably wondering",
    "faq.q1": "What if I already have a hand-rolled .claude/?",
    "faq.a1":
      "navori coexists. init detects your existing harness and only adds managed blocks marked with delimiters. Your custom code stays put.",
    "faq.q2": "When do Cursor and Copilot ship?",
    "faq.a2":
      "The core is engine-agnostic by design. Today navori renders .claude/ (Claude Code). Adapters for Cursor, Copilot and AGENTS.md are on the roadmap, with no committed date.",
    "faq.q3": "Why a monorepo and not a single package?",
    "faq.a3":
      "@navori/core is engine-agnostic and publishable as a library. @navori/cli is the binary. Plugins live in @navori/plugin-*. Clean boundaries.",
    "faq.q4": "Do I need Claude Code to use navori?",
    "faq.a4":
      "No. navori is a scaffolder. It generates the harness for Claude Code, but the tool runs on any Node 20+.",
    "faq.q5": "How do I upgrade my project when a new version ships?",
    "faq.a5":
      "npx navori@latest sync. It refreshes only managed blocks without touching your code.",

    "footer.tagline":
      "Open source, MIT. Built by developers who juggle many repos.",
    "footer.links": "Links",
    "footer.legal": "License",
  },
} as const;

export type UIKey = keyof (typeof ui)[typeof defaultLang];
