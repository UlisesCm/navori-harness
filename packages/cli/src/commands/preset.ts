import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeFileAtomic } from "../lib/atomic.ts";
import { readConfig, writeConfig } from "../lib/config.ts";
import { brand, accent, dim } from "../lib/style.ts";

/** Mirrors PresetDefinitionSchema.id — kebab-case, alphanumeric start. */
const PRESET_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Placeholder stack context the user fills in; rendered as a managed block. */
function stackTemplate(id: string): string {
  return [
    `## Stack — ${id}`,
    "",
    "> Plantilla generada por `navori preset init`. Edítala: describe el stack,",
    "> las capas por las que fluye una petición/feature, y las reglas de oro que",
    "> el código nuevo debe seguir. Este bloque se inyecta en CLAUDE.md.",
    "",
    "### Qué es",
    "",
    "Describe en 1-2 líneas qué hace este proyecto y sobre qué stack corre.",
    "",
    "### Reglas",
    "",
    "- Regla de oro 1 (p.ej. validación siempre en el boundary).",
    "- Regla de oro 2 (p.ej. nada de `console.log`; usa el logger).",
    "",
    "Aplica las skills de este preset según la capa que toques.",
    "",
  ].join("\n");
}

/** Example skill so the user sees the shape; navori renders it to .claude/skills/. */
function skillTemplate(skillId: string): string {
  return [
    "---",
    `name: ${skillId}`,
    `description: Skill de ejemplo del preset. Reemplaza esta descripción por cuándo aplicarla (el frontmatter es lo que los agentes leen para descubrirla).`,
    "type: reference",
    "---",
    "",
    `# ${skillId}`,
    "",
    "## Cuándo usar este skill",
    "",
    "Describe el disparador concreto (qué archivos/capa, qué tarea).",
    "",
    "## Patrón",
    "",
    "Documenta el patrón con un ejemplo mínimo. Borra este skill o renómbralo",
    "cuando agregues los reales en `skills/` y los declares en el manifest.",
    "",
  ].join("\n");
}

const initSubCommand = defineCommand({
  meta: {
    name: "init",
    description: "Scaffold a local preset under .navori/presets/<id>/ and wire it into config",
  },
  args: {
    id: { type: "positional", description: "Preset id (kebab-case)", required: true },
    cwd: { type: "string", description: "Repo root (default: current)" },
  },
  run({ args }) {
    const id = String(args.id);
    const cwd = resolve(args.cwd ?? process.cwd());

    p.intro(brand(`preset init ${accent(id)}`));

    if (id === "custom") {
      p.cancel("'custom' es un id reservado (es el baseline sin extras). Elige otro nombre.");
      process.exit(1);
    }
    if (!PRESET_ID_RE.test(id)) {
      p.cancel(
        `Id inválido '${id}': usa kebab-case — minúsculas, números y guiones, empezando con alfanumérico.`,
      );
      process.exit(1);
    }

    const presetDir = resolve(cwd, ".navori/presets", id);
    if (existsSync(presetDir)) {
      p.cancel(
        `Ya existe .navori/presets/${id}/ — bórralo o usa otro id si quieres regenerarlo.`,
      );
      process.exit(1);
    }

    const skillId = `${id}-example`;
    // relPath are relative to the preset folder (its asset root), not core-assets.
    const manifest = {
      $schema: "https://navori.dev/schema/navori.preset.v1.json",
      id,
      displayName: id,
      extends: "core",
      extras: {
        managed: [{ id: `stack-${id}`, relPath: "managed/stack.md" }],
        agents: [],
        skills: [
          {
            id: skillId,
            relPath: `skills/${skillId}.md`,
            destRelPath: `.claude/skills/${skillId}.md`,
          },
        ],
        hooks: [],
      },
      invariants: [],
    };

    mkdirSync(join(presetDir, "managed"), { recursive: true });
    mkdirSync(join(presetDir, "skills"), { recursive: true });
    writeFileAtomic(join(presetDir, `${id}.json`), JSON.stringify(manifest, null, 2) + "\n");
    writeFileAtomic(join(presetDir, "managed", "stack.md"), stackTemplate(id));
    writeFileAtomic(join(presetDir, "skills", `${skillId}.md`), skillTemplate(skillId));

    p.log.success(`Creado .navori/presets/${id}/`);
    p.log.message(
      [
        `  ${dim("·")} ${id}.json`,
        `  ${dim("·")} managed/stack.md`,
        `  ${dim("·")} skills/${skillId}.md`,
      ].join("\n"),
    );

    const configPath = join(cwd, "navori.config.json");
    if (existsSync(configPath)) {
      const config = readConfig(configPath);
      writeConfig(configPath, { ...config, preset: id });
      p.log.success(`navori.config.json → preset: ${accent(id)}`);
      p.outro(`Listo. Edita la plantilla y corre ${accent("navori render --apply")} para materializarla.`);
    } else {
      p.log.warn(
        `No hay navori.config.json en ${cwd}. Corre ${accent("navori init")} y elige el preset '${id}' para activarlo.`,
      );
      p.outro("Preset local scaffoldeado. Inicializa navori para activarlo.");
    }
  },
});

export const presetCommand = defineCommand({
  meta: {
    name: "preset",
    description: "Manage local presets under .navori/presets/",
  },
  subCommands: {
    init: initSubCommand,
  },
});
