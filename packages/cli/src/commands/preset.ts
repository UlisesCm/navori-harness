import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeFileAtomic } from "../lib/atomic.ts";
import { readConfig, writeConfig } from "../lib/config.ts";
import { brand, accent, dim } from "../lib/style.ts";
import { tc, resolveLang, DEFAULT_LANG, type Lang } from "../lib/i18n.ts";
import { schemaUrl } from "../lib/schema-url.ts";

/** Mirrors PresetDefinitionSchema.id — kebab-case, alphanumeric start. */
const PRESET_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Locale for preset scaffolding output + templates: the repo's config.language
 * when a config already exists, else the default. Tolerant of a malformed config
 * (a broken file shouldn't hard-fail `preset init`).
 */
function repoLang(configPath: string): Lang {
  if (!existsSync(configPath)) return DEFAULT_LANG;
  try {
    return resolveLang(readConfig(configPath).language);
  } catch {
    return DEFAULT_LANG;
  }
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
    const configPath = join(cwd, "navori.config.json");
    const tr = tc(repoLang(configPath)).preset;

    p.intro(brand(`preset init ${accent(id)}`));

    if (id === "custom") {
      p.cancel(tr.reservedId);
      process.exit(1);
    }
    if (!PRESET_ID_RE.test(id)) {
      p.cancel(tr.invalidId(id));
      process.exit(1);
    }

    const presetDir = resolve(cwd, ".navori/presets", id);
    if (existsSync(presetDir)) {
      p.cancel(tr.alreadyExists(id));
      process.exit(1);
    }

    const skillId = `${id}-example`;
    // relPath are relative to the preset folder (its asset root), not core-assets.
    const manifest = {
      $schema: schemaUrl("navori.preset.v1.json"),
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
    writeFileAtomic(join(presetDir, "managed", "stack.md"), tr.stackTemplate(id));
    writeFileAtomic(join(presetDir, "skills", `${skillId}.md`), tr.skillTemplate(skillId));

    p.log.success(tr.created(id));
    p.log.message(
      [
        `  ${dim("·")} ${id}.json`,
        `  ${dim("·")} managed/stack.md`,
        `  ${dim("·")} skills/${skillId}.md`,
      ].join("\n"),
    );

    if (existsSync(configPath)) {
      const config = readConfig(configPath);
      writeConfig(configPath, { ...config, preset: id });
      p.log.success(tr.configSet(accent(id)));
      p.outro(tr.doneEdit(accent("navori render --apply")));
    } else {
      p.log.warn(tr.noConfig(cwd, id, accent("navori init")));
      p.outro(tr.doneScaffold);
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
