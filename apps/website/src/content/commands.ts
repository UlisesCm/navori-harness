import type { Lang } from "../i18n/ui";

export interface CommandDoc {
  id: string;
  title: string;
  summary: string;
  usage: string;
  flags: { flag: string; desc: string }[];
  example: { title: string; code: string }[];
  notes?: string[];
}

const es: Record<string, CommandDoc> = {
  init: {
    id: "init",
    title: "init",
    summary:
      "Inicializa un repo con navori. Detecta el stack, hace unas preguntas y deja todo listo en un minuto.",
    usage: "navori init [--full] [--recommended] [--yes] [--scan-monorepo] [--pre-commit-hook]",
    flags: [
      {
        flag: "--full",
        desc: "Modo máximo: --recommended + todos los plugins + pre-commit hook + scan-monorepo + project block estricto (posture/reviewRigor/testsForNewCode).",
      },
      {
        flag: "--recommended",
        desc: "Modo opinado: --yes + habilita plugins recomendados (engram, +gh si es repo GitHub).",
      },
      { flag: "--yes, -y", desc: "Acepta todo lo detectado sin preguntar (CI-friendly)." },
      { flag: "--lang <es|en>", desc: "Idioma del wizard. Default: es." },
      {
        flag: "--scan-monorepo",
        desc: "Si detecta un monorepo, escanea los workspaces y les asigna un preset.",
      },
      {
        flag: "--pre-commit-hook",
        desc: "Opt-in: scaffolda un pre-commit hook que corre 'navori doctor --strict'.",
      },
      { flag: "--no-render", desc: "Escribe el config pero no renderiza todavía." },
    ],
    example: [
      {
        title: "Interactivo",
        code: "$ npx navori init\n? Wizard › Español\n→ stack: Next.js · pnpm\n? Preset › nextjs\n✓ navori.config.json\n✓ Done — 5 created",
      },
      {
        title: "Sin prompts (CI)",
        code: "npx navori init --recommended --yes",
      },
    ],
    notes: [
      "Si ya existe un .claude/ hecho a mano, init coexiste: solo agrega los bloques con marcadores managed.",
      "navori.config.json es la fuente de verdad. Commitealo al repo.",
    ],
  },
  add: {
    id: "add",
    title: "add",
    summary: "Registra un plugin en navori.config.json, o sugiere qué agregar según tu stack.",
    usage: "navori add <plugin> | navori add --suggest",
    flags: [
      {
        flag: "<plugin>",
        desc: "Plugin a registrar: engram, codegraph, semgrep, jscpd, acli, gh.",
      },
      { flag: "--suggest", desc: "Detecta el stack y sugiere preset + plugins (no instala nada)." },
      { flag: "--yes", desc: "Sin prompts; instala la herramienta externa si hace falta." },
      { flag: "--skip-install", desc: "Registra el plugin sin instalar su herramienta externa." },
    ],
    example: [
      {
        title: "Agregar engram",
        code: "$ navori add engram\n✓ Added 'engram' to navori.config.json\nDone — run 'navori render --apply' to apply",
      },
      {
        title: "Sugerencias por stack",
        code: "$ navori add --suggest\nSugerencias:\n · Plugin engram: memoria persistente entre sesiones — 'navori add engram'",
      },
    ],
    notes: [
      "add solo modifica navori.config.json. Después corre 'navori render --apply' para aplicar.",
    ],
  },
  preset: {
    id: "preset",
    title: "preset",
    summary:
      "Scaffolda un preset local en .navori/presets/ para cuando tu stack no tiene un preset oficial.",
    usage: "navori preset init <id>",
    flags: [
      {
        flag: "<id>",
        desc: "Id del preset (kebab-case). Rechaza el id reservado 'custom' y los que no son kebab-case.",
      },
      { flag: "--cwd <dir>", desc: "Directorio del repo (default: actual)." },
    ],
    example: [
      {
        title: "Crear un preset local",
        code: "$ navori preset init express-fastify\n✓ .navori/presets/express-fastify/\n✓ navori.config.json → preset: express-fastify\n→ corre 'navori render --apply' para materializarlo",
      },
    ],
    notes: [
      "Genera el manifest <id>.json, un managed/stack.md (contexto del stack) y un skill de ejemplo en skills/.",
      "El preset queda checked-in en .navori/presets/: la resolución es local→bundled y el local gana.",
      "Es para stacks sin preset oficial; el detector te avisa cuando no encuentra uno.",
    ],
  },
  render: {
    id: "render",
    title: "render",
    summary:
      "Reconstruye todos los engines configurados desde navori.config.json. Idempotente. Preview por default.",
    usage: "navori render [--apply] [--force] [--workspace <name>]",
    flags: [
      {
        flag: "--apply",
        desc: "Escribe a disco. Sin el flag, render solo hace preview (no toca archivos).",
      },
      {
        flag: "--force",
        desc: "Regenera settings.json aunque esté corrupto o sin el marcador $navori (respalda el previo).",
      },
      { flag: "--workspace <name>", desc: "Renderiza solo un workspace por nombre (monorepo)." },
      { flag: "--dry-run", desc: "Deprecado: preview ya es el default. Alias explícito." },
    ],
    example: [
      {
        title: "Preview (default)",
        code: "$ navori render\n  + CLAUDE.md  (created)\n  + .claude/settings.json  (created)\n  + .claude/agents/  (5)\nPreview — 5 created · corre 'navori render --apply' para escribir",
      },
      {
        title: "Aplicar",
        code: "$ navori render --apply\nDone — 5 created",
      },
    ],
    notes: [
      "Preview por default: render no escribe sin --apply. Cero sorpresas en disco.",
      "Solo regenera el contenido entre marcadores managed. Lo que escribes fuera de ellos nunca se toca.",
    ],
  },
  sync: {
    id: "sync",
    title: "sync",
    summary: "Trae cambios del bundle a todos los engines configurados sin pisar tus ediciones.",
    usage: "navori sync [--interactive] [--apply] [--workspace <name>]",
    flags: [
      {
        flag: "--interactive",
        desc: "Resuelve cada conflicto de CLAUDE.md uno por uno: ves el diff y eliges keep-mine o accept-new.",
      },
      { flag: "--apply", desc: "Aplica los cambios sin el prompt interactivo." },
      { flag: "--yes", desc: "Auto-confirma. Falla con exit 1 si hay conflictos (CI gate)." },
      { flag: "--workspace <name>", desc: "Sincroniza solo un workspace (monorepo)." },
    ],
    example: [
      {
        title: "Resolución interactiva",
        code: "$ navori sync --interactive\nConflict CLAUDE.md:idioma-rol\n  - tu edición\n  + versión nueva del render\n? keep mine / accept new",
      },
    ],
    notes: [
      "Si editaste un bloque managed a mano, sync lo detecta (hash drift) y NO lo pisa: lo resuelves tú.",
      "sync es el comando para upgrades de versión; render --apply es para regenerar.",
    ],
  },
  doctor: {
    id: "doctor",
    title: "doctor",
    summary: "Audit del proyecto: config, plugins, drift, invariants y próximos pasos sugeridos.",
    usage: "navori doctor [--json] [--strict]",
    flags: [
      { flag: "--json", desc: "Output estructurado para CI (pipeable)." },
      { flag: "--strict", desc: "Exit 1 cuando hay drift (intended for CI gates)." },
    ],
    example: [
      {
        title: "Diagnóstico",
        code: "$ navori doctor\nConfig · navori.config.json\nManaged blocks · 5\n! drift: .claude/agents/leader.md editado a mano\nPróximos pasos · corre 'navori sync --interactive'",
      },
    ],
    notes: [
      "Corre doctor en CI con --strict para fallar el build si hay drift no resuelto.",
      "Valida invariants: substrings load-bearing que deben sobrevivir en el output (exit 2 si faltan).",
    ],
  },
  status: {
    id: "status",
    title: "status",
    summary:
      "Snapshot rápido: config, plugins habilitados, drift y próximos pasos. El '¿cómo quedó esto?' en un comando.",
    usage: "navori status [--json]",
    flags: [{ flag: "--json", desc: "Output estructurado (pipeable)." }],
    example: [
      {
        title: "Snapshot",
        code: "$ navori status\nname · my-app   preset · nextjs\nplugins · engram   drift · 0\nPróximos pasos · Todo al día",
      },
    ],
    notes: [
      "status es la vista al vuelo; doctor es el audit verboso. Comparten la misma lógica de health-check.",
    ],
  },
  bench: {
    id: "bench",
    title: "bench",
    summary:
      "Mide render sobre N corridas y reporta p50/p95. Para detectar regresiones locales antes de commitear.",
    usage: "navori bench [--runs <n>]",
    flags: [{ flag: "--runs <n>", desc: "Número de iteraciones. Default: 20." }],
    example: [
      {
        title: "Benchmark",
        code: "$ navori bench --runs 20\nrender (dry-run)\n  min  1.1ms\n  p50  1.3ms\n  p95  1.6ms",
      },
    ],
    notes: ["Complementa NAVORI_BENCH=1, que instrumenta los tiempos de una sola corrida."],
  },
  global: {
    id: "global",
    title: "global",
    summary:
      "Instala un harness base por máquina en ~/.claude, para las sesiones que arrancan fuera de un repo con navori. Opt-in y de huella cero: sin 'navori global init' no existe, y navori no tocó nada de tu máquina.",
    usage:
      "navori global init [--apply] [--recommended] [--lang <es|en>]\nnavori global render [--apply]\nnavori global doctor\nnavori global uninstall",
    flags: [
      {
        flag: "init",
        desc: "Wizard de la capa global: elige los bloques del baseline y tus permisos personales. Preview por default — sin --apply no escribe un solo byte, solo muestra el plugin, el hook y los settings que instalaría.",
      },
      {
        flag: "init --apply",
        desc: "Escribe lo que el preview mostró: el manifest ~/.navori/global.json y el plugin 'navori@skills-dir' en ~/.claude/skills/navori/ (8 agentes, 12 skills y el hook del baseline).",
      },
      {
        flag: "init --recommended",
        desc: "Sin preguntas: toma la selección recomendada (o la que ya tenías, si re-inicializas). Es el camino headless para CI y scripts; también es a lo que cae solo cuando no hay terminal interactiva.",
      },
      {
        flag: "init --lang <es|en>",
        desc: "Idioma del baseline global y de los prompts. Default: es, o el que ya tenía la instalación.",
      },
      {
        flag: "render",
        desc: "Re-renderiza el plugin y el hook tras un bump del CLI. Preview por default: sin --apply no toca disco.",
      },
      { flag: "render --apply", desc: "Escribe a disco (respalda settings.json si lo modifica)." },
      {
        flag: "doctor",
        desc: "Audita la capa: drift del hook, el gate ejecutado de verdad, el plugin al día, permisos y versión. Si no está instalada, lo dice y ya.",
      },
      {
        flag: "uninstall",
        desc: "Retira solo lo que navori escribió: el plugin, el manifest y los permisos que reclamó — los tuyos quedan intactos.",
      },
    ],
    example: [
      {
        title: "Ver qué instalaría (no escribe nada)",
        code: "$ navori global init --recommended\n  · plugin: ~/.claude/skills/navori (23 archivos)\n  · hook: ~/.claude/skills/navori/hooks/navori-global-baseline.sh\n  · settings: sin cambios (~/.claude/settings.json)\n  · Bloques del baseline: operaciones-seguras, idioma-rol, formato-respuesta, orquestacion\nPreview: no se escribió un solo byte. Corre 'navori global init --apply' para instalar.",
      },
      {
        title: "Instalar la capa global",
        code: "$ navori global init --apply\n  · plugin: ~/.claude/skills/navori (23 archivos)\n  · Bloques del baseline: operaciones-seguras, idioma-rol, formato-respuesta, orquestacion\n✓ Harness global instalado en ~/.claude.",
      },
      {
        title: "Auditar",
        code: "$ navori global doctor\n  ✓ hook de baseline presente y al día\n  ✓ gate funcional (emite baseline fuera de un repo navori, y nada dentro)\n  ✓ plugin 'navori@skills-dir' instalado y al día\n✓ OK",
      },
      {
        title: "Quitarla",
        code: "$ navori global uninstall\n✓ Harness global desinstalado de ~/.claude.",
      },
    ],
    notes: [
      "Opt-in de verdad: sin 'navori global init --apply' no existe ~/.navori/global.json y navori no escribió un solo byte en tu máquina. El init sin --apply tampoco escribe: es un preview.",
      "El wizard es el único camino de UI para 'permissions'. Lo que declares ahí se mergea a ~/.claude/settings.json y queda registrado como de navori, que es lo que permite al uninstall retirarlo sin tocar tus reglas.",
      "El plugin 'navori@skills-dir' lo carga Claude Code sin marketplace ni paso de instalación; sus skills se invocan '/navori:<nombre>'.",
      "El hook se hace a un lado solo: si la sesión arranca dentro de un repo con navori.config.json, no emite nada. Manda el harness del repo.",
      "De ~/.claude/settings.json solo escribe 'permissions', y con la config por default ni siquiera lo crea.",
      "Respeta CLAUDE_CONFIG_DIR: si lo tienes seteado, el plugin va ahí y no a ~/.claude.",
    ],
  },
  remove: {
    id: "remove",
    title: "remove",
    summary:
      "Desactiva un plugin y limpia lo que había dejado: bloques managed, sub-bloques inyectados y scripts.",
    usage: "navori remove <plugin> [--yes] [--cwd <dir>]",
    flags: [
      { flag: "<plugin>", desc: "Id del plugin a quitar (semgrep, jscpd, codegraph, acli, gh)." },
      { flag: "--yes", desc: "Sin confirmación." },
      { flag: "--cwd <dir>", desc: "Directorio del repo (default: actual)." },
    ],
    example: [
      {
        title: "Quitar un plugin",
        code: "$ navori remove semgrep --yes\n◆  'semgrep' quitado y limpiado.\n└  Listo",
      },
      {
        title: "engram no se puede quitar",
        code: "$ navori remove engram\n└  engram es always-on con navori; no se puede quitar.",
      },
    ],
    notes: [
      "Va en dos fases: primero marca el plugin como enabled:false y re-renderiza —eso es lo que borra sus bloques y scripts—, y solo después quita la clave del config. Borrar la clave de una sí se saltaría la limpieza.",
      "Si el render falla, el comando sale con código 1 y deja el config en enabled:false, para que el árbol a medias no pase por bueno en CI.",
    ],
  },
  configure: {
    id: "configure",
    title: "configure",
    summary:
      "Modifica secciones de navori.config.json después del init. Cada sección es un subcomando.",
    usage:
      "navori configure <plugins|quality-gate|language|branch-base|pr-target|engines|workspace|blocks> [valor]",
    flags: [
      { flag: "plugins", desc: "Habilita o deshabilita plugins de este repo (interactivo)." },
      {
        flag: "quality-gate [--fast <cmd>] [--full <cmd>]",
        desc: "Define los dos comandos del gate. Sin flags pregunta; con ellos es no interactivo.",
      },
      { flag: "language <es|en>", desc: "Idioma de los assets Core managed." },
      { flag: "branch-base <rama>", desc: "Rama base contra la que los gates sacan el diff." },
      {
        flag: "pr-target <rama>",
        desc: "Rama a la que apuntan los PRs (gh pr create --base). Por default, la de branch-base.",
      },
      {
        flag: "engines",
        desc: "Agrega o quita engines: claude, agents-md, cursor, copilot, codex.",
      },
      {
        flag: "workspace <nombre>",
        desc: "Asocia el repo a un workspace (vacío para desasociar).",
      },
      { flag: "blocks", desc: "Excluye bloques core managed (p. ej. orquestacion, sdd)." },
      {
        flag: "--cwd <dir>",
        desc: "Directorio del repo (default: actual). Aplica a todos los subcomandos.",
      },
    ],
    example: [
      {
        title: "Cambiar el idioma",
        code: "$ navori configure language en\n◆  language → en\n└  Corre 'navori render --apply' para volver a renderizar los bloques managed en el nuevo idioma.",
      },
      {
        title: "Definir el gate sin prompts",
        code: '$ navori configure quality-gate --fast "pnpm lint" --full "pnpm test && pnpm lint"\n◆  qualityGate updated\n└  Done',
      },
      {
        title: "PRs a develop, gates contra main",
        code: "$ navori configure branch-base main\n$ navori configure pr-target develop\n◆  prTarget → develop",
      },
    ],
    notes: [
      "configure solo escribe navori.config.json. El cambio se materializa con 'navori render --apply'.",
      "branchBase y prTarget son dos cosas distintas: la primera es el punto de fork contra el que se mide el diff, la segunda es a dónde apunta el PR. En la mayoría de los repos coinciden.",
    ],
  },
  update: {
    id: "update",
    title: "update",
    summary:
      "El 'ponme al día' de un solo tiro: vuelve a detectar el repo, ofrece los cambios de config y corre sync.",
    usage: "navori update [--yes] [--cwd <dir>]",
    flags: [
      { flag: "--yes", desc: "Aplica los diffs detectados y sincroniza sin preguntar." },
      { flag: "--cwd <dir>", desc: "Directorio del repo (default: actual)." },
    ],
    example: [
      {
        title: "Nada que hacer",
        code: "$ navori update\n└  Al día — nada que actualizar",
      },
      {
        title: "En CI",
        code: "navori update --yes",
      },
    ],
    notes: [
      "Detecta drift entre lo que el repo es hoy y lo que el config dice: preset sugerido, comandos del quality gate, rama base y migraciones de librería.",
      "Tu edición manda: cuando la detección discrepa de un valor que ya editaste a mano, el config gana.",
      "Después de acomodar el config corre sync, así que los bloques managed quedan al día en la misma pasada.",
    ],
  },
  scan: {
    id: "scan",
    title: "scan",
    summary:
      "Vuelve a detectar los workspaces de un monorepo y agrega al config los que aparecieron desde el init.",
    usage: "navori scan [--yes] [--cwd <dir>]",
    flags: [
      { flag: "--yes", desc: "Acepta el preset sugerido de cada workspace nuevo sin preguntar." },
      { flag: "--cwd <dir>", desc: "Directorio a escanear (default: actual)." },
    ],
    example: [
      {
        title: "Repo que no declara monorepo",
        code: "$ navori scan\n└  navori.config.json no declara 'monorepo'. Edita el config para agregar { monorepo: { enabled: true, tool: '...' } } y vuelve a correr scan.",
      },
    ],
    notes: [
      "Es incremental: solo agrega los workspaces que el config todavía no lista, y nunca toca los que ya están.",
      "Requiere que el config declare monorepo.enabled. 'navori init --scan-monorepo' es lo que lo deja listo desde el arranque.",
    ],
  },
  registry: {
    id: "registry",
    title: "registry",
    summary:
      "Registro global de todos los repos con navori de esta máquina. Es lo que hace posible 'render --all'.",
    usage: "navori registry <ls|scan|add|remove|prune> [args]",
    flags: [
      { flag: "ls", desc: "Lista cada repo registrado." },
      {
        flag: "scan <dir...> [--depth=<n>]",
        desc: "Recorre uno o más directorios y registra todos los repos navori que encuentre. Profundidad máxima: 4.",
      },
      { flag: "add <path>", desc: "Registra un repo por ruta." },
      { flag: "remove <path>", desc: "Lo saca del registro; sus archivos no se tocan." },
      { flag: "prune", desc: "Quita las entradas cuyo repo ya no existe en disco." },
    ],
    example: [
      {
        title: "Registrar todo lo que hay bajo un directorio",
        code: "$ navori registry scan ~/dev --depth=3\n│    · conocido  demo  /Users/tu/dev/demo\n└  Listo 0 agregado(s) · 1 ya registrado(s)",
      },
      {
        title: "Ver el registro",
        code: "$ navori registry ls\n│    ✓ demo\n│        /Users/tu/dev/demo\n└  1 repo(s)",
      },
      {
        title: "Limpiar lo que ya no existe",
        code: "$ navori registry prune\n└  Nada que limpiar · 1 repo(s) registrado(s)",
      },
    ],
    notes: [
      "El registro vive en ~/.navori/ y es machine-local: no se commitea ni viaja con el repo.",
      "'ls' marca con missing los repos que ya no están en disco y te sugiere el prune.",
      "'remove' es solo desregistrar: nunca borra archivos del repo.",
    ],
  },
  workspace: {
    id: "workspace",
    title: "workspace",
    summary:
      "Config y tickets compartidos entre varios repos: defaults que aplican a todos y un render de la flota completa.",
    usage: "navori workspace <init|ls|show|link|add-repo|set-default|render|rename|delete> [args]",
    flags: [
      {
        flag: "init <nombre> [--description <txt>] [--yes]",
        desc: "Crea el workspace en ~/.navori/workspaces/<nombre>.json.",
      },
      { flag: "ls [--json]", desc: "Lista los workspaces conocidos." },
      { flag: "show <nombre> [--json]", desc: "Muestra rutas, defaults y repos registrados." },
      {
        flag: "link [<nombre>] [--cwd <dir>]",
        desc: "Registra el repo actual en el workspace y lo anota en su navori.config.json. Sin nombre, usa el que declare el config.",
      },
      {
        flag: "add-repo <workspace> --name <n> --path <p> [--stack <s>] [--description <d>]",
        desc: "Registra un repo por ruta, sin estar parado en él.",
      },
      {
        flag: "set-default <workspace> <key> <value>",
        desc: "Default que aplica a todos los repos del workspace (engines: separados por coma; plugins: true|false).",
      },
      {
        flag: "render <workspace> [--apply] [--force] [--verbose]",
        desc: "Renderiza cada repo registrado. Sin --apply es preview.",
      },
      { flag: "rename <de> <a> [--yes]", desc: "Renombra conservando tickets, repos y defaults." },
      { flag: "delete <nombre> [--yes]", desc: "Lo manda a ~/.navori/.trash (recuperable)." },
    ],
    example: [
      {
        title: "Crear y enlazar",
        code: "$ navori workspace init bonum --yes\n◆  Escribí ~/.navori/workspaces/bonum/workspace.json\n\n$ navori workspace link bonum\n◆  Registré 'demo' en el workspace 'bonum'.\n◆  workspace → 'bonum' guardado en navori.config.json",
      },
      {
        title: "Inspeccionar",
        code: '$ navori workspace show bonum\n│    ticketsDir : tickets\n│    defaults   : {"engines":["claude"]}\n│    repos      : 1\n│  Repos:\n│      · demo  /Users/tu/dev/demo',
      },
      {
        title: "Render de la flota (preview)",
        code: "$ navori workspace render bonum\n│    · demo  up-to-date  45 unchanged\n└  Preview 1/1 ok · 0 would change · 0 conflict · 1 warning · 0 failed",
      },
    ],
    notes: [
      "El workspace vive en ~/.navori/workspaces/: es machine-local. Lo único que queda en el repo es la clave 'workspace' de navori.config.json.",
      "'link' es el camino corto desde adentro del repo; 'add-repo' es el mismo registro pero desde afuera y por ruta.",
      "'render' sin --apply previsualiza los repos completos, así que sirve para medir el impacto de un cambio de preset antes de aplicarlo.",
      "'delete' no borra: mueve a ~/.navori/.trash.",
    ],
  },
  ticket: {
    id: "ticket",
    title: "ticket",
    summary:
      "Tickets como archivos dentro de un workspace, para que el trabajo que cruza repos tenga un lugar común.",
    usage: "navori ticket <list|show|new|archive|unarchive|delete> <workspace> [args]",
    flags: [
      {
        flag: "list <workspace> [--archive] [--json]",
        desc: "Lista los tickets activos; --archive incluye los archivados.",
      },
      {
        flag: "show <workspace> <id> [--json]",
        desc: "Muestra el ticket y los repos que lo referencian.",
      },
      {
        flag: "new <workspace> <id> [--title <txt>]",
        desc: "Crea el ticket a partir de la plantilla.",
      },
      { flag: "archive <workspace> <id>", desc: "Lo mueve a _archive (reversible)." },
      { flag: "unarchive <workspace> <id>", desc: "Lo regresa a la carpeta activa." },
      { flag: "delete <workspace> <id> [--yes]", desc: "Lo borra definitivamente." },
    ],
    example: [
      {
        title: "Crear uno",
        code: "$ navori ticket new bonum BNM-123 --title 'Login rompe en Safari'\n◆  Escribí ~/.navori/workspaces/bonum/tickets/BNM-123.md\n└  Referéncialo desde el progress/current.md de un repo con:\n  ticket: BNM-123",
      },
      {
        title: "Listar",
        code: "$ navori ticket list bonum\n│    · BNM-123  Login rompe en Safari\n└  1 ticket",
      },
    ],
    notes: [
      "El ticket es un .md con secciones (Goal, Repos affected, Scope): está hecho para que lo lean los agentes, no solo las personas.",
      "'show' cruza el id contra el progress/current.md de cada repo del workspace, así que te dice quién lo está trabajando.",
      "El id se valida: letras, dígitos, guiones y guiones bajos, empezando con alfanumérico.",
    ],
  },
  dominio: {
    id: "dominio",
    title: "dominio",
    summary:
      "La base de conocimiento del workspace: los hechos canónicos que cruzan repos y no caben en el CLAUDE.md de ninguno.",
    usage: "navori dominio <init|list|show|reindex|doctor|inject> [--workspace <nombre>]",
    flags: [
      { flag: "init", desc: "Crea el store del Dominio del workspace." },
      { flag: "list", desc: "Lista las entradas." },
      { flag: "show <id>", desc: "Imprime una entrada." },
      { flag: "reindex", desc: "Reconstruye DOMINIO.md desde los archivos de entrada." },
      { flag: "doctor", desc: "Valida el Dominio (solo advertencias)." },
      { flag: "inject", desc: "Emite el índice para el hook SessionStart." },
      {
        flag: "--workspace <nombre>",
        desc: "Workspace sobre el que opera. Por default, el que declare el config del repo actual.",
      },
    ],
    example: [
      {
        title: "Crear el store",
        code: "$ navori dominio init --workspace bonum\n└  Dominio creado en ~/.navori/workspaces/bonum/dominio.",
      },
      {
        title: "Revisar consistencia",
        code: "$ navori dominio doctor --workspace bonum\n◇  Dominio de 'bonum' ───────╮\n│    ✓ Dominio consistente.  │\n└  OK",
      },
      {
        title: "Reconstruir el índice",
        code: "$ navori dominio reindex --workspace bonum\n└  Índice reconstruido (0 entrada(s)): ~/.navori/workspaces/bonum/dominio/DOMINIO.md",
      },
    ],
    notes: [
      "Es para hechos durables que sobreviven al repo: un modelo de datos, una regla de negocio, un contrato entre servicios, un gotcha compartido.",
      "'inject' es lo que consume el hook de SessionStart: el índice entra al contexto, las entradas se leen bajo demanda.",
      "La skill 'dominio' del harness es el camino guiado para promover un hallazgo aquí en vez de dejarlo en la memoria de la sesión.",
    ],
  },
  backup: {
    id: "backup",
    title: "backup",
    summary:
      "La red de seguridad: cada sync o render que modifica archivos deja antes un snapshot en ~/.navori/backups/.",
    usage: "navori backup <list|restore|prune> [args]",
    flags: [
      {
        flag: "list [--limit <n>] [--json]",
        desc: "Lista los snapshots. Default: los 20 más recientes.",
      },
      {
        flag: "restore <timestamp> [--cwd <dir>] [--yes]",
        desc: "Restaura los archivos de un snapshot al directorio actual. El timestamp sale de 'backup list'.",
      },
      {
        flag: "prune [--days <n>] [--yes]",
        desc: "Borra lo que pasó la retención (default 30 días) y después los más viejos hasta el tope de tamaño.",
      },
    ],
    example: [
      {
        title: "Ver qué hay guardado",
        code: "$ navori backup list\n│  1 backup(s) en total. Mostrando 1:\n│    · repo-2026-09-01T17-49-47-756  (recién)\n│        · .claude/agents/leader.md\n│        · CLAUDE.md\n└  Listo",
      },
      {
        title: "Volver atrás",
        code: "navori backup restore repo-2026-09-01T17-49-47-756 --yes",
      },
      {
        title: "Podar",
        code: "$ navori backup prune --days 30 --yes\n└  Nada que podar — los backups están dentro de la retención y del tope de tamaño",
      },
    ],
    notes: [
      "Los backups son automáticos: no hay 'backup create'. Se crean solos antes de cada escritura destructiva.",
      "Viven en ~/.navori/backups/ y son machine-local: no se commitean.",
      "El snapshot guarda solo los archivos que la operación iba a tocar, no el repo entero.",
    ],
  },
  migrations: {
    id: "migrations",
    title: "migrations",
    summary:
      "El respaldo del harness previo cuando 'init' adopta navori en modo replace. Reversible.",
    usage: "navori migrations <list|restore> [args]",
    flags: [
      {
        flag: "list [--limit <n>] [--json]",
        desc: "Lista las migraciones guardadas. Default: las 20 más recientes.",
      },
      {
        flag: "restore <timestamp> <repo> [--cwd <dir>] [--yes] [--json]",
        desc: "Devuelve el harness original al repo. Ambos valores salen de 'migrations list'.",
      },
    ],
    example: [
      {
        title: "Cuando no hay ninguna",
        code: "$ navori migrations list\n●  No hay migraciones. Se crean cuando 'init' adopta navori en modo replace (el wizard interactivo) en un repo con infraestructura Claude previa.\n└  Listo",
      },
      {
        title: "Para scripts",
        code: '$ navori migrations list --json\n{\n  "migrations": [],\n  "totalAvailable": 0\n}',
      },
    ],
    notes: [
      "Es distinto de backup: backup respalda cada escritura de navori, migrations respalda el .claude/ que existía ANTES de navori.",
      "Solo el modo replace genera una: el modo coexistir no reemplaza nada, así que no hay qué respaldar.",
      "Viven en ~/.navori/migrations/ y son machine-local.",
    ],
  },
  audit: {
    id: "audit",
    title: "audit",
    summary:
      "Cómo corrió el harness de verdad: a dónde se fueron los tokens y qué instrucciones nadie siguió.",
    usage:
      "navori audit [--session <id>] [--days <n>] [--since <fecha>] [--until <fecha>] [--json]",
    flags: [
      { flag: "--session <id>", desc: "Una sesión por id, prefijo, o 'latest'." },
      { flag: "--days <n>", desc: "Solo sesiones marcadas en los últimos N días." },
      { flag: "--since <YYYY-MM-DD>", desc: "Desde esta fecha." },
      { flag: "--until <YYYY-MM-DD>", desc: "Hasta esta fecha." },
      { flag: "--json", desc: "Imprime el reporte JSON a stdout sin escribir archivos." },
      { flag: "--out <dir>", desc: "Cambia el directorio de salida." },
      { flag: "--start <id>", desc: "Marca una sesión como auditada (lo usa el flujo del hook)." },
      { flag: "--stop <id>", desc: "Sella el log de la sesión y reporta sobre ella." },
      { flag: "--cwd <dir>", desc: "Repo a auditar (default: actual)." },
    ],
    example: [
      {
        title: "Activar audit-mode",
        code: "$ navori audit --start 8f3c1d2e\n└  audit-mode activo ~/.navori/audits/demo/session-8f3c1d2e.log",
      },
      {
        title: "Sin sesiones marcadas",
        code: "$ navori audit\n└  No hay sesiones marcadas con audit-mode para 'demo'. Actívalo con 'navori audit --start <id-de-sesión>'.",
      },
      {
        title: "Reporte de una sesión",
        code: "$ navori audit --session latest\n◇  demo · 2026-09-01 → 2026-09-01 ─╮\n│  1 sesiones · 19 agentes         │\n│  facturable  2.3M tok            │\n│  arranque  346k tok              │\n│  hallazgos  1 alto · 3 medio     │\n└  Reporte ~/.navori/audits/demo/sessions/2026-09-01-8f3c1d2e/report.md",
      },
    ],
    notes: [
      "Es opt-in y por sesión: sin un '--start' previo no hay log que auditar, y navori no observa nada.",
      "Los datos salen de dos fuentes que no se sustituyen: el log de eventos que los hooks escriben (qué hizo el harness) y el transcript de Claude Code (el único lugar donde viven los tokens).",
      "El reporte se escribe en markdown y JSON dentro de ~/.navori/audits/<repo>/, junto a una copia del log de la sesión.",
      "Los conteos de hooks son parciales cuando el recorder arrancó tarde: la ficha del orquestador lo declara con el porcentaje de la sesión que sí observó.",
    ],
  },
  adopt: {
    id: "adopt",
    title: "adopt",
    summary:
      "Toma un archivo del harness que escribiste a mano y lo pone bajo gestión de navori, sin cambiar lo que dice.",
    usage: "navori adopt <path> [--apply] [--cwd <dir>]",
    flags: [
      {
        flag: "<path>",
        desc: "Archivo .md bajo .claude/ del repo (p. ej. .claude/skills/mia.md). Rechaza cualquier otra ruta.",
      },
      { flag: "--apply", desc: "Escribe a disco. Sin el flag, adopt solo previsualiza." },
      { flag: "--cwd <dir>", desc: "Directorio del repo (default: actual)." },
    ],
    example: [
      {
        title: "Ver qué haría",
        code: "$ navori adopt .claude/skills/mia.md\n●  envolvería '.claude/skills/mia.md' en un bloque managed id=\"adopted-claude-skills-mia\", dejando su contenido intacto\n└  Preview: no se escribió nada. Vuelve a correrlo con --apply.",
      },
      {
        title: "Adoptarlo",
        code: "$ navori adopt .claude/skills/mia.md --apply\n◆  '.claude/skills/mia.md' adoptado (bloque managed id=\"adopted-claude-skills-mia\").\n└  Backup en ~/.navori/backups/repo-2026-09-01T20-04-26-926",
      },
      {
        title: "Correrlo dos veces no hace nada",
        code: "$ navori adopt .claude/skills/mia.md --apply\n└  '.claude/skills/mia.md' ya estaba adoptado — sin cambios.",
      },
    ],
    notes: [
      "Adoptar es ENVOLVER, no reescribir: tu contenido entra tal cual dentro del bloque managed. Lo que navori toma es el ciclo de vida del archivo, nunca lo que dice.",
      "Rechaza —sin escribir nada y diciendo por qué— un archivo que ya lleva bloque managed, uno fuera del repo, y cualquier ruta que no sea .md bajo .claude/.",
      "Sale de 'navori doctor': la sección de harness ajeno ofrece este comando cuando el archivo en conflicto vive en el repo. Si vive en ~/.claude, navori solo lee y la salida es asumir el conflicto.",
      "Siempre hace backup antes de escribir, y te dice dónde quedó.",
    ],
  },
};

