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
        desc: "--recommended + proveedores externos por defecto (tgrep, semgrep, jscpd, acli; codegraph opt-in) + pre-commit hook + scan-monorepo + project block estricto (posture/reviewRigor/testsForNewCode). Requiere instalar los binarios de esos proveedores.",
      },
      {
        flag: "--recommended",
        desc: "Modo opinado: --yes + harness completo sin instalar software externo (+gh si es repo GitHub; engram ya viene activo siempre).",
      },
      { flag: "--yes", desc: "Acepta todo lo detectado sin preguntar (CI-friendly)." },
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
      "En cualquier modo (--yes, --recommended, --full o interactivo), init avisa si el binario de un plugin habilitado no está en el PATH y cómo instalarlo; nunca lo instala por ti.",
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
        desc: "Plugin a registrar: engram, codegraph, tgrep, semgrep, jscpd, acli, gh.",
      },
      { flag: "--suggest", desc: "Detecta el stack y sugiere preset + plugins (no instala nada)." },
      { flag: "--yes", desc: "Sin prompts; instala la herramienta externa si hace falta." },
      { flag: "--skip-install", desc: "Registra el plugin sin instalar su herramienta externa." },
    ],
    example: [
      {
        title: "Agregar engram",
        code: "$ navori add engram\n✓ Added 'engram' to navori.config.json\n✓ Rendered CLAUDE.md — 2 created, 1 updated\nDone",
      },
      {
        title: "Sugerencias por stack",
        code: "$ navori add --suggest\nSugerencias:\n · Plugin engram: memoria persistente entre sesiones — 'navori add engram'\n · Proveedor externo disponible: 'codegraph' — 'navori add codegraph'",
      },
    ],
    notes: [
      "add actualiza navori.config.json y renderiza el cableado del plugin (.mcp.json, permisos, bloques managed) en el mismo paso.",
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
    usage:
      "navori render [--apply] [--force] [--workspace <name>] [--json] [--all [--prune] [--verbose]]",
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
      {
        flag: "--json",
        desc: "Resultado machine-readable; suprime la salida humana (CI/automatización).",
      },
      {
        flag: "--all",
        desc: "Renderiza TODOS los repos del registro global (~/.navori/registry.json), no solo el actual. Úsalo tras subir de versión navori para propagar los cambios a todos tus proyectos.",
      },
      {
        flag: "--prune",
        desc: "Con --all: quita del registro las entradas cuyo repo ya no existe antes de renderizar. En un solo repo (con --apply): borra, con backup previo, las salidas de engines que ya no están en config.engines.",
      },
      {
        flag: "--verbose",
        desc: "Con --all: lista cada bloque managed que cambió por repo, no solo los conteos.",
      },
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
      "También escribe '.claude/.gitignore' (y '.codex/.gitignore' si codex está habilitado) con un bloque managed versionado que ignora el estado efímero del harness (progress/, worktrees/, settings.local.json) en cualquier modo de gitignoreHarness; no ignora nada que el engine necesite.",
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
        desc: "Resuelve cada conflicto uno por uno: ves el diff y eliges keep-mine o accept-new, sea un bloque de CLAUDE.md, un archivo completo con marcador o un archivo sin marcadores (se reemplaza completo, con backup).",
      },
      { flag: "--apply", desc: "Aplica los cambios sin el prompt interactivo." },
      { flag: "--yes", desc: "Auto-confirma. Falla con exit 1 si hay conflictos (CI gate)." },
      {
        flag: "--accept-new",
        desc: "Resuelve, sin preguntar, todos los conflictos de bloques de CLAUDE.md con la versión nueva del render. Destructivo: requiere --apply o --yes y respalda CLAUDE.md antes. Tu zona de usuario nunca se toca.",
      },
      {
        flag: "--keep-mine",
        desc: "Resuelve, sin preguntar, todos los conflictos de bloques de CLAUDE.md conservando tu edición y aplicando el resto de los cambios. Requiere --apply o --yes.",
      },
      { flag: "--dry-run", desc: "Muestra el plan sin escribir." },
      { flag: "--json", desc: "Salida machine-readable para CI; suprime la salida humana." },
      {
        flag: "--accept-new-files",
        desc: "Sobrescribe, sin preguntar, cada archivo completo editado a mano que conserva su marcador navori. Requiere --apply o --yes y respalda cada archivo antes. --accept-new no toca archivos completos.",
      },
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
      "Un archivo completo editado a mano (agente, skill, hook, script de plugin, AGENTS.md…) que conserva su marcador navori se resuelve con --interactive (diff + keep/accept) o en bloque con --accept-new-files. Un archivo sin ningún marcador navori (script de plugin legacy o archivo tuyo en una ruta de plugin) solo se reemplaza completo con --interactive: avisa que no es una edición de navori, muestra el diff, por defecto conserva el tuyo y, si aceptas, guarda un backup (se conserva 30 días; recupéralo con navori backup restore). Ningún flag masivo ni --json lo toca. Si solo conserva parte del marcador o lo menciona en un comentario, la salida es manual: muévelo aparte y corre render --apply.",
      "Con --json, cada conflicto trae 'resolvable' ('bulk' o 'none') y la salida trae 'acceptNewFiles'; nunca incluye el contenido de los archivos y refleja el estado posterior a la resolución.",
      "sync es el comando para upgrades de versión; render --apply es para regenerar.",
      "Mantiene el '.claude/.gitignore' del harness (y '.codex/.gitignore' con codex habilitado) al día igual que cualquier otro bloque managed.",
    ],
  },
  doctor: {
    id: "doctor",
    title: "doctor",
    summary: "Audit del proyecto: config, plugins, drift, invariants y próximos pasos sugeridos.",
    usage: "navori doctor [--json] [--strict]",
    flags: [
      { flag: "--json", desc: "Output estructurado para CI (pipeable)." },
      {
        flag: "--strict",
        desc: "Exit 1 cuando hay drift o .mcp.json incoherente con el manifest de un plugin (intended for CI gates).",
      },
    ],
    example: [
      {
        title: "Diagnóstico",
        code: "$ navori doctor\nConfig · navori.config.json\nManaged blocks · 5\n! drift: .claude/agents/orchestrator.md editado a mano\nPróximos pasos · corre 'navori sync --interactive'",
      },
    ],
    notes: [
      "Corre doctor en CI con --strict para fallar el build si hay drift no resuelto.",
      "Valida invariants: substrings load-bearing que deben sobrevivir en el output (exit 2 si faltan).",
      "El estado de confianza de Codex se lee de $CODEX_HOME/config.toml si CODEX_HOME está definido, y de ~/.codex/config.toml si no; un valor relativo se rechaza.",
      "Con el engine codex habilitado, también revisa cada git worktree del repo que tenga .codex/config.toml: advierte con el hook, la ruta y 'cd <ruta> && navori codex trust' si falta aprobarlo. Advierte además si el codex instalado es más nuevo que la última versión verificada. Si git o el disco fallan, degrada a un aviso.",
      "Si algún hook renderizado llama a 'navori', advierte cuando el 'navori' global del PATH es más viejo que el CLI que corre doctor (ejecutaría lógica vieja); nunca cambia ok.",
      "Avisa, solo como dato informativo, cuando hay una versión estable más nueva de una herramienta externa con latestRelease en su manifest (hoy, engram), y advierte cuando la versión instalada está por debajo de un piso conocido como defectuoso (hoy, engram < 3.0.0). Ninguno de los dos cambia el veredicto ni --strict.",
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
  codex: {
    id: "codex",
    title: "codex",
    summary:
      "Aprueba los hooks de Codex del proyecto en ~/.codex/config.toml. Codex no carga nada del repo (ni siquiera AGENTS.md) hasta que el proyecto es de confianza.",
    usage: "navori codex trust [--yes] [--cwd <dir>]",
    flags: [
      { flag: "--yes", desc: "Aprueba sin pedir confirmación (uso no interactivo)." },
      { flag: "--cwd <dir>", desc: "Directorio del repo. Default: cwd." },
    ],
    example: [
      {
        title: "Aprobar",
        code: "$ navori codex trust\nHooks de Codex — /repo\n  .\n    ⇡ PreToolUse (^Bash$) — guard-destructive [Untrusted]\n? ¿Aprobar estos hooks en ~/.codex/config.toml? Sí\n✓ Escrito. Backup previo: ~/.navori/backups/codex-config-...\n",
      },
    ],
    notes: [
      "Muestra la tabla de hooks (evento, matcher, estado) y pide confirmación antes de escribir; sin TTY hace falta --yes.",
      "Respalda ~/.codex/config.toml antes de editarlo y valida el resultado como TOML antes de escribir; si el archivo cambió desde que se mostró la confirmación, aborta sin escribir.",
      "Cubre la raíz y cada workspace de un monorepo con el engine 'codex' habilitado. 'navori doctor' detecta sin escribir si falta correrlo.",
      "Si CODEX_HOME está definido, usa $CODEX_HOME/config.toml en lugar de ~/.codex/config.toml; un valor relativo se rechaza.",
    ],
  },
  global: {
    id: "global",
    title: "global",
    summary:
      "Instala un harness base por máquina en ~/.claude, para las sesiones que arrancan fuera de un repo con navori. Opt-in y de huella cero: sin 'navori global init' no existe, y navori no tocó nada de tu máquina.",
    usage:
      "navori global init [--apply] [--recommended] [--lang <es|en>]\nnavori global render [--apply]\nnavori global doctor\nnavori global collect install|uninstall\nnavori global uninstall",
    flags: [
      {
        flag: "init",
        desc: "Wizard de la capa global: elige los bloques del baseline y tus permisos personales. Preview por default — sin --apply no escribe un solo byte, solo muestra el plugin, el hook y los settings que instalaría.",
      },
      {
        flag: "init --apply",
        desc: "Escribe lo que el preview mostró: el manifest ~/.navori/global.json y el plugin 'navori@skills-dir' en ~/.claude/skills/navori/ (8 agentes, 14 skills y el hook del baseline).",
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
        flag: "collect install",
        desc: "Instala el LaunchAgent (macOS) que mantiene arriba 'navori audit --collect', el receptor de la tercera fuente de audit. Con KeepAlive y RunAtLoad: launchd lo revive si se cae y lo levanta al arrancar la máquina. navori escribe el plist; launchd lo ejecuta. Antes de reportar éxito confirma con reintentos acotados que el receptor responde de verdad, no solo que launchd registró el job.",
      },
      {
        flag: "collect uninstall",
        desc: "Descarga el LaunchAgent y borra el plist. Igual que el resto de 'global': todo lo que navori escribió fuera del repo sabe deshacerse.",
      },
      {
        flag: "uninstall",
        desc: "Retira solo lo que navori escribió: el plugin, el manifest y los permisos que reclamó — los tuyos quedan intactos.",
      },
    ],
    example: [
      {
        title: "Ver qué instalaría (no escribe nada)",
        code: "$ navori global init --recommended\n  · plugin: ~/.claude/skills/navori (25 archivos)\n  · hook: ~/.claude/skills/navori/hooks/navori-global-baseline.sh\n  · settings: sin cambios (~/.claude/settings.json)\n  · Bloques del baseline: operaciones-seguras, idioma-rol, formato-respuesta, orquestacion\nPreview: no se escribió un solo byte. Corre 'navori global init --apply' para instalar.",
      },
      {
        title: "Instalar la capa global",
        code: "$ navori global init --apply\n  · plugin: ~/.claude/skills/navori (25 archivos)\n  · Bloques del baseline: operaciones-seguras, idioma-rol, formato-respuesta, orquestacion\n✓ Harness global instalado en ~/.claude.",
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
      {
        flag: "<plugin>",
        desc: "Id del plugin a quitar (semgrep, jscpd, codegraph, tgrep, acli, gh).",
      },
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
      "Tu edición manda: cuando la detección discrepa de un valor que ya editaste a mano, el config gana. El quality gate solo se propone si el repo GANÓ pasos que te faltan — nunca para recortarte uno; 'engines' ni se propone, se reporta; y las migraciones de librería se reconcilian por 'legacy'. La excepción declarada es 'project.libraries', que es un campo derivado de tus dependencias y sí se reemplaza.",
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
      "monorepo.workspaceHarness decide cuánto harness recibe cada workspace: minimal (default, su archivo de contexto más las skills que el root no tiene), full (todo) o root (solo su archivo de contexto; el root escribe además las skills de librería y preset de los workspaces). root exige un navori que lo conozca en cada máquina y en CI.",
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
        code: "$ navori registry scan ~/dev --depth=3\n│    · conocido  demo  /Users/tu/dev/demo\n│    ~ worktree  /Users/tu/dev/wt-BT-123\n└  Listo 0 agregado(s) · 1 ya registrado(s)",
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
      "'scan' omite los git worktrees: traen el árbol del repo padre, harness incluido, y registrarlos haría que 'render --all' escriba en las ramas de sus tickets. Te los reporta aparte; si de verdad quieres uno, 'registry add <ruta>'.",
      "El 'name' que ves aquí es una copia de tu navori.config.json, y 'render' la refresca en cada corrida con --apply.",
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
  tools: {
    id: "tools",
    title: "tools",
    summary:
      "Comando de máquina del hook SessionStart: avisa una vez que hay una versión estable más nueva de una herramienta con latestRelease en su manifest (hoy, engram).",
    usage: "navori tools notice [--ack <plugin@x.y.z,...>]",
    flags: [
      {
        flag: "notice",
        desc: "Lee la caché por máquina (nunca la red), reserva el refresco diario en un worker aparte e imprime los avisos pendientes. Sin avisos no imprime nada.",
      },
      {
        flag: "--ack <plugin@x.y.z,...>",
        desc: "Marca como entregados los avisos de esas versiones. Solo lo llama el hook, después de emitir el cuerpo.",
      },
    ],
    example: [
      {
        title: "Lo que lee el hook",
        code: "$ navori tools notice\n#navori-tool-notice v1 ack=engram@3.2.1\nHay una versión nueva de engram: 3.2.1 (instalada: 3.0.0). Avísale al usuario una vez; `navori doctor` muestra el detalle.",
      },
    ],
    notes: [
      "La primera línea es un centinela: el hook descarta cualquier salida que no empiece con '#navori-tool-notice v1', así un navori viejo no mete su banner de uso al contexto.",
      "Termina siempre con exit 0. NAVORI_NO_UPDATE_NOTIFIER=1 lo apaga por completo, y 'navori doctor' muestra los mismos avisos como dato informativo.",
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
        code: "$ navori backup list\n│  1 backup(s) en total. Mostrando 1:\n│    · repo-2026-09-01T17-49-47-756  (recién)\n│        · .claude/agents/orchestrator.md\n│        · CLAUDE.md\n└  Listo",
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
      "navori audit [--session <id>] [--days <n>] [--since <fecha>] [--until <fecha>] [--all-repos] [--include-human-content] [--snapshot <nombre>] [--compare <snapshot>] [--json]",
    flags: [
      { flag: "--session <id>", desc: "Una sesión por id, prefijo, o 'latest'." },
      { flag: "--days <n>", desc: "Solo sesiones marcadas en los últimos N días." },
      { flag: "--since <YYYY-MM-DD>", desc: "Desde esta fecha." },
      { flag: "--until <YYYY-MM-DD>", desc: "Hasta esta fecha." },
      { flag: "--json", desc: "Imprime el reporte JSON a stdout sin escribir archivos." },
      { flag: "--out <dir>", desc: "Cambia el directorio de salida." },
      {
        flag: "--all-repos",
        desc: "Reporte de rango sobre todos los repos auditados, con la cobertura de cada uno.",
      },
      {
        flag: "--include-human-content",
        desc: "Incluye contenido humano en los reportes privados, solo en esta llamada. No se combina con --collect.",
      },
      { flag: "--disarm", desc: "Cancela un --arm pendiente sin iniciar ninguna sesión." },
      {
        flag: "--snapshot <nombre>",
        desc: "Congela las métricas del rango como snapshot versionado (formato 2: cohortes por host, régimen, modelo y trabajo) en la raíz de auditoría. No sobrescribe uno existente. No se combina con --json.",
      },
      {
        flag: "--copy-to <ruta>",
        desc: "Copia el snapshot a esta ruta, relativa a la raíz de git; no sobrescribe.",
      },
      {
        flag: "--compare <snapshot>",
        desc: "Compara el rango contra un snapshot guardado, métrica por métrica. Solo describe: marca 'matched' cuando las cohortes coinciden y nunca declara una mejora. Sí se combina con --json (no escribe archivos).",
      },
      { flag: "--start <id>", desc: "Marca una sesión como auditada (lo usa el flujo del hook)." },
      {
        flag: "--arm",
        desc: "Arma el audit-mode: si ya hay una sesión abierta en el repo, arranca en su siguiente mensaje (sirve `! navori audit --arm` desde dentro); si no, arranca al abrir la próxima. El hook hace el --start solo (una sesión exacta; --disarm lo cancela).",
      },
      { flag: "--stop <id>", desc: "Sella el log de la sesión y reporta sobre ella." },
      {
        flag: "--collect",
        desc: "Levanta el receptor de eventos OTel en 127.0.0.1:4318 hasta que lo cortes: la tercera fuente, la que sabe qué decidió el host (quién aprobó cada permiso, qué skill estaba activa). Imprime la dirección, el directorio de salida y las variables que hay que exportar en la terminal de la sesión auditada.",
      },
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
      "Lo que un host no expone aparece como no disponible, nunca como 0. El reporte suma resultados por tarea (revisión, recibo, despacho) y recomendaciones agrupadas por su denominador, sin puntaje único.",
      "Cada métrica declara su ventana de disponibilidad (desde qué versión o fuente existe el dato), y el reporte suma métricas de eficiencia por tarea. Un flag no declarado se rechaza (exit 2).",
      "Límites: los verbos de revisión del recibo llegan desde la versión 0.11.3, los umbrales mínimos y topes no están calibrados, la banda de ruido de --compare no está medida y la atribución de tokens por tarea cubre solo al implementer.",
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
  receipt: {
    id: "receipt",
    title: "receipt",
    summary: "Firma o verifica los bytes revisados antes de publicar un cambio.",
    usage:
      "navori receipt <sign|check|gate|review begin|review seal> --feature <id> [--target <ref>] [--dir <path>] [--include-consumed] [--spec <spec> --milestone M<n> [--gate-ran <scoped|full>]] [--json]",
    flags: [
      { flag: "--feature <id>", desc: "Identificador recibido en el handoff." },
      { flag: "--target <ref>", desc: "Base real del PR; por defecto prTarget." },
      { flag: "--dir <path>", desc: "Directorio de progreso; por defecto .claude/progress." },
      {
        flag: "--spec <spec> --milestone M<n>",
        desc: "Spec y milestone del ciclo; con `gate` son obligatorios, con `sign` van juntos con --gate-ran.",
      },
      {
        flag: "--gate-ran <scoped|full>",
        desc: "`sign`: el gate que corrió el ciclo. Se rechaza `scoped` cuando la decisión es `full`.",
      },
      {
        flag: "--include-consumed",
        desc: "`check`: si receipt.txt ya no existe, usa receipt.consumed.txt (el recibo ya consumido por la publicación).",
      },
      {
        flag: "review begin | review seal --nonce <n>",
        desc: "Evidencia del productor de review_<feature>.json: `begin` sella la identidad del contenido antes del diff e imprime el nonce; `seal` sella el sidecar escrito con ese nonce.",
      },
      { flag: "--json", desc: "Emite el contrato machine-readable." },
    ],
    example: [
      {
        title: "Firmar y verificar",
        code: "navori receipt sign --feature checkout --json\nnavori receipt check --feature checkout --json",
      },
    ],
    notes: [
      "Solo publica cuando el JSON devuelve status ok.",
      "`gate` es de solo lectura: devuelve { gateKind, reason, unit, closingMilestone } y decide si el ciclo del milestone necesita el gate acotado (scoped) o el completo (full). Un receipt scoped no es fresh: solo permite el commit, nunca el PR.",
    ],
  },
  plan: {
    id: "plan",
    title: "plan",
    summary: "Clasifica la complejidad de una tarea y valida su workplan (spec 0032).",
    usage:
      "navori plan <classify|render|update|check|gate> <feature> [--files <a,b,c> | --diff [<base>]] [--dir <path>] [--json]",
    flags: [
      { flag: "--files <a,b,c>", desc: "Rutas relativas al repo tocadas por la tarea (classify)." },
      {
        flag: "--diff [<base>]",
        desc: "Clasifica el diff real (`git diff --name-only <base>...HEAD`, default origin/main) contra las señales declaradas del workplan (classify); falla si el diff supera el nivel declarado.",
      },
      {
        flag: "--critical-area / --money-credentials-pii / --multi-repo / --new-external-dependency / --shared-contract / --data-schema-migration / --bug-without-root-cause",
        desc: "Señales declaradas que classify no puede medir por sí solo.",
      },
      {
        flag: "--progress <A1>=<estado>",
        desc: "Cambia el estado de un criterio (update); repetible (--progress A1=cumplido --progress A2=bloqueado) y se aplica todo o nada.",
      },
      {
        flag: "--decision <texto> --date <fecha>",
        desc: "Agrega una decisión al workplan (update).",
      },
      { flag: "--dir <path>", desc: "Directorio de progreso; por defecto .claude/progress." },
      { flag: "--json", desc: "Emite el contrato machine-readable." },
    ],
    example: [
      {
        title: "Clasificar y validar",
        code: "navori plan classify checkout --files src/checkout.ts,src/checkout.test.ts --json\nnavori plan check checkout",
      },
      {
        title: "Verificar el diff real contra el nivel declarado",
        code: "navori plan classify checkout --diff origin/main",
      },
    ],
    notes: [
      "`classify` es la única definición del nivel de una tarea (0-3); no reescribas sus umbrales en otro lugar.",
      "`render` regenera workplan_<feature>.md desde el JSON de forma determinista — nunca lo edites a mano.",
      "`gate` no toma <feature>: lee el payload del hook PreToolUse(Agent) por stdin y niega el despacho del implementer bajo harness.planTiers sin un workplan válido o una exención de nivel 0.",
      "El hook plan-gate solo deniega cuando hay un veredicto (plan ausente o inválido). Si falta el binario navori o su subcomando plan no hay veredicto: en Claude, con permisos que muestran el prompt, pide confirmación al humano en lugar de bloquear; en Codex o en modos sin prompt mantiene el bloqueo.",
    ],
  },
  spec: {
    id: "spec",
    title: "spec",
    summary: "Clasifica el tasks.md de una spec y valida su estructura de entregas (spec 0044).",
    usage: "navori spec <classify|check> <feature> [--cwd <path>] [--json]",
    flags: [
      { flag: "--cwd <path>", desc: "Raíz del repo; por defecto el directorio actual." },
      { flag: "--json", desc: "Emite el contrato machine-readable." },
    ],
    example: [
      {
        title: "Clasificar y validar una spec",
        code: "navori spec classify checkout --json\nnavori spec check checkout",
      },
    ],
    notes: [
      "`classify` decide la forma: un solo PR (single) o un PR por entrega funcional (split). Parte solo con 2 o más entregas y más de 12 tareas o de 1500 líneas estimadas, con un tope de 4 PRs; los umbrales viven en sdd.deliveries.",
      "`check` valida hitos, criterios, tareas, cobertura de R<n>, entregas verticales y foundation. Si la spec es una parte de master-plan en modo entregas, cada `E<n>` debe existir en parts.json (`master-delivery-unmapped`, error) y su destino debe coincidir con prTarget (`master-target-mismatch`, advertencia). Las specs del formato anterior solo emiten advertencias.",
      "Códigos de salida: 0 sin hallazgos o solo advertencias, 2 con hallazgos de error, 1 por config inválida o tasks.md ausente (`classify` también sale con 1 cuando las entregas superan maxPrsPerSpec).",
      "Es de solo lectura: no ejecuta los comandos de aceptación ni abre PRs.",
    ],
  },
  handoff: {
    id: "handoff",
    title: "handoff",
    summary:
      "Valida el handoff del implementer antes de que el orquestador despache al siguiente rol.",
    usage:
      "navori handoff <check|log-review> <feature> [--for scribe] [--dir <path>] [--cwd <checkout>] [--json]",
    flags: [
      {
        flag: "--for scribe",
        desc: "Además de existencia/parseo/feature, exige que --cwd coincida con el worktree y la rama del handoff, y valida cada markdownRequests[].path. Sin esta flag valida solo lo que el orquestador necesita (existe, parsea, es del feature pedido).",
      },
      { flag: "--dir <path>", desc: "Directorio de progreso; por defecto .claude/progress." },
      { flag: "--cwd <checkout>", desc: "Checkout a validar; por defecto el directorio actual." },
      { flag: "--json", desc: "Emite el contrato machine-readable." },
    ],
    example: [
      {
        title: "Antes de despachar al scribe o al reviewer",
        code: "navori handoff check checkout --json",
      },
      {
        title: "Preflight del scribe antes de escribir o commitear",
        code: "navori handoff check checkout --for scribe --cwd <checkout> --json",
      },
    ],
    notes: [
      "El JSON trae `status` (ok/findings/error), `failures` y `warnings` con un `check` nombrado por regla (exists/parse/feature/worktree/branch/path para las fallas; head/legacy-md para los avisos), y el `worktree`/`branch` que el handoff registró.",
      "Exit codes como `receipt`: 0 ok, 2 findings (una comprobación falló), 1 error (git o I/O, nunca una falla de validación).",
      "`log-review <feature>` valida review_<feature>.json y agrega a findings.jsonl los hallazgos con score >= 50, sin duplicar los ya registrados. Acepta --dir, --cwd y --json; sale con 1 si el sidecar no es válido.",
      "Sin `head` en el handoff el resultado sigue siendo `ok`, solo con un aviso — nunca bloquea.",
      "Con `harness.scribeOwnsMarkdown: false` valida `impl_<feature>.md` en su lugar (existe, no está vacío, tiene una línea `Status:`), ligado al feature solo por el nombre del archivo.",
    ],
  },
  master: {
    id: "master",
    title: "master",
    summary: "Plan maestro de proyecto: gestiona etapas, fases, partes y cierre (spec 0034).",
    usage:
      "navori master <init|mode|ux|status|check|advance|part|template|close|delivery-*> [opciones] [--cwd <path>]",
    flags: [
      {
        flag: "<slug>",
        desc: "Slug en kebab-case para la primera etapa (init); obligatorio solo cuando no hay ninguna etapa activa.",
      },
      {
        flag: "<template|en-curso>",
        desc: "Modo de la etapa (mode). Solo se puede fijar en fase 'context' y solo en la primera etapa — de la etapa 2 en adelante el modo queda registrado como 'en-curso' automáticamente.",
      },
      {
        flag: "ux <none|md|md-json>",
        desc: "Registra la decisión del contrato UX de la etapa. Solo se puede fijar en la fase 'ux' y aún no está disponible para el modo entregas.",
      },
      {
        flag: "delivery-slice --part <P<n>> [--refresh --approved-by user]",
        desc: "Proyecta una parte autorizada en un workplan. --refresh reinicia los criterios pendientes y exige --approved-by user.",
      },
      {
        flag: "delivery-queue --delivery <E<n>> --parts <P1,P2> --approved-by user [--transition replacement|continuation]",
        desc: "Autoriza una cola acotada de partes para una entrega; las partes se validan contra parts.json.",
      },
      {
        flag: "delivery-check | delivery-baseline --approved-by user | delivery-revoke --approved-by user",
        desc: "Revisa sin escribir si la preparación está lista (exit 1 con bloqueos), registra la aprobación explícita de la base o revoca la autoridad de la cola.",
      },
      {
        flag: "delivery-criterion --part <P<n>> --criterion <A<n>> [--approved-by user]",
        desc: "Consume la evidencia del host o, solo en criterios manuales, una atestación explícita (--approved-by user).",
      },
      {
        flag: "delivery-review --part <P<n>> --report <archivo> --envelope <archivo> [--approved-by user]",
        desc: "Registra la revisión técnica atestada por el operador; el CLI verifica contenido y recibo, no la identidad del revisor ni la ejecución del QA.",
      },
      {
        flag: "delivery-present --delivery <E<n>>",
        desc: "Registra la identidad de una demo ya revisada técnicamente; no es el consentimiento del cliente.",
      },
      {
        flag: "delivery-decision --delivery <E<n>> --identity <id> --decision <accepted|declined|deferred|discarded> [--reason <texto>] [--reference <ref>] --approved-by user",
        desc: "Registra la decisión del cliente sobre una identidad revisada; toda decisión distinta de accepted exige --reason.",
      },
      {
        flag: "delivery-publication --delivery <E<n>> --identity <id> --kind <release|deploy> --reference <ref> --approved-by user",
        desc: "Atesta la referencia de release o deploy de una identidad aceptada, sin ejecutar el despliegue (un merge no cuenta).",
      },
      {
        flag: "status [--json|--line]",
        desc: "Muestra la etapa y fase actuales; sin opciones regenera STATUS.md. --json y --line son de solo lectura.",
      },
      {
        flag: "check [--stage <NN-slug>|--part <P<n>>|--fit [--json]]",
        desc: "Valida la salida de la fase activa, una etapa cerrada, una spec de parte o los criterios verificables para convertir a una sola spec.",
      },
      {
        flag: "advance",
        desc: "Valida la fase activa y avanza una fase cuando se cumplen sus requisitos.",
      },
      {
        flag: "part <P<n>> [--state <estado>] [--reason <texto>] [--spec <ruta>] [--issue <n>]",
        desc: "Actualiza una parte; --accept, --command, --result y --approved-by registran evidencia de aceptación.",
      },
      {
        flag: "template <nombre> [--part <P<n>>]",
        desc: "Imprime una plantilla; --part rellena la plantilla issue desde parts.json.",
      },
      {
        flag: "close [--convert <ruta>|--abandon] [--reason <texto>]",
        desc: "Cierra, convierte o abandona la etapa activa; las etapas cerradas son de solo lectura.",
      },
      { flag: "--cwd <path>", desc: "Repo a operar; por defecto el directorio actual." },
    ],
    example: [
      {
        title: "Abrir la primera etapa",
        code: "$ navori master init mvp\nEtapa 01-mvp · fase context\nSeñal: commits=3 primerCommit=2026-08-01 archivosCambiados=12 framework=next sugerido=template",
      },
      { title: "Registrar el modo tras revisar la señal", code: "navori master mode template" },
    ],
    notes: [
      "init crea <sdd.specsDir>/_master/<NN>-<slug>/ con context/raw/ (con su propio .gitignore, fuera de git sin importar gitignoreHarness), context/md/ y plans/, enciende harness.masterPlan y aplica el render.",
      "Con una etapa ya activa, init (con o sin slug) no crea otra: completa lo que le falte a la activa, reporta su etapa y fase, y sale con 1 si se pidió un slug.",
      "Falla si sdd.enabled es false, nombrando la clave que hay que activar.",
      "check --stage inspecciona etapas cerradas; las operaciones que mutan estado solo actúan sobre la etapa activa.",
      "Los subcomandos delivery-* son del modo entregas: validan las partes contra parts.json y toda aprobación exige --approved-by user. El hook master-accept-confirm pide confirmación humana antes de registrar una aceptación; un agente no puede aprobarse a sí mismo.",
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
        desc: "--recommended + default external providers (tgrep, semgrep, jscpd, acli; codegraph opt-in) + pre-commit hook + monorepo scan + strict project block (posture/reviewRigor/testsForNewCode). Requires installing those providers' binaries.",
      },
      {
        flag: "--recommended",
        desc: "Opinionated mode: --yes + full harness without installing external software (+gh on GitHub repos; engram already ships always-on).",
      },
      { flag: "--yes", desc: "Accept everything detected without prompting (CI-friendly)." },
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
      "In every mode (--yes, --recommended, --full or interactive), init warns when an enabled plugin's binary isn't on PATH and how to install it; it never installs it for you.",
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
        desc: "Plugin to register: engram, codegraph, tgrep, semgrep, jscpd, acli, gh.",
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
        code: "$ navori add engram\n✓ Added 'engram' to navori.config.json\n✓ Rendered CLAUDE.md — 2 created, 1 updated\nDone",
      },
      {
        title: "Stack suggestions",
        code: "$ navori add --suggest\nSuggestions:\n · Plugin engram: persistent memory across sessions — 'navori add engram'\n · Available external provider: 'codegraph' — 'navori add codegraph'",
      },
    ],
    notes: [
      "add updates navori.config.json and renders the plugin's wiring (.mcp.json, permissions, managed blocks) in the same step.",
    ],
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
    usage:
      "navori render [--apply] [--force] [--workspace <name>] [--json] [--all [--prune] [--verbose]]",
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
      { flag: "--json", desc: "Machine-readable result; suppresses human output (CI/automation)." },
      {
        flag: "--all",
        desc: "Renders EVERY repo in the global registry (~/.navori/registry.json), not just the current one. Use it after a navori bump to roll changes into all your projects.",
      },
      {
        flag: "--prune",
        desc: "With --all: drops registry entries whose repo no longer exists before rendering. In a single repo (with --apply): deletes, backing up first, outputs left by engines no longer in config.engines.",
      },
      {
        flag: "--verbose",
        desc: "With --all: lists each changed managed block per repo, not just the counts.",
      },
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
      "Also writes '.claude/.gitignore' (and '.codex/.gitignore' when codex is enabled) with a versioned managed block that ignores the harness's ephemeral state (progress/, worktrees/, settings.local.json) under any gitignoreHarness mode; it never ignores anything the engine needs.",
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
        desc: "Resolve each conflict one by one: see the diff and pick keep-mine or accept-new, whether it is a CLAUDE.md block, a whole file that carries a marker, or a markerless file (replaced whole, with a backup).",
      },
      { flag: "--apply", desc: "Apply changes without the interactive prompt." },
      { flag: "--yes", desc: "Auto-confirm. Exits 1 if there are conflicts (CI gate)." },
      {
        flag: "--accept-new",
        desc: "Resolves, without prompting, every CLAUDE.md block conflict with the new rendered version. Destructive: requires --apply or --yes and backs up CLAUDE.md first. Your user zone is never touched.",
      },
      {
        flag: "--keep-mine",
        desc: "Resolves, without prompting, every CLAUDE.md block conflict by keeping your edit and applying the remaining changes. Requires --apply or --yes.",
      },
      { flag: "--dry-run", desc: "Shows the plan without writing." },
      { flag: "--json", desc: "Machine-readable output for CI; suppresses human output." },
      {
        flag: "--accept-new-files",
        desc: "Overwrite, without prompting, every hand-edited whole file that still carries its navori marker. Requires --apply or --yes and backs up each file first. --accept-new never touches whole files.",
      },
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
      "A hand-edited whole file (agent, skill, hook, plugin script, AGENTS.md…) that still carries its navori marker is resolved with --interactive (diff + keep/accept) or in bulk with --accept-new-files. A file with no navori marker at all (a legacy plugin script, or your own file at a plugin path) is replaced whole only with --interactive: it warns that this is not a navori edit, shows the diff, defaults to keeping yours and, if you accept, backs it up (kept 30 days; recover it with navori backup restore). No bulk flag or --json touches it. If it keeps only part of the marker or mentions it in a comment, the exit is manual: move it aside and run render --apply.",
      "With --json, each conflict carries 'resolvable' ('bulk' or 'none') and the output carries 'acceptNewFiles'; it never includes file contents and reports the post-resolution state.",
      "sync is for version upgrades; render --apply is for regenerating.",
      "Keeps the harness's '.claude/.gitignore' (and '.codex/.gitignore' with codex enabled) up to date, same as any other managed block.",
    ],
  },
  doctor: {
    id: "doctor",
    title: "doctor",
    summary: "Project audit: config, plugins, drift, invariants and suggested next steps.",
    usage: "navori doctor [--json] [--strict]",
    flags: [
      { flag: "--json", desc: "Structured output for CI (pipeable)." },
      {
        flag: "--strict",
        desc: "Exit 1 when drift or a .mcp.json incoherent with a plugin's manifest is detected (intended for CI gates).",
      },
    ],
    example: [
      {
        title: "Diagnose",
        code: "$ navori doctor\nConfig · navori.config.json\nManaged blocks · 5\n! drift: .claude/agents/orchestrator.md edited by hand\nNext steps · run 'navori sync --interactive'",
      },
    ],
    notes: [
      "Run doctor in CI with --strict to fail the build on unresolved drift.",
      "Validates invariants: load-bearing substrings that must survive in the output (exit 2 if missing).",
      "Codex trust state is read from $CODEX_HOME/config.toml if CODEX_HOME is set, and from ~/.codex/config.toml otherwise; a relative value is rejected.",
      "With the codex engine enabled it also checks every git worktree of the repo that has .codex/config.toml: it warns with the hook, the path and 'cd <path> && navori codex trust' when approval is missing. It also warns when the installed codex is newer than the last verified version. If git or the disk fails, it degrades to a warning.",
      "If any rendered hook calls 'navori', it warns when the global 'navori' on the PATH is older than the CLI running doctor (it would run old logic); it never changes ok.",
      "It reports, as informational data only, when a newer stable release exists for an external tool whose manifest declares latestRelease (today, engram), and warns when the installed version is below a known-bad floor (today, engram < 3.0.0). Neither changes the verdict or --strict.",
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
  codex: {
    id: "codex",
    title: "codex",
    summary:
      "Approves the project's Codex hooks in ~/.codex/config.toml. Codex loads nothing from the repo (not even AGENTS.md) until the project is trusted.",
    usage: "navori codex trust [--yes] [--cwd <dir>]",
    flags: [
      { flag: "--yes", desc: "Approve without a confirmation prompt (non-interactive use)." },
      { flag: "--cwd <dir>", desc: "Repo directory. Default: cwd." },
    ],
    example: [
      {
        title: "Approve",
        code: "$ navori codex trust\nCodex hooks — /repo\n  .\n    ⇡ PreToolUse (^Bash$) — guard-destructive [Untrusted]\n? Approve these hooks in ~/.codex/config.toml? Yes\n✓ Written. Previous backup: ~/.navori/backups/codex-config-...\n",
      },
    ],
    notes: [
      "Shows the hook table (event, matcher, status) and asks for confirmation before writing; no TTY needs --yes.",
      "Backs up ~/.codex/config.toml before editing it and validates the result as TOML before writing; aborts without writing if the file changed since the confirmation was shown.",
      "Covers the root and every monorepo workspace with the 'codex' engine enabled. 'navori doctor' detects, without writing, when this is still needed.",
      "If CODEX_HOME is set, it uses $CODEX_HOME/config.toml instead of ~/.codex/config.toml; a relative value is rejected.",
    ],
  },
  global: {
    id: "global",
    title: "global",
    summary:
      "Installs a machine-wide harness baseline into ~/.claude, for sessions that start outside a navori repo. Opt-in and zero-footprint: without 'navori global init' it doesn't exist, and navori touched nothing on your machine.",
    usage:
      "navori global init [--apply] [--recommended] [--lang <es|en>]\nnavori global render [--apply]\nnavori global doctor\nnavori global collect install|uninstall\nnavori global uninstall",
    flags: [
      {
        flag: "init",
        desc: "Global-layer wizard: pick the baseline blocks and your personal permissions. Preview by default — without --apply it writes not a single byte, it only shows the plugin, the hook and the settings it would install.",
      },
      {
        flag: "init --apply",
        desc: "Writes what the preview showed: the ~/.navori/global.json manifest and the 'navori@skills-dir' plugin under ~/.claude/skills/navori/ (8 agents, 14 skills and the baseline hook).",
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
        flag: "collect install",
        desc: "Installs the LaunchAgent (macOS) that keeps 'navori audit --collect' up — the receiver behind audit's third source. With KeepAlive and RunAtLoad: launchd revives it when it dies and starts it at login. navori writes the plist; launchd runs it. Before reporting success it confirms, with bounded retries, that the receiver actually answers — not just that launchd registered the job.",
      },
      {
        flag: "collect uninstall",
        desc: "Unloads the LaunchAgent and deletes the plist. Like the rest of 'global': everything navori wrote outside the repo knows how to undo itself.",
      },
      {
        flag: "uninstall",
        desc: "Removes only what navori wrote: the plugin, the manifest and the permissions it claimed — yours are left intact.",
      },
    ],
    example: [
      {
        title: "See what it would install (writes nothing)",
        code: "$ navori global init --recommended\n  · plugin: ~/.claude/skills/navori (25 files)\n  · hook: ~/.claude/skills/navori/hooks/navori-global-baseline.sh\n  · settings: unchanged (~/.claude/settings.json)\n  · Baseline blocks: operaciones-seguras, idioma-rol, formato-respuesta, orquestacion\nPreview: not a single byte was written. Run 'navori global init --apply' to install.",
      },
      {
        title: "Install the global layer",
        code: "$ navori global init --apply\n  · plugin: ~/.claude/skills/navori (25 files)\n  · Baseline blocks: operaciones-seguras, idioma-rol, formato-respuesta, orquestacion\n✓ Global harness installed at ~/.claude.",
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
      {
        flag: "<plugin>",
        desc: "Plugin id to remove (semgrep, jscpd, codegraph, tgrep, acli, gh).",
      },
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
      "Your edit wins: when detection disagrees with a value you already set by hand, the config keeps it. The quality gate is only proposed when the repo GAINED steps yours lacks — never to trim one away; 'engines' is reported, not proposed; and library migrations are reconciled by 'legacy'. The declared exception is 'project.libraries', a field derived from your dependencies, which is replaced.",
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
      "monorepo.workspaceHarness decides how much harness each workspace gets: minimal (default, its context file plus the skills the root lacks), full (everything) or root (only its context file; the root also writes the workspaces' library and preset skills). root requires a navori that knows it on every machine and in CI.",
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
        code: "$ navori registry scan ~/dev --depth=3\n│    · known  demo  /Users/you/dev/demo\n│    ~ worktree  /Users/you/dev/wt-BT-123\n└  Done 0 added · 1 already registered",
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
      "'scan' skips git worktrees: they carry the parent repo's tree, harness included, and registering them would make 'render --all' write into their ticket branches. They are reported separately; to register one on purpose, use 'registry add <path>'.",
      "The 'name' shown here is a copy of your navori.config.json, and 'render' refreshes it on every --apply run.",
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
  tools: {
    id: "tools",
    title: "tools",
    summary:
      "Machine command for the SessionStart hook: tells the session once that a newer stable release exists for a tool whose manifest declares latestRelease (today, engram).",
    usage: "navori tools notice [--ack <plugin@x.y.z,...>]",
    flags: [
      {
        flag: "notice",
        desc: "Reads the per-machine cache (never the network), reserves the daily refresh for a detached worker and prints the pending notices. With none, it prints nothing.",
      },
      {
        flag: "--ack <plugin@x.y.z,...>",
        desc: "Marks the notices for those versions as delivered. Only the hook calls it, after emitting the body.",
      },
    ],
    example: [
      {
        title: "What the hook reads",
        code: "$ navori tools notice\n#navori-tool-notice v1 ack=engram@3.2.1\nA newer engram is available: 3.2.1 (installed: 3.0.0). Tell the user once; `navori doctor` shows the detail.",
      },
    ],
    notes: [
      "The first line is a sentinel: the hook discards any output that does not start with '#navori-tool-notice v1', so an older navori cannot put its usage banner in the context.",
      "It always exits 0. NAVORI_NO_UPDATE_NOTIFIER=1 turns it off entirely, and 'navori doctor' shows the same notices as informational data.",
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
        code: "$ navori backup list\n│  1 backup(s) total. Showing 1:\n│    · repo-2026-09-01T17-49-47-756  (just now)\n│        · .claude/agents/orchestrator.md\n│        · CLAUDE.md\n└  Done",
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
    usage:
      "navori audit [--session <id>] [--days <n>] [--since <date>] [--until <date>] [--all-repos] [--include-human-content] [--snapshot <name>] [--compare <snapshot>] [--json]",
    flags: [
      { flag: "--session <id>", desc: "One session by id, prefix, or 'latest'." },
      { flag: "--days <n>", desc: "Only sessions marked in the last N days." },
      { flag: "--since <YYYY-MM-DD>", desc: "From this date." },
      { flag: "--until <YYYY-MM-DD>", desc: "Up to this date." },
      { flag: "--json", desc: "Print the JSON report to stdout without writing files." },
      { flag: "--out <dir>", desc: "Override the output directory." },
      {
        flag: "--all-repos",
        desc: "Range report across every audited repo, with each repo's coverage.",
      },
      {
        flag: "--include-human-content",
        desc: "Includes human content in the private reports, for this call only. It cannot be combined with --collect.",
      },
      { flag: "--disarm", desc: "Cancels a pending --arm without starting any session." },
      {
        flag: "--snapshot <name>",
        desc: "Freeze the range's metrics as a versioned snapshot (format 2: cohorts by host, regime, model and work) in the audit root. Never overwrites an existing one. Cannot be combined with --json.",
      },
      {
        flag: "--copy-to <path>",
        desc: "Copy the snapshot to this path, relative to the git root; no overwrite.",
      },
      {
        flag: "--compare <snapshot>",
        desc: "Compare the range against a saved snapshot, metric by metric. Descriptive only: it marks 'matched' when the cohorts agree and never declares an improvement. Can be combined with --json (writes no files).",
      },
      { flag: "--start <id>", desc: "Mark a session as audited (used by the hook flow)." },
      {
        flag: "--arm",
        desc: "Arm audit-mode: an open session in the repo activates on its next message (works in-session via `! navori audit --arm`); otherwise the next session opened does. The hook issues --start itself (exactly one session; --disarm cancels).",
      },
      { flag: "--stop <id>", desc: "Seal the session's log and report on it." },
      {
        flag: "--collect",
        desc: "Run the OTel events receiver on 127.0.0.1:4318 until you stop it: the third source, the one that knows what the host decided (who approved each permission, which skill was active). Prints the address, the output directory and the variables to export in the audited session's terminal.",
      },
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
      "What a host does not expose shows as unavailable, never as 0. The report adds per-task outcomes (review, receipt, dispatch) and recommendations grouped by their denominator, with no single score.",
      "Each metric declares its availability window (since which version or source the data exists), and the report adds per-task efficiency metrics. An undeclared flag is rejected (exit 2).",
      "Limits: the receipt review verbs ship from release 0.11.3, the minimum floors and caps are uncalibrated, --compare's noise band is unmeasured, and per-task token attribution covers the implementer only.",
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
  receipt: {
    id: "receipt",
    title: "receipt",
    summary: "Signs or checks the reviewed bytes before publishing a change.",
    usage:
      "navori receipt <sign|check|gate|review begin|review seal> --feature <id> [--target <ref>] [--dir <path>] [--include-consumed] [--spec <spec> --milestone M<n> [--gate-ran <scoped|full>]] [--json]",
    flags: [
      { flag: "--feature <id>", desc: "Identifier received in the handoff." },
      { flag: "--target <ref>", desc: "Actual PR base; defaults to prTarget." },
      { flag: "--dir <path>", desc: "Progress directory; defaults to .claude/progress." },
      {
        flag: "--spec <spec> --milestone M<n>",
        desc: "Spec and milestone of the cycle; required by `gate`, and with `sign` they go together with --gate-ran.",
      },
      {
        flag: "--gate-ran <scoped|full>",
        desc: "`sign`: the gate the cycle ran. `scoped` is refused when the decision is `full`.",
      },
      {
        flag: "--include-consumed",
        desc: "`check`: when receipt.txt is gone, falls back to receipt.consumed.txt (the receipt already consumed by publishing).",
      },
      {
        flag: "review begin | review seal --nonce <n>",
        desc: "Producer evidence for review_<feature>.json: `begin` stamps the content identity before the diff and prints the nonce; `seal` seals the written sidecar with that nonce.",
      },
      { flag: "--json", desc: "Emit the machine-readable contract." },
    ],
    example: [
      {
        title: "Sign and check",
        code: "navori receipt sign --feature checkout --json\nnavori receipt check --feature checkout --json",
      },
    ],
    notes: [
      "Publish only when JSON returns status ok.",
      "`gate` is read-only: it returns { gateKind, reason, unit, closingMilestone } and decides whether the milestone's cycle needs the scoped or the full gate. A scoped receipt is never fresh: it only allows the commit, never the PR.",
    ],
  },
  plan: {
    id: "plan",
    title: "plan",
    summary: "Classifies a task's complexity and validates its workplan (spec 0032).",
    usage:
      "navori plan <classify|render|update|check|gate> <feature> [--files <a,b,c> | --diff [<base>]] [--dir <path>] [--json]",
    flags: [
      { flag: "--files <a,b,c>", desc: "Repo-relative paths touched by the task (classify)." },
      {
        flag: "--diff [<base>]",
        desc: "Classifies the real diff (`git diff --name-only <base>...HEAD`, default origin/main) against the workplan's declared signals (classify); fails when the diff exceeds the declared level.",
      },
      {
        flag: "--critical-area / --money-credentials-pii / --multi-repo / --new-external-dependency / --shared-contract / --data-schema-migration / --bug-without-root-cause",
        desc: "Declared signals classify cannot measure on its own.",
      },
      {
        flag: "--progress <A1>=<status>",
        desc: "Changes a criterion's status (update); repeatable (--progress A1=cumplido --progress A2=bloqueado), applied all-or-nothing.",
      },
      {
        flag: "--decision <text> --date <date>",
        desc: "Appends a decision to the workplan (update).",
      },
      { flag: "--dir <path>", desc: "Progress directory; defaults to .claude/progress." },
      { flag: "--json", desc: "Emit the machine-readable contract." },
    ],
    example: [
      {
        title: "Classify and check",
        code: "navori plan classify checkout --files src/checkout.ts,src/checkout.test.ts --json\nnavori plan check checkout",
      },
      {
        title: "Check the real diff against the declared level",
        code: "navori plan classify checkout --diff origin/main",
      },
    ],
    notes: [
      "`classify` is the single definition of a task's level (0-3); don't rewrite its thresholds elsewhere.",
      "`render` regenerates workplan_<feature>.md from the JSON deterministically — never hand-edit it.",
      "`gate` takes no <feature>: it reads the PreToolUse(Agent) hook payload from stdin and denies dispatching the implementer under harness.planTiers without a valid workplan or a level-0 exemption.",
      "The plan-gate hook only denies when there is a verdict (missing or invalid plan). When the navori binary or its plan subcommand is missing there is no verdict: on Claude, in a permission mode that shows the prompt, it asks the human to confirm instead of blocking; on Codex or in modes without a prompt it keeps the block.",
    ],
  },
  spec: {
    id: "spec",
    title: "spec",
    summary: "Classifies a spec's tasks.md and validates its delivery structure (spec 0044).",
    usage: "navori spec <classify|check> <feature> [--cwd <path>] [--json]",
    flags: [
      { flag: "--cwd <path>", desc: "Repo root; defaults to the current directory." },
      { flag: "--json", desc: "Emits the machine-readable contract." },
    ],
    example: [
      {
        title: "Classify and validate a spec",
        code: "navori spec classify checkout --json\nnavori spec check checkout",
      },
    ],
    notes: [
      "`classify` decides the shape: one PR (single) or one PR per functional delivery (split). It splits only with 2 or more deliveries and more than 12 tasks or 1500 estimated lines, capped at 4 PRs; the thresholds live in sdd.deliveries.",
      "`check` validates milestones, criteria, tasks, R<n> coverage, vertical deliveries and foundation. If the spec is a part of a master-plan stage in deliveries mode, each `E<n>` must exist in parts.json (`master-delivery-unmapped`, error) and its target must match prTarget (`master-target-mismatch`, warning). Previous-format specs only emit warnings.",
      "Exit codes: 0 no findings or warnings only, 2 error findings, 1 invalid config or missing tasks.md (`classify` also exits 1 when deliveries exceed maxPrsPerSpec).",
      "It is read-only: it never runs the acceptance commands or opens PRs.",
    ],
  },
  handoff: {
    id: "handoff",
    title: "handoff",
    summary:
      "Validates the implementer's handoff before the orchestrator dispatches the next role.",
    usage:
      "navori handoff <check|log-review> <feature> [--for scribe] [--dir <path>] [--cwd <checkout>] [--json]",
    flags: [
      {
        flag: "--for scribe",
        desc: "Beyond exists/parse/feature, also requires --cwd to match the handoff's worktree and branch, and validates every markdownRequests[].path. Without this flag it only checks what the orchestrator needs (exists, parses, belongs to the requested feature).",
      },
      { flag: "--dir <path>", desc: "Progress directory; defaults to .claude/progress." },
      {
        flag: "--cwd <checkout>",
        desc: "Checkout to validate; defaults to the current directory.",
      },
      { flag: "--json", desc: "Emit the machine-readable contract." },
    ],
    example: [
      {
        title: "Before dispatching the scribe or the reviewer",
        code: "navori handoff check checkout --json",
      },
      {
        title: "The scribe's preflight before writing or committing",
        code: "navori handoff check checkout --for scribe --cwd <checkout> --json",
      },
    ],
    notes: [
      "The JSON carries `status` (ok/findings/error), `failures` and `warnings` with a `check` named after the rule (exists/parse/feature/worktree/branch/path for failures; head/legacy-md for warnings), and the `worktree`/`branch` the handoff registered.",
      "Exit codes match `receipt`: 0 ok, 2 findings (a check failed), 1 error (git or I/O, never a validation failure).",
      "`log-review <feature>` validates review_<feature>.json and appends findings with score >= 50 to findings.jsonl, skipping ones already recorded. It accepts --dir, --cwd and --json; it exits 1 when the sidecar is invalid.",
      "A missing `head` in the handoff still returns `ok`, only with a warning — it never blocks.",
      "With `harness.scribeOwnsMarkdown: false` it validates `impl_<feature>.md` instead (exists, not empty, has a `Status:` line), tied to the feature only by the file name.",
    ],
  },
  master: {
    id: "master",
    title: "master",
    summary: "Project master plan: manages stages, phases, parts, and closure (spec 0034).",
    usage:
      "navori master <init|mode|ux|status|check|advance|part|template|close|delivery-*> [options] [--cwd <path>]",
    flags: [
      {
        flag: "<slug>",
        desc: "kebab-case slug for the first stage (init); required only when no stage is active.",
      },
      {
        flag: "<template|en-curso>",
        desc: "The stage's mode (mode). Can only be set in phase 'context' and only for the first stage — from stage 2 onward the mode is registered as 'en-curso' automatically.",
      },
      {
        flag: "ux <none|md|md-json>",
        desc: "Records the stage's UX contract decision. It can only be set in phase 'ux' and is not available for deliveries mode yet.",
      },
      {
        flag: "delivery-slice --part <P<n>> [--refresh --approved-by user]",
        desc: "Projects an authorized part into a workplan. --refresh resets pending criteria and requires --approved-by user.",
      },
      {
        flag: "delivery-queue --delivery <E<n>> --parts <P1,P2> --approved-by user [--transition replacement|continuation]",
        desc: "Authorizes a bounded queue of parts for a delivery; the parts are validated against parts.json.",
      },
      {
        flag: "delivery-check | delivery-baseline --approved-by user | delivery-revoke --approved-by user",
        desc: "Checks without writing whether preparation is ready (exit 1 with blockers), records the explicit baseline approval, or revokes the queue authority.",
      },
      {
        flag: "delivery-criterion --part <P<n>> --criterion <A<n>> [--approved-by user]",
        desc: "Consumes host evidence or, for manual criteria only, an explicit attestation (--approved-by user).",
      },
      {
        flag: "delivery-review --part <P<n>> --report <file> --envelope <file> [--approved-by user]",
        desc: "Records the operator-attested technical review; the CLI verifies content and receipt, not the reviewer's identity or QA execution.",
      },
      {
        flag: "delivery-present --delivery <E<n>>",
        desc: "Records the identity of a demo that is already technically reviewed; it is not client consent.",
      },
      {
        flag: "delivery-decision --delivery <E<n>> --identity <id> --decision <accepted|declined|deferred|discarded> [--reason <text>] [--reference <ref>] --approved-by user",
        desc: "Records the client's decision on a reviewed identity; any decision other than accepted requires --reason.",
      },
      {
        flag: "delivery-publication --delivery <E<n>> --identity <id> --kind <release|deploy> --reference <ref> --approved-by user",
        desc: "Attests the release or deploy reference of an accepted identity without running the deployment (a merge does not count).",
      },
      {
        flag: "status [--json|--line]",
        desc: "Shows the current stage and phase; without options, regenerates STATUS.md. --json and --line are read-only.",
      },
      {
        flag: "check [--stage <NN-slug>|--part <P<n>>|--fit [--json]]",
        desc: "Validates the active phase exit, a closed stage, a part spec, or the verifiable single-spec fit criteria.",
      },
      {
        flag: "advance",
        desc: "Validates the active phase and advances when its requirements are met.",
      },
      {
        flag: "part <P<n>> [--state <state>] [--reason <text>] [--spec <path>] [--issue <n>]",
        desc: "Updates a part; --accept, --command, --result, and --approved-by record acceptance evidence.",
      },
      {
        flag: "template <name> [--part <P<n>>]",
        desc: "Prints a template; --part fills the issue template from parts.json.",
      },
      {
        flag: "close [--convert <path>|--abandon] [--reason <text>]",
        desc: "Closes, converts, or abandons the active stage; closed stages are read-only.",
      },
      { flag: "--cwd <path>", desc: "Repo to operate on; defaults to the current directory." },
    ],
    example: [
      {
        title: "Open the first stage",
        code: "$ navori master init mvp\nStage 01-mvp · phase context\nSignal: commits=3 firstCommit=2026-08-01 filesChanged=12 framework=next suggested=template",
      },
      {
        title: "Register the mode after reviewing the signal",
        code: "navori master mode template",
      },
    ],
    notes: [
      "init creates <sdd.specsDir>/_master/<NN>-<slug>/ with context/raw/ (its own .gitignore, out of git regardless of gitignoreHarness), context/md/ and plans/, turns on harness.masterPlan and applies the render.",
      "With a stage already active, init (with or without a slug) does not create a second one: it completes whatever the active one is missing, reports its stage and phase, and exits 1 if a slug was passed.",
      "Fails when sdd.enabled is false, naming the key to turn on.",
      "check --stage inspects closed stages; state-changing operations act only on the active stage.",
      "The delivery-* subcommands belong to deliveries mode: they validate parts against parts.json and every approval requires --approved-by user. The master-accept-confirm hook asks a human to confirm before an acceptance is recorded; an agent cannot approve itself.",
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
  "codex",
  "audit",
  "backup",
  "migrations",
  "registry",
  "workspace",
  "ticket",
  "dominio",
  "tools",
  "global",
  "receipt",
  "plan",
  "spec",
  "handoff",
  "master",
] as const;
