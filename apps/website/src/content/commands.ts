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
};

export const commandDocs: Record<Lang, Record<string, CommandDoc>> = { es, en };

export const commandOrder = [
  "init",
  "add",
  "preset",
  "render",
  "sync",
  "doctor",
  "status",
  "bench",
  "global",
] as const;
