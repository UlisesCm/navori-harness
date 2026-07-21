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
      { flag: "--full", desc: "Modo máximo: --recommended + todos los plugins + pre-commit hook + scan-monorepo + project block estricto (posture/reviewRigor/testsForNewCode)." },
      { flag: "--recommended", desc: "Modo opinado: --yes + habilita plugins recomendados (engram, +gh si es repo GitHub)." },
      { flag: "--yes, -y", desc: "Acepta todo lo detectado sin preguntar (CI-friendly)." },
      { flag: "--lang <es|en>", desc: "Idioma del wizard. Default: es." },
      { flag: "--scan-monorepo", desc: "Si detecta un monorepo, escanea los workspaces y les asigna un preset." },
      { flag: "--pre-commit-hook", desc: "Opt-in: scaffolda un pre-commit hook que corre 'navori doctor --strict'." },
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
    summary:
      "Registra un plugin en navori.config.json, o sugiere qué agregar según tu stack.",
    usage: "navori add <plugin> | navori add --suggest",
    flags: [
      { flag: "<plugin>", desc: "Plugin a registrar: engram, semgrep, jscpd, acli, gh, cognitive." },
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
      { flag: "<id>", desc: "Id del preset (kebab-case). Rechaza el id reservado 'custom' y los que no son kebab-case." },
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
      "Reconstruye CLAUDE.md y .claude/ desde navori.config.json. Idempotente. Preview por default.",
    usage: "navori render [--apply] [--force] [--workspace <name>]",
    flags: [
      { flag: "--apply", desc: "Escribe a disco. Sin el flag, render solo hace preview (no toca archivos)." },
      { flag: "--force", desc: "Regenera settings.json aunque esté corrupto o sin el marcador $navori (respalda el previo)." },
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
    summary:
      "Trae cambios del bundle a los bloques managed. Tu código fuera de los markers nunca se pisa.",
    usage: "navori sync [--interactive] [--apply] [--workspace <name>]",
    flags: [
      { flag: "--interactive", desc: "Resuelve cada conflicto de CLAUDE.md uno por uno: ves el diff y eliges keep-mine o accept-new." },
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
    summary:
      "Audit del proyecto: config, plugins, drift, invariants y próximos pasos sugeridos.",
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
    flags: [
      { flag: "--json", desc: "Output estructurado (pipeable)." },
    ],
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
    flags: [
      { flag: "--runs <n>", desc: "Número de iteraciones. Default: 20." },
    ],
    example: [
      {
        title: "Benchmark",
        code: "$ navori bench --runs 20\nrender (dry-run)\n  min  1.1ms\n  p50  1.3ms\n  p95  1.6ms",
      },
    ],
    notes: [
      "Complementa NAVORI_BENCH=1, que instrumenta los tiempos de una sola corrida.",
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
      { flag: "--full", desc: "Maximal mode: --recommended + all plugins + pre-commit hook + monorepo scan + strict project block (posture/reviewRigor/testsForNewCode)." },
      { flag: "--recommended", desc: "Opinionated mode: --yes + auto-enable recommended plugins (engram, +gh on GitHub repos)." },
      { flag: "--yes, -y", desc: "Accept everything detected without prompting (CI-friendly)." },
      { flag: "--lang <es|en>", desc: "Wizard language. Default: es." },
      { flag: "--scan-monorepo", desc: "If a monorepo is detected, scan its workspaces and assign a preset to each." },
      { flag: "--pre-commit-hook", desc: "Opt-in: scaffold a pre-commit hook that runs 'navori doctor --strict'." },
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
      { flag: "<plugin>", desc: "Plugin to register: engram, semgrep, jscpd, acli, gh, cognitive." },
      { flag: "--suggest", desc: "Detect the stack and suggest a preset + plugins (installs nothing)." },
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
    notes: [
      "add only updates navori.config.json. Then run 'navori render --apply' to apply.",
    ],
  },
  preset: {
    id: "preset",
    title: "preset",
    summary:
      "Scaffolds a local preset under .navori/presets/ for when your stack has no official preset.",
    usage: "navori preset init <id>",
    flags: [
      { flag: "<id>", desc: "Preset id (kebab-case). Rejects the reserved id 'custom' and non-kebab-case ids." },
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
      "Rebuilds CLAUDE.md and .claude/ from navori.config.json. Idempotent. Preview by default.",
    usage: "navori render [--apply] [--force] [--workspace <name>]",
    flags: [
      { flag: "--apply", desc: "Write to disk. Without it, render only previews (no files touched)." },
      { flag: "--force", desc: "Regenerate settings.json even if corrupted or missing the $navori marker (backs up the previous one)." },
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
    summary:
      "Pulls bundle changes into the managed blocks. Your code outside the markers is never overwritten.",
    usage: "navori sync [--interactive] [--apply] [--workspace <name>]",
    flags: [
      { flag: "--interactive", desc: "Resolve each CLAUDE.md conflict one by one: see the diff and pick keep-mine or accept-new." },
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
    summary:
      "Project audit: config, plugins, drift, invariants and suggested next steps.",
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
    flags: [
      { flag: "--json", desc: "Structured output (pipeable)." },
    ],
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
    flags: [
      { flag: "--runs <n>", desc: "Number of iterations. Default: 20." },
    ],
    example: [
      {
        title: "Benchmark",
        code: "$ navori bench --runs 20\nrender (dry-run)\n  min  1.1ms\n  p50  1.3ms\n  p95  1.6ms",
      },
    ],
    notes: [
      "Complements NAVORI_BENCH=1, which instruments the timings of a single run.",
    ],
  },
};

export const commandDocs: Record<Lang, Record<string, CommandDoc>> = { es, en };

export const commandOrder = ["init", "add", "preset", "render", "sync", "doctor", "status", "bench"] as const;
