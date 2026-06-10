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
      "Inicializa un repo con navori. Detecta el stack, hace 4 preguntas y deja todo listo en un minuto.",
    usage: "navori-ai init [--preset <name>] [--engines <list>] [--yes]",
    flags: [
      { flag: "--preset <name>", desc: "Preset a usar: pnpm-monorepo, nextjs, nestjs, custom." },
      { flag: "--engines <list>", desc: "Lista separada por comas: claude,cursor,copilot,agents-md." },
      { flag: "--yes, -y", desc: "Acepta los defaults sin preguntar (CI-friendly)." },
      { flag: "--cwd <path>", desc: "Directorio de trabajo. Default: directorio actual." },
    ],
    example: [
      {
        title: "Interactivo",
        code: "$ npx navori-ai init\n? Project name › my-app\n? Engines › claude, cursor, agents-md\n? Preset › pnpm-monorepo\n✓ navori.config.json written\n✓ 14 managed files rendered",
      },
      {
        title: "Sin prompts (CI)",
        code: "npx navori-ai init --yes \\\n  --preset pnpm-monorepo \\\n  --engines claude,cursor",
      },
    ],
    notes: [
      "Si ya existe un .claude/ hecho a mano, init coexiste: solo agrega los bloques con marcadores managed.",
      "El archivo navori.config.json es la fuente de verdad. Commitealo al repo.",
    ],
  },
  add: {
    id: "add",
    title: "add",
    summary:
      "Agrega un plugin al proyecto. Resuelve dependencias automáticamente.",
    usage: "navori-ai add <plugin> [--dry-run]",
    flags: [
      { flag: "<plugin>", desc: "Nombre del plugin: engram, semgrep, jscpd, acli, gh, cognitive." },
      { flag: "--dry-run", desc: "Muestra qué cambiaría sin escribir." },
    ],
    example: [
      {
        title: "Agregar engram",
        code: "$ navori-ai add engram\n→ resolving dependencies\n  ✓ engram@0.4.2\n  ✓ requires: settings.json patch\n  ✓ requires: skill engram-protocol\n✓ plugin engram added · rerun render",
      },
    ],
    notes: [
      "add solo modifica navori.config.json. Después tienes que correr render para aplicar.",
    ],
  },
  render: {
    id: "render",
    title: "render",
    summary:
      "Reconstruye todos los assets managed desde navori.config.json. Idempotente.",
    usage: "navori-ai render [--engine <name>] [--check]",
    flags: [
      { flag: "--engine <name>", desc: "Renderiza solo para un engine." },
      { flag: "--check", desc: "Verifica que el output coincida con lo esperado sin escribir (CI)." },
    ],
    example: [
      {
        title: "Render completo",
        code: "$ navori-ai render\n→ resolving 5 layers\n→ writing managed blocks\n  ✓ .claude/  ·  9 files\n  ✓ .cursor/  ·  3 files\n  ✓ AGENTS.md\n✓ Done in 0.9s",
      },
    ],
    notes: [
      "render sobrescribe los bloques managed. El código entre marcadores managed se reemplaza por completo.",
      "Para no perder ediciones manuales, usá sync en vez de render.",
    ],
  },
  sync: {
    id: "sync",
    title: "sync",
    summary:
      "Actualiza solo los bloques managed. Preserva tu código personalizado intacto.",
    usage: "navori-ai sync [--force]",
    flags: [
      { flag: "--force", desc: "Reconcilia drift sobrescribiendo. Usar con cuidado." },
    ],
    example: [
      {
        title: "Sync seguro",
        code: "$ navori-ai sync\n→ checking managed markers\n  · 12 unchanged\n  ↑ 2 updated  (.claude/agents/leader.md, AGENTS.md)\n  ! 0 conflicts\n✓ Custom code preserved",
      },
    ],
    notes: [
      "sync es el comando recomendado para upgrades de versión. render es solo para regenerar from scratch.",
    ],
  },
  doctor: {
    id: "doctor",
    title: "doctor",
    summary:
      "Diagnóstico del proyecto: schema, plugins, drift y conflictos entre engines.",
    usage: "navori-ai doctor [--json]",
    flags: [
      { flag: "--json", desc: "Output estructurado para CI." },
    ],
    example: [
      {
        title: "Diagnóstico",
        code: "$ navori-ai doctor\n✓ config schema valid\n✓ all plugins resolvable\n✓ no engine conflicts\n! drift: .cursor/rules/navori.mdc edited outside markers\n→ run `navori-ai sync --force` to reconcile",
      },
    ],
    notes: [
      "Corre doctor en CI con --json para fallar el build si hay drift no resuelto.",
    ],
  },
};

