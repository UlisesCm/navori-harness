/**
 * Curated release notes for the landing's "What's new" block and the full
 * /versiones (es) and /en/releases (en) pages.
 *
 * One entry per minor, newest first, written for people who use navori — what
 * they gain, not commit subjects. `landing-inventory.test.ts` fails when the
 * CLI's current minor has no entry here, so writing it is part of releasing.
 */

export interface LocalizedText {
  es: string;
  en: string;
}

export interface ReleasePatch {
  /** Full version, e.g. "0.10.1". */
  version: string;
  /** ISO date (YYYY-MM-DD) of the patch's tag. */
  date: string;
  note: LocalizedText;
}

export interface ReleaseEntry {
  /** Minor key, e.g. "0.10". Compared numerically, never as a string. */
  minor: string;
  /** ISO date (YYYY-MM-DD) of the minor's first tag (vX.Y.0). */
  date: string;
  headline: LocalizedText;
  /** 3–5 user-facing bullets. */
  bullets: readonly [LocalizedText, LocalizedText, LocalizedText, ...LocalizedText[]];
  patches?: readonly ReleasePatch[];
}

export const RELEASES: readonly ReleaseEntry[] = [
  {
    minor: "0.11",
    date: "2026-09-29",
    headline: {
      es: "Estado del harness por checkout y un master plan guiado",
      en: "Per-checkout harness state and a guided master plan",
    },
    bullets: [
      {
        es: "El estado efímero del harness vive por checkout y sin atarse a un engine, en .navori/state/handoffs/. plan gate, plan check y receipt check buscan ahí los workplans y recibos, con el .claude/progress/ anterior como lectura de respaldo. Es una migración que conviene notar.",
        en: "Ephemeral harness state now lives per checkout and engine-neutral under .navori/state/handoffs/. plan gate, plan check and receipt check look there for workplans and receipts, with the old .claude/progress/ as a read fallback. It is a migration worth noticing.",
      },
      {
        es: "Codex avanza hacia la paridad operativa, aunque todavía parcial: permisos por defecto, salida de hooks validada, permisos de revisión cruzada y un plan-gate que aconseja en Codex.",
        en: "Codex moves toward operational parity, though still partial: default permissions, validated hook output, cross-review permissions and an advisory plan-gate on Codex.",
      },
      {
        es: "Nueva skill master-plan: guía un plan maestro por etapas para trabajo grande, con una spec propia.",
        en: "New master-plan skill: it guides a staged master plan for large work, backed by its own spec.",
      },
      {
        es: "Nuevas skills de librerías: amqplib para RabbitMQ, los patrones de Mantine en cualquier repo con @mantine/core, y fastapi y pytest para repos Python, con detección de dependencias de desarrollo de Python.",
        en: "New library skills: amqplib for RabbitMQ, Mantine patterns for any repo with @mantine/core, and fastapi and pytest for Python repos, with Python dev-dependency detection.",
      },
      {
        es: "Los gates de pre-commit, semgrep y jscpd ya no corren el gate del repo ancla sobre commits que caen en otro repositorio, e init infiere el workspace cuando uno ya registra el repo. Además, jscpd bloquea solo clones nuevos y hay arreglos en check-links, recibos, activación de tailwind-v4, variables extra de plugins y la convivencia en init.",
        en: "The pre-commit, semgrep and jscpd gates no longer run the anchor repo's gate on commits that land in another repository, and init infers the workspace when one already registers the repo. Also, jscpd blocks only new clones, with fixes to check-links, receipts, tailwind-v4 activation, plugin extra variables and init coexistence.",
      },
    ],
    patches: [
      {
        version: "0.11.1",
        date: "2026-10-02",
        note: {
          es: "Claude first: el harness deja de emitir lo que Claude Code ya trae de forma nativa, navori audit mide rangos y compara instantáneas, y llegan un guard de ruteo de búsqueda, confirmación cuando un gate no puede dar veredicto, soporte para Pi y un aviso diario de versión nueva.",
          en: "Claude first: the harness stops emitting what Claude Code already ships natively, navori audit measures ranges and compares snapshots, and there is a search-routing guard, confirmation when a gate cannot reach a verdict, Pi support and a daily new-version notice.",
        },
      },
    ],
  },
  {
    minor: "0.10",
    date: "2026-09-23",
    headline: {
      es: "Planificación por niveles y un harness más difícil de romper",
      en: "Tiered planning and a harder-to-break harness",
    },
    bullets: [
      {
        es: "Los cambios se planifican por niveles: un clasificador decide cuánta planeación necesita cada tarea antes de despachar trabajo.",
        en: "Work is planned in tiers: a classifier decides how much planning each task needs before any work is dispatched.",
      },
      {
        es: "El agente scribe puede quedarse con todo el Markdown del repo, para que los demás agentes no lo toquen.",
        en: "The scribe agent can own all of the repo's Markdown, so other agents leave it alone.",
      },
      {
        es: "Se elimina toda atribución de IA en commits, PRs y código, y la regla aplica también a los comentarios.",
        en: "All AI attribution is removed from commits, PRs and code, and the rule now covers comments too.",
      },
      {
        es: "doctor verifica que el binario coincida con la versión fijada en el manifest y que el cableado MCP sea coherente.",
        en: "doctor checks that the binary matches the version pinned in the manifest and that MCP wiring is coherent.",
      },
      {
        es: "Nuevas skills: Supabase, escribir skills propias, back-offices, y utilidades para rebase y limpieza de worktrees.",
        en: "New skills: Supabase, authoring your own skills, back-office patterns, and helpers for rebases and worktree cleanup.",
      },
    ],
    patches: [
      {
        version: "0.10.1",
        date: "2026-09-24",
        note: {
          es: "Nueve skills nuevas de librerías, un guard que también bloquea rutas absolutas a archivos managed, y avisos de binarios de plugins faltantes al iniciar.",
          en: "Nine new library skills, a guard that also blocks absolute paths to managed files, and warnings about missing plugin binaries on init.",
        },
      },
    ],
  },
  {
    minor: "0.9",
    date: "2026-09-21",
    headline: {
      es: "Más agentes y cierres más confiables",
      en: "More agents and more dependable closes",
    },
    bullets: [
      {
        es: "Nuevos agentes: scribe (escribe la documentación) y architect (diseña la solución antes de implementar).",
        en: "New agents: scribe (writes documentation) and architect (designs the solution before implementation).",
      },
      {
        es: "Un advisor sugiere el modelo principal que conviene a tu sesión.",
        en: "An advisor suggests which main model fits your session.",
      },
      {
        es: "El gate detecta enlaces muertos en la documentación y pone techo de palabras a CLAUDE.md y a los bloques managed.",
        en: "The gate catches dead links in documentation and caps the word count of CLAUDE.md and managed blocks.",
      },
      {
        es: "Nuevas skills secure-by-design y quality-attributes, y el recibo de revisión ahora se firma y verifica con un comando.",
        en: "New secure-by-design and quality-attributes skills, and the review receipt is now signed and checked with one command.",
      },
      {
        es: "Un quality gate que muere por timeout ya no se reporta como verde.",
        en: "A quality gate killed by a timeout is no longer reported as green.",
      },
    ],
  },
  {
    minor: "0.8",
    date: "2026-09-09",
    headline: {
      es: "Búsqueda indexada con tgrep",
      en: "Indexed search with tgrep",
    },
    bullets: [
      {
        es: "Nuevo plugin tgrep: búsqueda de texto indexada, con su doctrina de uso ya integrada al harness.",
        en: "New tgrep plugin: indexed text search, with its usage doctrine built into the harness.",
      },
      {
        es: "codegraph arranca cargado desde el inicio de la sesión en vez de diferido.",
        en: "codegraph now starts loaded with the session instead of deferred.",
      },
      {
        es: "navori audit --arm activa el modo audit en la sesión que ya está corriendo, sin depender del modelo.",
        en: "navori audit --arm turns on audit mode in the session already running, without relying on the model.",
      },
      {
        es: "Las métricas de audit miden mejor: la versión que corrió, el costo real de los hooks y los round-trips por tramo.",
        en: "Audit metrics measure better: the version that ran, the real cost of hooks and round-trips per stretch.",
      },
      {
        es: "El cierre de un ciclo deja el repo en la base sincronizada.",
        en: "Closing a cycle leaves the repo parked on the synced base.",
      },
    ],
  },
  {
    minor: "0.7",
    date: "2026-09-02",
    headline: {
      es: "Más modos de permiso, harness ajenos y capa global",
      en: "More permission modes, foreign harnesses and the global layer",
    },
    bullets: [
      {
        es: "navori audit atribuye mejor: los hooks ya no se cargan a agentes que no los ejecutaron y muestra un histograma por modo de permiso.",
        en: "navori audit attributes more accurately: hooks are no longer charged to agents that didn't run them, and it shows a histogram per permission mode.",
      },
      {
        es: "El harness reconoce los seis modos de permiso de Claude Code y doctor avisa cuando el tuyo no está soportado.",
        en: "The harness recognizes all six Claude Code permission modes, and doctor warns when yours isn't supported.",
      },
      {
        es: "doctor detecta harness ajenos que chocan con el tuyo y ofrece adoptarlos.",
        en: "doctor detects foreign harnesses that clash with yours and offers to adopt them.",
      },
      {
        es: "Los agentes y skills pueden vivir en el scope global de tu máquina, y global uninstall retira solo lo que navori escribió.",
        en: "Agents and skills can live in your machine's global scope, and global uninstall removes only what navori wrote.",
      },
      {
        es: "Un contexto always-on más ligero y skills al día con Keystone 8, Prisma 7 y Zod 4.",
        en: "A lighter always-on context and skills updated for Keystone 8, Prisma 7 and Zod 4.",
      },
    ],
  },
  {
    minor: "0.6",
    date: "2026-08-20",
    headline: {
      es: "Diseño de solución y ticket triage",
      en: "Solution design and ticket triage",
    },
    bullets: [
      {
        es: "Una capa de diseño de solución revisa el enfoque con un segundo análisis en contexto fresco antes de implementar.",
        en: "A solution-design layer reviews the approach with a second pass in a fresh context before implementation.",
      },
      {
        es: "Al recibir un ticket, el harness separa el problema de la solución propuesta y verifica el tamaño real del cambio.",
        en: "When a ticket arrives, the harness separates the problem from the proposed solution and verifies the real size of the change.",
      },
      {
        es: "render y doctor administran el .gitignore del harness y revisan la higiene de git.",
        en: "render and doctor manage the harness .gitignore and check git hygiene.",
      },
      {
        es: "Nuevo navori audit y modo audit por sesión, para ver qué hizo el harness en tus sesiones.",
        en: "New navori audit and per-session audit mode, to see what the harness did in your sessions.",
      },
      {
        es: "Nueva skill babysit-prs y cinco reglas más en el checklist de revisión.",
        en: "New babysit-prs skill and five more rules in the review checklist.",
      },
      {
        es: "Las skills de librerías se detectan también por archivos del proyecto, no solo por dependencias.",
        en: "Library skills are also detected from project files, not only dependencies.",
      },
    ],
    patches: [
      {
        version: "0.6.5",
        date: "2026-08-28",
        note: {
          es: "navori audit se rediseña: una ficha por agente, el harness registra su propia ejecución y la activación ya no falla en silencio.",
          en: "navori audit is redesigned: a per-agent card, the harness records its own execution, and activation no longer fails silently.",
        },
      },
    ],
  },
  {
    minor: "0.5",
    date: "2026-07-31",
    headline: {
      es: "Endurecimiento de seguridad y mejor doctor",
      en: "Security hardening and a better doctor",
    },
    bullets: [
      {
        es: "Se cierran varias vías de ataque: inyección de comandos en hooks generados, path traversal en workspaces y forja de marcadores.",
        en: "Several attack paths are closed: command injection in generated hooks, workspace path traversal and marker forgery.",
      },
      {
        es: "Nuevo harness global: una base por máquina en ~/.claude.",
        en: "New global harness: a per-machine base in ~/.claude.",
      },
      {
        es: "Nuevo dominio: una base de conocimiento del workspace que los agentes consultan.",
        en: "New domain knowledge base for the workspace that agents can consult.",
      },
      {
        es: "doctor revisa más: codegraph, drift de hooks, engines y workspaces.",
        en: "doctor checks more: codegraph, hook drift, engines and workspaces.",
      },
      {
        es: "Nuevos hooks de ciclo de vida (Stop, SubagentStop, PreCompact) y navori se hospeda a sí mismo con su propio harness.",
        en: "New lifecycle hooks (Stop, SubagentStop, PreCompact), and navori now runs on its own harness.",
      },
    ],
  },
  {
    minor: "0.4",
    date: "2026-07-29",
    headline: {
      es: "Contexto quirúrgico con codegraph",
      en: "Surgical context with codegraph",
    },
    bullets: [
      {
        es: "Nuevo plugin codegraph: los agentes obtienen contexto del código vía MCP en lugar de leer archivos completos.",
        en: "New codegraph plugin: agents get code context through MCP instead of reading whole files.",
      },
      {
        es: "Al abrir una sesión, el harness inyecta rama, commits recientes y el estado de la tarea.",
        en: "On session start the harness injects the branch, recent commits and task state.",
      },
      {
        es: "El recibo de revisión queda atado al contenido del diff, así una revisión no aplica a cambios posteriores.",
        en: "The review receipt is bound to the diff's content, so a review no longer covers later changes.",
      },
      {
        es: "Permisos preconfigurados según tu preset para reducir los avisos, y el CLAUDE.md generado es más compacto y en inglés.",
        en: "Preset-aware permissions to cut prompts, and the generated CLAUDE.md is more compact and in English.",
      },
    ],
  },
  {
    minor: "0.3",
    date: "2026-07-28",
    headline: {
      es: "Soporte completo para Codex, Cursor y Copilot",
      en: "Full support for Codex, Cursor and Copilot",
    },
    bullets: [
      {
        es: "Nuevo engine Codex con AGENTS.md, orquestación y sandbox por rol, y checks propios en doctor.",
        en: "New Codex engine with AGENTS.md, orchestration and per-role sandboxing, plus its own doctor checks.",
      },
      {
        es: "Adapters para Cursor y Copilot: el mismo harness se renderiza a cada herramienta.",
        en: "Adapters for Cursor and Copilot: the same harness renders to each tool.",
      },
      {
        es: "render --all aplica el harness a todos tus repos registrados de una vez, y init --full instala todo.",
        en: "render --all applies the harness across all your registered repos at once, and init --full installs everything.",
      },
      {
        es: "Soporte para monorepos, presets nuevos (Bun/Keystone, React Native con Expo) y el agente auditor.",
        en: "Monorepo support, new presets (Bun/Keystone, React Native with Expo) and the auditor agent.",
      },
      {
        es: "Los mensajes del CLI siguen el idioma configurado.",
        en: "CLI messages follow the configured language.",
      },
    ],
  },
  {
    minor: "0.2",
    date: "2026-06-23",
    headline: {
      es: "Los cimientos del CLI",
      en: "The CLI foundations",
    },
    bullets: [
      {
        es: "El comando init detecta tu stack y genera navori.config.json junto con el harness de agentes.",
        en: "The init command detects your stack and generates navori.config.json along with the agent harness.",
      },
      {
        es: "render y sync mantienen los bloques managed al día sin tocar lo que escribiste tú.",
        en: "render and sync keep managed blocks up to date without touching what you wrote.",
      },
      {
        es: "Presets, plugins y skills instalables con add, y doctor para diagnosticar el harness.",
        en: "Presets, plugins and skills installable with add, plus doctor to diagnose the harness.",
      },
    ],
  },
];
