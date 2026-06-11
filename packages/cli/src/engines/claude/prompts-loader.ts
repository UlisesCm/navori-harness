import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { getCoreRoot } from "../../lib/bundled-assets.ts";
import { loadEnabledPlugins, type PluginPromptEntry } from "../../lib/plugins.ts";

/**
 * Aggregate the project-customization prompts shown by the init wizard
 * after the preview-edit loop. Core prompts ship in
 * `@navori/core/core-assets/prompts.json`; each enabled plugin can add
 * extra entries via `plugin.json#prompts[]`.
 *
 * Order: core prompts first (declared order), then plugins (declared
 * order per plugin, plugins in `loadEnabledPlugins` order).
 *
 * Validation: silent skip of malformed entries. We don't want a single
 * busted plugin to kill the whole wizard — surface the error to the
 * caller as a `warnings` string instead.
 */

const CorePromptSchema = z.object({
  key: z.string().regex(/^[a-z][a-zA-Z0-9_.]*$/),
  question: z.object({ es: z.string().min(1), en: z.string().min(1) }),
  type: z.enum(["string", "string-list", "boolean", "number"]),
  placeholder: z.string().optional(),
  optional: z.boolean().default(false),
});

const CorePromptsFileSchema = z.object({
  prompts: z.array(CorePromptSchema),
});

export type LoadedPrompt = z.infer<typeof CorePromptSchema> & {
  source: "core" | string;
};

export interface LoadedPromptsResult {
  prompts: LoadedPrompt[];
  warnings: string[];
}

const CORE_PROMPTS_REL = "core-assets/prompts.json";

export function loadPrompts(
  enabledPlugins: Record<string, { enabled: boolean }> | undefined,
): LoadedPromptsResult {
  const out: LoadedPrompt[] = [];
  const warnings: string[] = [];

  for (const p of loadCorePrompts(warnings)) {
    out.push({ ...p, source: "core" });
  }

  const { loaded } = loadEnabledPlugins(enabledPlugins);
  for (const plugin of loaded) {
    const declared = plugin.manifest.prompts;
    if (!declared || declared.length === 0) continue;
    for (const p of declared as PluginPromptEntry[]) {
      out.push({ ...p, source: plugin.manifest.id });
    }
  }

  return { prompts: out, warnings };
}

function loadCorePrompts(warnings: string[]): LoadedPrompt[] {
  const path = resolve(getCoreRoot(), CORE_PROMPTS_REL);
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    warnings.push(`core prompts.json no parsea: ${(err as Error).message}`);
    return [];
  }
  const result = CorePromptsFileSchema.safeParse(parsed);
  if (!result.success) {
    warnings.push(`core prompts.json no valida el shape esperado`);
    return [];
  }
  return result.data.prompts.map((p) => ({ ...p, source: "core" }));
}