const en: Record<string, CommandDoc> = {
  init: {
    id: "init",
    title: "init",
    summary:
      "Bootstrap a repo with navori. Detects the stack, asks 4 questions, and leaves everything ready in a minute.",
    usage: "navori-ai init [--preset <name>] [--engines <list>] [--yes]",
    flags: [
      { flag: "--preset <name>", desc: "Preset to use: pnpm-monorepo, nextjs, nestjs, custom." },
      { flag: "--engines <list>", desc: "Comma-separated list: claude,cursor,copilot,agents-md." },
      { flag: "--yes, -y", desc: "Accept defaults without prompting (CI-friendly)." },
      { flag: "--cwd <path>", desc: "Working directory. Default: current directory." },
    ],
    example: [
      {
        title: "Interactive",
        code: "$ npx navori-ai init\n? Project name › my-app\n? Engines › claude, cursor, agents-md\n? Preset › pnpm-monorepo\n✓ navori.config.json written\n✓ 14 managed files rendered",
      },
      {
        title: "Non-interactive (CI)",
        code: "npx navori-ai init --yes \\\n  --preset pnpm-monorepo \\\n  --engines claude,cursor",
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
    summary: "Add a plugin to the project. Resolves dependencies automatically.",
    usage: "navori-ai add <plugin> [--dry-run]",
    flags: [
      { flag: "<plugin>", desc: "Plugin name: engram, semgrep, jscpd, acli, gh, cognitive." },
      { flag: "--dry-run", desc: "Print what would change without writing." },
    ],
    example: [
      {
        title: "Add engram",
        code: "$ navori-ai add engram\n→ resolving dependencies\n  ✓ engram@0.4.2\n  ✓ requires: settings.json patch\n  ✓ requires: skill engram-protocol\n✓ plugin engram added · rerun render",
      },
    ],
    notes: [
      "add only updates navori.config.json. You still need to run render to apply.",
    ],
  },
  render: {
    id: "render",
    title: "render",
    summary:
      "Rebuilds every managed asset from navori.config.json. Idempotent.",
    usage: "navori-ai render [--engine <name>] [--check]",
    flags: [
      { flag: "--engine <name>", desc: "Render only for one engine." },
      { flag: "--check", desc: "Verify the output matches expectations without writing (CI)." },
    ],
    example: [
      {
        title: "Full render",
        code: "$ navori-ai render\n→ resolving 5 layers\n→ writing managed blocks\n  ✓ .claude/  ·  9 files\n  ✓ .cursor/  ·  3 files\n  ✓ AGENTS.md\n✓ Done in 0.9s",
      },
    ],
    notes: [
      "render overwrites managed blocks. Code between managed markers is fully replaced.",
      "To keep manual edits, use sync instead.",
    ],
  },
  sync: {
    id: "sync",
    title: "sync",
    summary:
      "Updates only managed blocks. Your custom code is preserved untouched.",
    usage: "navori-ai sync [--force]",
    flags: [
      { flag: "--force", desc: "Reconcile drift by overwriting. Use with care." },
    ],
    example: [
      {
        title: "Safe sync",
        code: "$ navori-ai sync\n→ checking managed markers\n  · 12 unchanged\n  ↑ 2 updated  (.claude/agents/leader.md, AGENTS.md)\n  ! 0 conflicts\n✓ Custom code preserved",
      },
    ],
    notes: [
      "sync is the recommended command for version upgrades. render is only for regenerating from scratch.",
    ],
  },
  doctor: {
    id: "doctor",
    title: "doctor",
    summary:
      "Project diagnostics: schema, plugins, drift and cross-engine conflicts.",
    usage: "navori-ai doctor [--json]",
    flags: [
      { flag: "--json", desc: "Structured output for CI." },
    ],
    example: [
      {
        title: "Diagnose",
        code: "$ navori-ai doctor\n✓ config schema valid\n✓ all plugins resolvable\n✓ no engine conflicts\n! drift: .cursor/rules/navori.mdc edited outside markers\n→ run `navori-ai sync --force` to reconcile",
      },
    ],
    notes: [
      "Run doctor in CI with --json to fail the build if there's unresolved drift.",
    ],
  },
};

export const commandDocs: Record<Lang, Record<string, CommandDoc>> = { es, en };

export const commandOrder = ["init", "add", "render", "sync", "doctor"] as const;
