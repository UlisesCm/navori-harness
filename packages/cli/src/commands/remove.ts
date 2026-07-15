import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeConfig } from "../lib/config.ts";
import { readConfigOrExit } from "../lib/cli-config.ts";
import { runRender } from "./render.ts";
import { brand, accent, dim } from "../lib/style.ts";

/** engram ships with navori and can't be removed (always-on invariant, #68). */
const ENGRAM_ID = "engram";

/** Read the raw config JSON (without $schema) for in-place edits. */
function readRaw(configPath: string): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
  delete raw.$schema;
  return raw;
}

export const removeCommand = defineCommand({
  meta: {
    name: "remove",
    description: "Disable a plugin and clean up its managed blocks, sub-blocks and scripts",
  },
  args: {
    plugin: { type: "positional", description: "Plugin id to remove (e.g. semgrep)", required: true },
    cwd: { type: "string", description: "Directory (default: cwd)" },
    yes: { type: "boolean", description: "Skip confirmation" },
  },
  async run({ args }) {
    const cwd = resolve(args.cwd ?? process.cwd());
    const configPath = join(cwd, "navori.config.json");
    const id = args.plugin as string;

    p.intro(brand(`remove ${accent(id)}`));

    if (!existsSync(configPath)) {
      p.cancel(`No navori.config.json at ${configPath}. Run 'navori init' first.`);
      process.exit(1);
    }
    if (id === ENGRAM_ID) {
      p.cancel("engram es always-on con navori; no se puede quitar.");
      process.exit(1);
    }

    const config = readConfigOrExit(configPath);
    const declared = config.plugins?.[id];
    if (!declared) {
      p.log.info(`Plugin '${id}' no está en el config de este repo; nada que quitar.`);
      p.outro(dim("Done"));
      return;
    }

    if (!args.yes) {
      const ok = await p.confirm({
        message: `Quitar '${id}'? Se desactiva y se limpian sus bloques, sub-bloques y scripts.`,
        initialValue: true,
      });
      if (p.isCancel(ok) || !ok) {
        p.cancel("Aborted");
        return;
      }
    }

    // Phase 1: mark disabled and re-render. The disabled entry is what lets the
    // engine strip the plugin's managed blocks, injectInto sub-blocks and
    // scripts (#80) — deleting the key first would skip that cleanup.
    const raw = readRaw(configPath);
    const plugins = (raw.plugins as Record<string, unknown> | undefined) ?? {};
    plugins[id] = { enabled: false };
    raw.plugins = plugins;
    writeConfig(configPath, raw as Parameters<typeof writeConfig>[1]);

    let result: ReturnType<typeof runRender>;
    try {
      result = runRender(cwd, false);
    } catch (err) {
      p.log.error(err instanceof Error ? err.message : String(err));
      p.outro("La limpieza falló durante el render — el plugin quedó como enabled:false. Corre 'navori render --apply'.");
      return;
    }
    if (!result.ok) {
      p.log.error(result.reason ?? "Render failed");
      p.outro("El plugin quedó como enabled:false pero el render falló.");
      return;
    }

    // Phase 2: prune the key so the config doesn't carry a dangling disabled
    // entry. The artifacts are already cleaned, so a future render is a no-op.
    const raw2 = readRaw(configPath);
    const plugins2 = (raw2.plugins as Record<string, unknown> | undefined) ?? {};
    delete plugins2[id];
    raw2.plugins = plugins2;
    writeConfig(configPath, raw2 as Parameters<typeof writeConfig>[1]);

    p.log.success(`'${id}' quitado y limpiado.`);
    p.outro(dim("Done"));
  },
});