const en: Record<string, CommandDoc> = {
  init: {
    id: "init",
    title: "init",
    summary:
      "Bootstrap a repo with navori. Detects the stack, asks a few questions, and leaves everything ready in a minute.",
    usage: "navori init [--full] [--recommended] [--yes] [--scan-monorepo] [--pre-commit-hook]",
    flags: [
      {
        flag: "--full",
        desc: "Maximal mode: --recommended + all plugins + pre-commit hook + monorepo scan + strict project block (posture/reviewRigor/testsForNewCode).",
      },
      {
        flag: "--recommended",
        desc: "Opinionated mode: --yes + auto-enable recommended plugins (engram, +gh on GitHub repos).",
      },
      { flag: "--yes, -y", desc: "Accept everything detected without prompting (CI-friendly)." },
      { flag: "--lang <es|en>", desc: "Wizard language. Default: es." },
      {
        flag: "--scan-monorepo",
        desc: "If a monorepo is detected, scan its workspaces and assign a preset to each.",
      },
      {
        flag: "--pre-commit-hook",
        desc: "Opt-in: scaffold a pre-commit hook that runs 'navori doctor --strict'.",
      },
      { flag: "--no-render", desc: "Write the config but don't render yet." },
    ],
    example: [
      {
        title: "Interactive",
        code: "$ npx navori init\n? Wizard › English\n→ stack: Next.js · pnpm\n? Preset › nextjs\n✓ navori.config.json\n✓ Done — 5 created",
      },
      {
        title: "Non-interactive (CI)",
        code: "npx navori init --recommended --yes",
      },
    ],
    notes: [
      "If a hand-rolled .claude/ already exists, init coexists: it only adds blocks wrapped with managed markers.",
      "navori.config.json is the source of truth. Commit it to your repo.",
    ],
  },
  add: {
    id: "add",
    title: "add",
    summary: "Register a plugin in navori.config.json, or suggest what to add based on your stack.",
    usage: "navori add <plugin> | navori add --suggest",
    flags: [
      {
        flag: "<plugin>",
        desc: "Plugin to register: engram, codegraph, semgrep, jscpd, acli, gh.",
      },
      {
        flag: "--suggest",
        desc: "Detect the stack and suggest a preset + plugins (installs nothing).",
      },
      { flag: "--yes", desc: "No prompts; install the external tool if needed." },
      { flag: "--skip-install", desc: "Register the plugin without installing its external tool." },
    ],
    example: [
      {
        title: "Add engram",
        code: "$ navori add engram\n✓ Added 'engram' to navori.config.json\nDone — run 'navori render --apply' to apply",
      },
      {
        title: "Stack suggestions",
        code: "$ navori add --suggest\nSuggestions:\n · Plugin engram: persistent memory across sessions — 'navori add engram'",
      },
    ],
    notes: ["add only updates navori.config.json. Then run 'navori render --apply' to apply."],
  },
  preset: {
    id: "preset",
    title: "preset",
    summary:
      "Scaffolds a local preset under .navori/presets/ for when your stack has no official preset.",
    usage: "navori preset init <id>",
    flags: [
      {
        flag: "<id>",
        desc: "Preset id (kebab-case). Rejects the reserved id 'custom' and non-kebab-case ids.",
      },
      { flag: "--cwd <dir>", desc: "Repo directory (default: current)." },
    ],
    example: [
      {
        title: "Create a local preset",
        code: "$ navori preset init express-fastify\n✓ .navori/presets/express-fastify/\n✓ navori.config.json → preset: express-fastify\n→ run 'navori render --apply' to materialize it",
      },
    ],
    notes: [
      "Generates the <id>.json manifest, a managed/stack.md (stack context) and an example skill under skills/.",
      "The preset is checked in under .navori/presets/: resolution is local→bundled, and local wins.",
      "It's for stacks with no official preset; the detector warns you when it can't find one.",
    ],
  },
  render: {
    id: "render",
    title: "render",
    summary:
      "Rebuilds every configured engine from navori.config.json. Idempotent. Preview by default.",
    usage: "navori render [--apply] [--force] [--workspace <name>]",
    flags: [
      {
        flag: "--apply",
        desc: "Write to disk. Without it, render only previews (no files touched).",
      },
      {
        flag: "--force",
        desc: "Regenerate settings.json even if corrupted or missing the $navori marker (backs up the previous one).",
      },
      { flag: "--workspace <name>", desc: "Render only one workspace by name (monorepo)." },
      { flag: "--dry-run", desc: "Deprecated: preview is the default now. Explicit alias." },
    ],
    example: [
      {
        title: "Preview (default)",
        code: "$ navori render\n  + CLAUDE.md  (created)\n  + .claude/settings.json  (created)\n  + .claude/agents/  (5)\nPreview — 5 created · run 'navori render --apply' to write",
      },
      {
        title: "Apply",
        code: "$ navori render --apply\nDone — 5 created",
      },
    ],
    notes: [
      "Preview by default: render writes nothing without --apply. Zero surprises on disk.",
      "Only regenerates content between managed markers. Anything you write outside them is never touched.",
    ],
  },
  sync: {
    id: "sync",
    title: "sync",
    summary: "Pulls bundle changes into every configured engine without overwriting your edits.",
    usage: "navori sync [--interactive] [--apply] [--workspace <name>]",
    flags: [
      {
        flag: "--interactive",
        desc: "Resolve each CLAUDE.md conflict one by one: see the diff and pick keep-mine or accept-new.",
      },
      { flag: "--apply", desc: "Apply changes without the interactive prompt." },
      { flag: "--yes", desc: "Auto-confirm. Exits 1 if there are conflicts (CI gate)." },
      { flag: "--workspace <name>", desc: "Sync only one workspace (monorepo)." },
    ],
    example: [
      {
        title: "Interactive resolution",
        code: "$ navori sync --interactive\nConflict CLAUDE.md:idioma-rol\n  - your edit\n  + new rendered version\n? keep mine / accept new",
      },
    ],
    notes: [
      "If you hand-edited a managed block, sync detects it (hash drift) and won't overwrite — you resolve it.",
      "sync is for version upgrades; render --apply is for regenerating.",
    ],
  },
  doctor: {
    id: "doctor",
    title: "doctor",
    summary: "Project audit: config, plugins, drift, invariants and suggested next steps.",
    usage: "navori doctor [--json] [--strict]",
    flags: [
      { flag: "--json", desc: "Structured output for CI (pipeable)." },
      { flag: "--strict", desc: "Exit 1 when drift is detected (intended for CI gates)." },
    ],
    example: [
      {
        title: "Diagnose",
        code: "$ navori doctor\nConfig · navori.config.json\nManaged blocks · 5\n! drift: .claude/agents/leader.md edited by hand\nNext steps · run 'navori sync --interactive'",
      },
    ],
    notes: [
      "Run doctor in CI with --strict to fail the build on unresolved drift.",
      "Validates invariants: load-bearing substrings that must survive in the output (exit 2 if missing).",
    ],
  },
  status: {
    id: "status",
    title: "status",
    summary:
      "Quick snapshot: config, enabled plugins, drift, and next steps. The 'where did this land?' in one command.",
    usage: "navori status [--json]",
    flags: [{ flag: "--json", desc: "Structured output (pipeable)." }],
    example: [
      {
        title: "Snapshot",
        code: "$ navori status\nname · my-app   preset · nextjs\nplugins · engram   drift · 0\nNext steps · All clear",
      },
    ],
    notes: [
      "status is the at-a-glance view; doctor is the verbose audit. They share the same health-check logic.",
    ],
  },
  bench: {
    id: "bench",
    title: "bench",
    summary:
      "Times render over N runs and reports p50/p95. Spots local regressions before you commit.",
    usage: "navori bench [--runs <n>]",
    flags: [{ flag: "--runs <n>", desc: "Number of iterations. Default: 20." }],
    example: [
      {
        title: "Benchmark",
        code: "$ navori bench --runs 20\nrender (dry-run)\n  min  1.1ms\n  p50  1.3ms\n  p95  1.6ms",
      },
    ],
    notes: ["Complements NAVORI_BENCH=1, which instruments the timings of a single run."],
  },
  global: {
    id: "global",
    title: "global",
    summary:
      "Installs a machine-wide harness baseline into ~/.claude, for sessions that start outside a navori repo. Opt-in and zero-footprint: without 'navori global init' it doesn't exist, and navori touched nothing on your machine.",
    usage:
      "navori global init [--apply] [--recommended] [--lang <es|en>]\nnavori global render [--apply]\nnavori global doctor\nnavori global uninstall",
    flags: [
      {
        flag: "init",
        desc: "Global-layer wizard: pick the baseline blocks and your personal permissions. Preview by default — without --apply it writes not a single byte, it only shows the plugin, the hook and the settings it would install.",
      },
      {
        flag: "init --apply",
        desc: "Writes what the preview showed: the ~/.navori/global.json manifest and the 'navori@skills-dir' plugin under ~/.claude/skills/navori/ (8 agents, 12 skills and the baseline hook).",
      },
      {
        flag: "init --recommended",
        desc: "No questions: takes the recommended selection (or the one you already had, on a re-init). It is the headless path for CI and scripts, and also what it falls back to with no interactive terminal.",
      },
      {
        flag: "init --lang <es|en>",
        desc: "Language of the global baseline and of the prompts. Default: es, or whatever the existing install already had.",
      },
      {
        flag: "render",
        desc: "Re-renders the plugin and the hook after a CLI bump. Preview by default: without --apply nothing is written.",
      },
      { flag: "render --apply", desc: "Write to disk (backs up settings.json if it changes it)." },
      {
        flag: "doctor",
        desc: "Audits the layer: hook drift, the gate actually executed, plugin up to date, permissions and version. If it isn't installed, it says so and stops.",
      },
      {
        flag: "uninstall",
        desc: "Removes only what navori wrote: the plugin, the manifest and the permissions it claimed — yours are left intact.",
      },
    ],
    example: [
      {
        title: "See what it would install (writes nothing)",
        code: "$ navori global init --recommended\n  · plugin: ~/.claude/skills/navori (23 files)\n  · hook: ~/.claude/skills/navori/hooks/navori-global-baseline.sh\n  · settings: unchanged (~/.claude/settings.json)\n  · Baseline blocks: operaciones-seguras, idioma-rol, formato-respuesta, orquestacion\nPreview: not a single byte was written. Run 'navori global init --apply' to install.",
      },
      {
        title: "Install the global layer",
        code: "$ navori global init --apply\n  · plugin: ~/.claude/skills/navori (23 files)\n  · Baseline blocks: operaciones-seguras, idioma-rol, formato-respuesta, orquestacion\n✓ Global harness installed at ~/.claude.",
      },
      {
        title: "Audit",
        code: "$ navori global doctor\n  ✓ baseline hook present and up to date\n  ✓ gate works (emits the baseline outside a navori repo, nothing inside one)\n  ✓ plugin 'navori@skills-dir' installed and up to date\n✓ OK",
      },
      {
        title: "Remove it",
        code: "$ navori global uninstall\n✓ Global harness uninstalled from ~/.claude.",
      },
    ],
    notes: [
      "Opt-in for real: without 'navori global init --apply' there is no ~/.navori/global.json, and navori wrote not a single byte on your machine. An init without --apply writes nothing either: it is a preview.",
      "The wizard is the only UI path to 'permissions'. What you declare there is merged into ~/.claude/settings.json and recorded as navori's, which is what lets uninstall retract it without touching your own rules.",
      "Claude Code loads the 'navori@skills-dir' plugin with no marketplace and no install step; its skills are invoked as '/navori:<name>'.",
      "The hook steps aside on its own: if the session starts inside a repo with navori.config.json it emits nothing. The repo's harness wins.",
      "In ~/.claude/settings.json it only writes 'permissions', and with the default config it doesn't even create the file.",
      "Honors CLAUDE_CONFIG_DIR: if you have it set, the plugin goes there instead of ~/.claude.",
    ],
  },
  remove: {
    id: "remove",
    title: "remove",
    summary:
      "Disable a plugin and clean up what it left behind: managed blocks, injected sub-blocks and scripts.",
    usage: "navori remove <plugin> [--yes] [--cwd <dir>]",
    flags: [
      { flag: "<plugin>", desc: "Plugin id to remove (semgrep, jscpd, codegraph, acli, gh)." },
      { flag: "--yes", desc: "Skip confirmation." },
      { flag: "--cwd <dir>", desc: "Repo directory (default: current)." },
    ],
    example: [
      {
        title: "Remove a plugin",
        code: "$ navori remove semgrep --yes\n◆  'semgrep' removed and cleaned up.\n└  Done",
      },
      {
        title: "engram cannot be removed",
        code: "$ navori remove engram\n└  engram is always-on with navori; it can't be removed.",
      },
    ],
    notes: [
      "Two phases: it first marks the plugin as enabled:false and re-renders — that is what deletes its blocks and scripts — and only then drops the key from the config. Deleting the key in one go would skip the cleanup.",
      "If the render fails the command exits 1 and leaves the config at enabled:false, so a half-written tree never passes for good in CI.",
    ],
  },
  configure: {
    id: "configure",
    title: "configure",
    summary: "Modify sections of navori.config.json after init. Each section is a subcommand.",
    usage:
      "navori configure <plugins|quality-gate|language|branch-base|pr-target|engines|workspace|blocks> [value]",
    flags: [
      { flag: "plugins", desc: "Enable or disable this repo's plugins (interactive)." },
      {
        flag: "quality-gate [--fast <cmd>] [--full <cmd>]",
        desc: "Set the gate's two commands. Without flags it prompts; with them it is non-interactive.",
      },
      { flag: "language <es|en>", desc: "Language of the managed Core assets." },
      { flag: "branch-base <branch>", desc: "Base branch the gates diff against." },
      {
        flag: "pr-target <branch>",
        desc: "Branch PRs target (gh pr create --base). Defaults to branch-base.",
      },
      {
        flag: "engines",
        desc: "Add or remove engines: claude, agents-md, cursor, copilot, codex.",
      },
      { flag: "workspace <name>", desc: "Associate the repo with a workspace (empty to detach)." },
      { flag: "blocks", desc: "Opt out of core managed blocks (e.g. orquestacion, sdd)." },
      {
        flag: "--cwd <dir>",
        desc: "Repo directory (default: current). Applies to every subcommand.",
      },
    ],
    example: [
      {
        title: "Switch the language",
        code: "$ navori configure language en\n◆  language → en\n└  Run 'navori render --apply' to re-render managed blocks in the new language.",
      },
      {
        title: "Set the gate without prompts",
        code: '$ navori configure quality-gate --fast "pnpm lint" --full "pnpm test && pnpm lint"\n◆  qualityGate updated\n└  Done',
      },
      {
        title: "PRs to develop, gates against main",
        code: "$ navori configure branch-base main\n$ navori configure pr-target develop\n◆  prTarget → develop",
      },
    ],
    notes: [
      "configure only writes navori.config.json. Run 'navori render --apply' to materialize the change.",
      "branchBase and prTarget are two different things: the first is the fork point every diff is measured against, the second is where the PR points. In most repos they name the same branch.",
    ],
  },
  update: {
    id: "update",
    title: "update",
    summary:
      "The one-shot 'bring me up to date': re-detects the repo, offers the config diffs, and runs sync.",
    usage: "navori update [--yes] [--cwd <dir>]",
    flags: [
      { flag: "--yes", desc: "Apply the detected diffs and sync without prompting." },
      { flag: "--cwd <dir>", desc: "Repo directory (default: current)." },
    ],
    example: [
      {
        title: "Nothing to do",
        code: "$ navori update\n└  Up to date — nothing to update",
      },
      {
        title: "In CI",
        code: "navori update --yes",
      },
    ],
    notes: [
      "It detects drift between what the repo is today and what the config says: suggested preset, quality-gate commands, base branch and library migrations.",
      "Your edit wins: when detection disagrees with a value you already set by hand, the config keeps it.",
      "After settling the config it runs sync, so the managed blocks come up to date in the same pass.",
    ],
  },
  scan: {
    id: "scan",
    title: "scan",
    summary:
      "Re-detect a monorepo's workspaces and add to the config the ones that appeared since init.",
    usage: "navori scan [--yes] [--cwd <dir>]",
    flags: [
      {
        flag: "--yes",
        desc: "Accept the suggested preset for every new workspace without prompting.",
      },
      { flag: "--cwd <dir>", desc: "Directory to scan (default: current)." },
    ],
    example: [
      {
        title: "A repo that declares no monorepo",
        code: "$ navori scan\n└  navori.config.json does not declare 'monorepo'. Add { monorepo: { enabled: true, tool: '...' } } to the config and run scan again.",
      },
    ],
    notes: [
      "It is incremental: it only adds workspaces the config does not list yet, and never touches the ones already there.",
      "It needs monorepo.enabled in the config. 'navori init --scan-monorepo' is what sets that up from the start.",
    ],
  },
  registry: {
    id: "registry",
    title: "registry",
    summary:
      "Global registry of every navori repo on this machine. It is what makes 'render --all' possible.",
    usage: "navori registry <ls|scan|add|remove|prune> [args]",
    flags: [
      { flag: "ls", desc: "List every registered repo." },
      {
        flag: "scan <dir...> [--depth=<n>]",
        desc: "Walk one or more directories and register every navori repo found. Max depth: 4.",
      },
      { flag: "add <path>", desc: "Register a repo by path." },
      { flag: "remove <path>", desc: "Unregister it; its files are left untouched." },
      { flag: "prune", desc: "Drop entries whose repo no longer exists on disk." },
    ],
    example: [
      {
        title: "Register everything under a directory",
        code: "$ navori registry scan ~/dev --depth=3\n│    · known  demo  /Users/you/dev/demo\n└  Done 0 added · 1 already registered",
      },
      {
        title: "See the registry",
        code: "$ navori registry ls\n│    ✓ demo\n│        /Users/you/dev/demo\n└  1 repo(s)",
      },
      {
        title: "Clean up what is gone",
        code: "$ navori registry prune\n└  Nothing to prune · 1 repo(s) registered",
      },
    ],
    notes: [
      "The registry lives in ~/.navori/ and is machine-local: it is never committed and never travels with the repo.",
      "'ls' tags repos that are no longer on disk as missing and points you at the prune.",
      "'remove' only unregisters: it never deletes files from the repo.",
    ],
  },
  workspace: {
    id: "workspace",
    title: "workspace",
    summary:
      "Config and tickets shared across repos: defaults that apply to all of them, and one render for the whole fleet.",
    usage: "navori workspace <init|ls|show|link|add-repo|set-default|render|rename|delete> [args]",
    flags: [
      {
        flag: "init <name> [--description <txt>] [--yes]",
        desc: "Create the workspace at ~/.navori/workspaces/<name>.json.",
      },
      { flag: "ls [--json]", desc: "List the known workspaces." },
      { flag: "show <name> [--json]", desc: "Show paths, defaults and registered repos." },
      {
        flag: "link [<name>] [--cwd <dir>]",
        desc: "Register the current repo in the workspace and record it in its navori.config.json. With no name it uses the one the config declares.",
      },
      {
        flag: "add-repo <workspace> --name <n> --path <p> [--stack <s>] [--description <d>]",
        desc: "Register a repo by path, without standing in it.",
      },
      {
        flag: "set-default <workspace> <key> <value>",
        desc: "A default applied to every repo in the workspace (engines: comma-separated; plugins: true|false).",
      },
      {
        flag: "render <workspace> [--apply] [--force] [--verbose]",
        desc: "Render every registered repo. Without --apply it is a preview.",
      },
      {
        flag: "rename <from> <to> [--yes]",
        desc: "Rename, preserving tickets, repos and defaults.",
      },
      { flag: "delete <name> [--yes]", desc: "Move it to ~/.navori/.trash (recoverable)." },
    ],
    example: [
      {
        title: "Create and link",
        code: "$ navori workspace init bonum --yes\n◆  Wrote ~/.navori/workspaces/bonum/workspace.json\n\n$ navori workspace link bonum\n◆  Registered 'demo' in workspace 'bonum'.\n◆  workspace → 'bonum' saved in navori.config.json",
      },
      {
        title: "Inspect it",
        code: '$ navori workspace show bonum\n│    ticketsDir : tickets\n│    defaults   : {"engines":["claude"]}\n│    repos      : 1\n│  Repos:\n│      · demo  /Users/you/dev/demo',
      },
      {
        title: "Fleet render (preview)",
        code: "$ navori workspace render bonum\n│    · demo  up-to-date  45 unchanged\n└  Preview 1/1 ok · 0 would change · 0 conflict · 1 warning · 0 failed",
      },
    ],
    notes: [
      "The workspace lives in ~/.navori/workspaces/: it is machine-local. All that stays in the repo is the 'workspace' key in navori.config.json.",
      "'link' is the short path from inside the repo; 'add-repo' is the same registration from outside, by path.",
      "'render' without --apply previews whole repos, so it measures the blast radius of a preset change before you apply it.",
      "'delete' does not delete: it moves to ~/.navori/.trash.",
    ],
  },
  ticket: {
    id: "ticket",
    title: "ticket",
    summary:
      "Tickets as files inside a workspace, so work that crosses repos has one place to live.",
    usage: "navori ticket <list|show|new|archive|unarchive|delete> <workspace> [args]",
    flags: [
      {
        flag: "list <workspace> [--archive] [--json]",
        desc: "List active tickets; --archive includes archived ones.",
      },
      {
        flag: "show <workspace> <id> [--json]",
        desc: "Show the ticket and which repos reference it.",
      },
      {
        flag: "new <workspace> <id> [--title <txt>]",
        desc: "Create the ticket from the template.",
      },
      { flag: "archive <workspace> <id>", desc: "Move it to _archive (reversible)." },
      { flag: "unarchive <workspace> <id>", desc: "Move it back to the active folder." },
      { flag: "delete <workspace> <id> [--yes]", desc: "Delete it permanently." },
    ],
    example: [
      {
        title: "Create one",
        code: "$ navori ticket new bonum BNM-123 --title 'Login breaks on Safari'\n◆  Wrote ~/.navori/workspaces/bonum/tickets/BNM-123.md\n└  Reference it from a repo's progress/current.md with:\n  ticket: BNM-123",
      },
      {
        title: "List them",
        code: "$ navori ticket list bonum\n│    · BNM-123  Login breaks on Safari\n└  1 ticket",
      },
    ],
    notes: [
      "The ticket is a .md with sections (Goal, Repos affected, Scope): it is built to be read by agents, not only by people.",
      "'show' cross-references the id against every repo's progress/current.md in the workspace, so it tells you who is working on it.",
      "The id is validated: letters, digits, hyphens and underscores, starting alphanumeric.",
    ],
  },
  dominio: {
    id: "dominio",
    title: "dominio",
    summary:
      "The workspace's knowledge base: the canonical facts that span repos and fit in no single CLAUDE.md.",
    usage: "navori dominio <init|list|show|reindex|doctor|inject> [--workspace <name>]",
    flags: [
      { flag: "init", desc: "Create the workspace's Dominio store." },
      { flag: "list", desc: "List the entries." },
      { flag: "show <id>", desc: "Print one entry." },
      { flag: "reindex", desc: "Rebuild DOMINIO.md from the entry files." },
      { flag: "doctor", desc: "Validate the Dominio (warnings only)." },
      { flag: "inject", desc: "Emit the index for the SessionStart hook." },
      {
        flag: "--workspace <name>",
        desc: "Workspace to operate on. Defaults to the one the current repo's config declares.",
      },
    ],
    example: [
      {
        title: "Create the store",
        code: "$ navori dominio init --workspace bonum\n└  Dominio created at ~/.navori/workspaces/bonum/dominio.",
      },
      {
        title: "Check consistency",
        code: "$ navori dominio doctor --workspace bonum\n◇  Dominio for 'bonum' ────────╮\n│    ✓ Dominio is consistent.  │\n└  OK",
      },
      {
        title: "Rebuild the index",
        code: "$ navori dominio reindex --workspace bonum\n└  Index rebuilt (0 entries): ~/.navori/workspaces/bonum/dominio/DOMINIO.md",
      },
    ],
    notes: [
      "It is for durable facts that outlive the repo: a data model, a business rule, a cross-service contract, a shared gotcha.",
      "'inject' is what the SessionStart hook consumes: the index enters the context, the entries are read on demand.",
      "The harness's 'dominio' skill is the guided path for promoting a finding here instead of leaving it in session memory.",
    ],
  },
  backup: {
    id: "backup",
    title: "backup",
    summary:
      "The safety net: every sync or render that modifies files leaves a snapshot in ~/.navori/backups/ first.",
    usage: "navori backup <list|restore|prune> [args]",
    flags: [
      {
        flag: "list [--limit <n>] [--json]",
        desc: "List the snapshots. Default: the 20 most recent.",
      },
      {
        flag: "restore <timestamp> [--cwd <dir>] [--yes]",
        desc: "Restore a snapshot's files into the current directory. The timestamp comes from 'backup list'.",
      },
      {
        flag: "prune [--days <n>] [--yes]",
        desc: "Delete what is past retention (default 30 days), then oldest-first down to the size cap.",
      },
    ],
    example: [
      {
        title: "See what is stored",
        code: "$ navori backup list\n│  1 backup(s) total. Showing 1:\n│    · repo-2026-09-01T17-49-47-756  (just now)\n│        · .claude/agents/leader.md\n│        · CLAUDE.md\n└  Done",
      },
      {
        title: "Roll back",
        code: "navori backup restore repo-2026-09-01T17-49-47-756 --yes",
      },
      {
        title: "Prune",
        code: "$ navori backup prune --days 30 --yes\n└  Nothing to prune — backups are within retention and under the size cap",
      },
    ],
    notes: [
      "Backups are automatic: there is no 'backup create'. They are written before every destructive write.",
      "They live in ~/.navori/backups/ and are machine-local: never committed.",
      "A snapshot holds only the files the operation was about to touch, not the whole repo.",
    ],
  },
  migrations: {
    id: "migrations",
    title: "migrations",
    summary:
      "The backup of your previous harness when 'init' adopts navori in replace mode. Reversible.",
    usage: "navori migrations <list|restore> [args]",
    flags: [
      {
        flag: "list [--limit <n>] [--json]",
        desc: "List the stored migrations. Default: the 20 most recent.",
      },
      {
        flag: "restore <timestamp> <repo> [--cwd <dir>] [--yes] [--json]",
        desc: "Put the original harness back in the repo. Both values come from 'migrations list'.",
      },
    ],
    example: [
      {
        title: "When there is none",
        code: "$ navori migrations list\n●  No migrations found. They are created when 'init' adopts navori in replace mode (the interactive wizard) on a repo with existing Claude infrastructure.\n└  Done",
      },
      {
        title: "For scripts",
        code: '$ navori migrations list --json\n{\n  "migrations": [],\n  "totalAvailable": 0\n}',
      },
    ],
    notes: [
      "Different from backup: backup covers every navori write, migrations covers the .claude/ that existed BEFORE navori.",
      "Only replace mode produces one: coexist mode replaces nothing, so there is nothing to back up.",
      "They live in ~/.navori/migrations/ and are machine-local.",
    ],
  },
  audit: {
    id: "audit",
    title: "audit",
    summary:
      "How the harness actually ran: where the tokens went, and which instructions nobody could follow.",
    usage: "navori audit [--session <id>] [--days <n>] [--since <date>] [--until <date>] [--json]",
    flags: [
      { flag: "--session <id>", desc: "One session by id, prefix, or 'latest'." },
      { flag: "--days <n>", desc: "Only sessions marked in the last N days." },
      { flag: "--since <YYYY-MM-DD>", desc: "From this date." },
      { flag: "--until <YYYY-MM-DD>", desc: "Up to this date." },
      { flag: "--json", desc: "Print the JSON report to stdout without writing files." },
      { flag: "--out <dir>", desc: "Override the output directory." },
      { flag: "--start <id>", desc: "Mark a session as audited (used by the hook flow)." },
      { flag: "--stop <id>", desc: "Seal the session's log and report on it." },
      { flag: "--cwd <dir>", desc: "Repo to audit (default: current)." },
    ],
    example: [
      {
        title: "Turn audit-mode on",
        code: "$ navori audit --start 8f3c1d2e\n└  audit-mode active ~/.navori/audits/demo/session-8f3c1d2e.log",
      },
      {
        title: "No marked sessions",
        code: "$ navori audit\n└  No sessions marked with audit-mode for 'demo'. Activate it with 'navori audit --start <session-id>'.",
      },
      {
        title: "One session's report",
        code: "$ navori audit --session latest\n◇  demo · 2026-09-01 → 2026-09-01 ─╮\n│  1 sessions · 19 agents          │\n│  billable  2.3M tok              │\n│  startup  346k tok               │\n│  findings  1 high · 3 warn       │\n└  Report ~/.navori/audits/demo/sessions/2026-09-01-8f3c1d2e/report.md",
      },
    ],
    notes: [
      "Opt-in and per session: with no prior '--start' there is no log to audit, and navori observes nothing.",
      "Two sources feed it and neither replaces the other: the event log the hooks write (what the harness did) and Claude Code's transcript (the only place token usage exists).",
      "The report is written as markdown and JSON under ~/.navori/audits/<repo>/, beside a copy of the session's log.",
      "Hook counts are partial when the recorder started late: the orchestrator's card says so, with the share of the session it did observe.",
    ],
  },
  adopt: {
    id: "adopt",
    title: "adopt",
    summary:
      "Take a harness file you wrote by hand under navori's management, without changing what it says.",
    usage: "navori adopt <path> [--apply] [--cwd <dir>]",
    flags: [
      {
        flag: "<path>",
        desc: "A .md file under the repo's .claude/ (e.g. .claude/skills/mine.md). Any other path is refused.",
      },
      { flag: "--apply", desc: "Write to disk. Without it, adopt only previews." },
      { flag: "--cwd <dir>", desc: "Repo directory (default: current)." },
    ],
    example: [
      {
        title: "See what it would do",
        code: "$ navori adopt .claude/skills/mine.md\n●  would wrap '.claude/skills/mine.md' in a managed block id=\"adopted-claude-skills-mine\", leaving its content untouched\n└  Preview: nothing was written. Run it again with --apply.",
      },
      {
        title: "Adopt it",
        code: "$ navori adopt .claude/skills/mine.md --apply\n◆  '.claude/skills/mine.md' adopted (managed block id=\"adopted-claude-skills-mine\").\n└  Backup at ~/.navori/backups/repo-2026-09-01T20-04-26-926",
      },
      {
        title: "Running it twice does nothing",
        code: "$ navori adopt .claude/skills/mine.md --apply\n└  '.claude/skills/mine.md' was already adopted — no changes.",
      },
    ],
    notes: [
      "Adopting is WRAPPING, not rewriting: your content goes inside the managed block unchanged. What navori takes over is the file's lifecycle, never what it says.",
      "It refuses — without writing anything, and saying why — a file that already carries a managed block, one outside the repo, and any path that is not a .md under .claude/.",
      "It comes from 'navori doctor': the foreign-harness section offers this command when the clashing file lives in the repo. When it lives in ~/.claude, navori only reads, and the way out is to acknowledge the conflict.",
      "It always backs up before writing, and tells you where the backup landed.",
    ],
  },
};

export const commandDocs: Record<Lang, Record<string, CommandDoc>> = { es, en };

export const commandOrder = [
  "init",
  "add",
  "remove",
  "adopt",
  "configure",
  "preset",
  "render",
  "sync",
  "update",
  "scan",
  "doctor",
  "status",
  "bench",
  "audit",
  "backup",
  "migrations",
  "registry",
  "workspace",
  "ticket",
  "dominio",
  "global",
] as const;
