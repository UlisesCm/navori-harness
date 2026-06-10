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

    "hero.eyebrow": "open source · multi-engine",
    "hero.headlineA": "El harness multi-agente",
    "hero.headlineB": "para cualquier repo.",
    "hero.subhead":
      "Instala SDD, skills y hooks en segundos. Una sola config, todos los engines: Claude Code, Cursor, Copilot, AGENTS.md.",
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
    "how.layer2.body": "Configuraciones por tipo de stack (Next.js, NestJS, monorepo).",
    "how.layer3.name": "Workspace",
    "how.layer3.body": "Reglas de toda tu organización compartidas entre repos.",
    "how.layer4.name": "Project",
    "how.layer4.body": "Lo específico del repo en navori.config.json.",
    "how.layer5.name": "Adapters",
    "how.layer5.body": "Renderizado por engine: Claude, Cursor, Copilot, AGENTS.md.",
    "how.config.label": "navori.config.json",

    "commands.eyebrow": "Comandos",
    "commands.title": "Cinco comandos. Todo el ciclo.",
    "commands.init.desc":
      "Detecta el stack, hace preguntas claves y deja el repo listo en un minuto.",
    "commands.add.desc":
      "Agrega plugins (engram, semgrep, jscpd, acli, gh, cognitive) con resolución de dependencias.",
    "commands.render.desc":
      "Reconstruye .claude/, .cursor/, AGENTS.md y demás desde el config.",
    "commands.sync.desc":
      "Actualiza solo los bloques managed. Tu código personalizado nunca se sobrescribe.",
    "commands.doctor.desc":
      "Diagnóstico: detecta drift, plugins rotos y conflictos entre engines.",

    "engines.eyebrow": "Multi-engine",
    "engines.title": "Una config. Todos los engines.",
    "engines.subtitle":
      "navori-ai renderiza la misma fuente de verdad al formato nativo de cada engine.",

    "quickstart.eyebrow": "Quickstart",
    "quickstart.title": "De cero a productivo en tres pasos",
    "quickstart.step1.title": "Instala",
    "quickstart.step1.body": "Sin instalación global. Usa npx.",
    "quickstart.step2.title": "Inicializa",
    "quickstart.step2.body":
      "Responde 4 preguntas y obtén navori.config.json + .claude/ listos.",
    "quickstart.step3.title": "Renderiza cuando cambies algo",
    "quickstart.step3.body":
      "Edita el config, corre render y commitea. Todo idempotente.",

    "faq.eyebrow": "Preguntas frecuentes",
    "faq.title": "Lo que probablemente te estás preguntando",
    "faq.q1": "¿Y si ya tengo un .claude/ que armé a mano?",
    "faq.a1":
      "navori coexiste. El comando init detecta tu harness existente y solo agrega bloques managed con marcadores. Tu código personalizado queda intacto.",
    "faq.q2": "¿Cuándo sale soporte para Cursor y Copilot?",
    "faq.a2":
      "El core ya es engine-agnostic. v0.1 renderiza .claude/. v0.2 agrega adapters para Cursor, Copilot y AGENTS.md.",
    "faq.q3": "¿Por qué un monorepo y no un solo paquete?",
    "faq.a3":
      "@navori/core es engine-agnostic y publicable como librería. @navori/cli es el binario. Los plugins viven en @navori/plugin-*. Mantiene límites claros.",
    "faq.q4": "¿Necesito Claude Code para usar navori-ai?",
    "faq.a4":
      "No. navori-ai es un scaffolder. Genera config para Claude Code (entre otros), pero la herramienta corre en cualquier Node 20+.",
    "faq.q5": "¿Cómo actualizo mi proyecto cuando sale una versión nueva?",
    "faq.a5":
      "npx navori-ai@latest sync. Actualiza solo los bloques managed sin tocar tu código.",

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

    "hero.eyebrow": "open source · multi-engine",
    "hero.headlineA": "The multi-agent harness",
    "hero.headlineB": "for any repo.",
    "hero.subhead":
      "Drop-in SDD, skills, and hooks in seconds. One config, every engine: Claude Code, Cursor, Copilot, AGENTS.md.",
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
    "how.layer2.body": "Stack-specific defaults (Next.js, NestJS, monorepo).",
    "how.layer3.name": "Workspace",
    "how.layer3.body": "Org-wide rules shared across repos.",
    "how.layer4.name": "Project",
    "how.layer4.body": "What's unique to this repo in navori.config.json.",
    "how.layer5.name": "Adapters",
    "how.layer5.body":
      "Per-engine rendering: Claude, Cursor, Copilot, AGENTS.md.",
    "how.config.label": "navori.config.json",

    "commands.eyebrow": "Commands",
    "commands.title": "Five commands. Whole lifecycle.",
    "commands.init.desc":
      "Detects the stack, asks a few targeted questions, and leaves the repo ready in a minute.",
    "commands.add.desc":
      "Adds plugins (engram, semgrep, jscpd, acli, gh, cognitive) with dependency resolution.",
    "commands.render.desc":
      "Rebuilds .claude/, .cursor/, AGENTS.md and friends from the config.",
    "commands.sync.desc":
      "Updates only managed blocks. Your custom code is never overwritten.",
    "commands.doctor.desc":
      "Diagnostics: drift, broken plugins, cross-engine conflicts.",

    "engines.eyebrow": "Multi-engine",
    "engines.title": "One config. Every engine.",
    "engines.subtitle":
      "navori-ai renders the same source of truth into each engine's native format.",

    "quickstart.eyebrow": "Quickstart",
    "quickstart.title": "From zero to productive in three steps",
    "quickstart.step1.title": "Install",
    "quickstart.step1.body": "No global install needed. Use npx.",
    "quickstart.step2.title": "Initialize",
    "quickstart.step2.body":
      "Answer 4 prompts and get navori.config.json + .claude/ ready.",
    "quickstart.step3.title": "Render whenever you change something",
    "quickstart.step3.body":
      "Edit the config, run render, commit. Fully idempotent.",

    "faq.eyebrow": "FAQ",
    "faq.title": "What you're probably wondering",
    "faq.q1": "What if I already have a hand-rolled .claude/?",
    "faq.a1":
      "navori coexists. init detects your existing harness and only adds managed blocks marked with delimiters. Your custom code stays put.",
    "faq.q2": "When do Cursor and Copilot ship?",
    "faq.a2":
      "The core is already engine-agnostic. v0.1 renders .claude/. v0.2 adds adapters for Cursor, Copilot, and AGENTS.md.",
    "faq.q3": "Why a monorepo and not a single package?",
    "faq.a3":
      "@navori/core is engine-agnostic and publishable as a library. @navori/cli is the binary. Plugins live in @navori/plugin-*. Clean boundaries.",
    "faq.q4": "Do I need Claude Code to use navori-ai?",
    "faq.a4":
      "No. navori-ai is a scaffolder. It generates config for Claude Code (and others), but the tool runs on any Node 20+.",
    "faq.q5": "How do I upgrade my project when a new version ships?",
    "faq.a5":
      "npx navori-ai@latest sync. It refreshes only managed blocks without touching your code.",

    "footer.tagline":
      "Open source, MIT. Built by developers who juggle many repos.",
    "footer.links": "Links",
    "footer.legal": "License",
  },
} as const;

export type UIKey = keyof (typeof ui)[typeof defaultLang];
