import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { safeHomedir } from "./home.ts";

/**
 * Machine-local config for the OPTIONAL global harness (Spec 0010). Lives next
 * to the registry and workspaces under `~/.navori/`, and never travels with a
 * repo.
 *
 * ZERO-FOOTPRINT INVARIANT (Spec 0010 §2.4): this file exists ONLY after an
 * explicit `navori global init`. Every repo-scoped command MUST treat its
 * absence as "the global harness does not exist" and change nothing.
 * `readGlobalConfig()` returns null when the file is missing — that null is the
 * gate, and no repo command should ever call into this module.
 */

/**
 * The repo-agnostic core blocks that compose the global baseline by default.
 * Audited (Spec 0010 §4) to carry NO repo-config interpolation, so they render
 * standalone. Array order is the emission order in the baseline.
 */
export const DEFAULT_GLOBAL_BLOCKS = [
  "operaciones-seguras",
  "idioma-rol",
  "formato-respuesta",
] as const;

const GlobalConfigSchema = z.object({
  $schema: z.string().optional(),
  /** CLI version that last wrote this file (drift/migration signal). */
  version: z.string().default("0.0.0"),
  /** Chat language for the global baseline prose. */
  language: z.enum(["es", "en"]).default("es").catch("es"),
  /** Core block ids composing the global baseline, in emission order. */
  blocks: z
    .object({ include: z.array(z.string()).default([...DEFAULT_GLOBAL_BLOCKS]) })
    .default({ include: [...DEFAULT_GLOBAL_BLOCKS] }),
  /** Personal permissions merged additively into `~/.claude/settings.json`. */
  permissions: z
    .object({
      allow: z.array(z.string()).default([]),
      deny: z.array(z.string()).default([]),
      ask: z.array(z.string()).default([]),
    })
    .default({ allow: [], deny: [], ask: [] }),
});

export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;

function navoriRoot(): string {
  return join(safeHomedir(), ".navori");
}

/** Absolute path to `~/.navori/global.json`. */
export function globalConfigPath(): string {
  return join(navoriRoot(), "global.json");
}

/** True iff the global harness has been initialized on this machine. */
export function globalConfigExists(): boolean {
  return existsSync(globalConfigPath());
}

/**
 * Read `~/.navori/global.json`. Returns null when it does not exist — callers
 * use that null as the zero-footprint gate. Throws on a malformed file: unlike
 * the tolerant registry read, an installed-but-corrupt global harness is worth
 * surfacing to the user (only the `navori global *` commands ever read it).
 */
export function readGlobalConfig(): GlobalConfig | null {
  const path = globalConfigPath();
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  return GlobalConfigSchema.parse(parsed);
}

/** Write `~/.navori/global.json` (creates `~/.navori/` if needed). Returns the path. */
export function writeGlobalConfig(config: GlobalConfig): string {
  mkdirSync(navoriRoot(), { recursive: true });
  const path = globalConfigPath();
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return path;
}

/** A fresh default config, stamped with the current CLI version. */
export function defaultGlobalConfig(version: string, language: "es" | "en" = "es"): GlobalConfig {
  return GlobalConfigSchema.parse({ version, language });
}

/** Remove `~/.navori/global.json` if present. Returns true when a file was deleted. */
export function deleteGlobalConfig(): boolean {
  const path = globalConfigPath();
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}
