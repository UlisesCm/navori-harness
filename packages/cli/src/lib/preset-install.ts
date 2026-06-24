import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, cpSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { createTmpDir } from "./atomic.ts";
import { PresetDefinitionSchema, PresetError } from "./presets.ts";

const NPM_PACK_TIMEOUT_MS = 120_000;

export interface InstalledPreset {
  id: string;
}

/**
 * Fetch a remote preset and materialize it into `.navori/presets/<id>/`, where
 * Fase 2's local resolution (resolvePreset/loadPreset) picks it up unchanged.
 *
 * `source` is anything `npm pack` accepts: an npm package name
 * (`@acme/preset-fastify`), a local path (`./packages/preset-x`), a tarball URL
 * or a git url. The preset id comes from the package's manifest, not its name.
 *
 * Publishing convention: the package root holds a `preset.json` (same schema as
 * a local preset) plus its asset folders (managed/skills/agents/hooks) with
 * short relPath. The npm `package.json` is metadata and is ignored.
 *
 * All work happens in a temp dir; `.navori/` is only touched once everything
 * validates, so a bad package never leaves a half-written preset behind.
 */
export function installRemotePreset(
  source: string,
  repoRoot: string,
  options: { force?: boolean } = {},
): InstalledPreset {
  const tmp = createTmpDir("navori-preset-add-");
  try {
    // 1. npm pack → a .tgz inside tmp (no install into node_modules).
    const pack = spawnSync("npm", ["pack", source, "--pack-destination", tmp, "--silent"], {
      encoding: "utf-8",
      timeout: NPM_PACK_TIMEOUT_MS,
    });
    if (pack.error && (pack.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      throw new PresetError(
        `'npm pack ${source}' timed out after ${NPM_PACK_TIMEOUT_MS / 1000}s.`,
      );
    }
    if (pack.error && (pack.error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new PresetError("'npm' not found on PATH — npm is required for 'preset add'.");
    }
    if (pack.status !== 0) {
      throw new PresetError(
        `'npm pack ${source}' failed (exit ${pack.status}): ${(pack.stderr ?? "").trim()}`,
      );
    }
    const tgz = readdirSync(tmp).find((f) => f.endsWith(".tgz"));
    if (!tgz) throw new PresetError(`npm pack produced no tarball for '${source}'.`);

    // 2. Extract. npm tarballs nest everything under `package/`.
    const extractDir = join(tmp, "extracted");
    mkdirSync(extractDir, { recursive: true });
    const untar = spawnSync("tar", ["-xzf", join(tmp, tgz), "-C", extractDir], {
      encoding: "utf-8",
    });
    if (untar.error && (untar.error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new PresetError("'tar' not found on PATH — tar is required for 'preset add'.");
    }
    if (untar.status !== 0) {
      throw new PresetError(`Failed to extract '${tgz}': ${(untar.stderr ?? "").trim()}`);
    }
    const nested = join(extractDir, "package");
    const pkgRoot = existsSync(nested) ? nested : extractDir;

    // 3. Read + validate the manifest (same schema as a local preset).
    const manifestPath = join(pkgRoot, "preset.json");
    if (!existsSync(manifestPath)) {
      throw new PresetError(
        `'${source}' is not a navori preset: no preset.json at the package root.`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(manifestPath, "utf-8").replace(/^﻿/, ""));
    } catch (err) {
      throw new PresetError(`Invalid JSON in preset.json of '${source}': ${(err as Error).message}`);
    }
    const result = PresetDefinitionSchema.safeParse(parsed);
    if (!result.success) {
      throw new PresetError(`Invalid preset.json in '${source}'`, result.error.issues);
    }
    const def = result.data;
    if (def.id === "custom") {
      throw new PresetError("'custom' is a reserved preset id; the package must declare another id.");
    }

    // 4. Every declared extra must ship an actual file, or the preset is broken.
    const { managed, agents, skills, hooks } = def.extras;
    for (const e of [...managed, ...agents, ...skills, ...hooks]) {
      if (!existsSync(resolve(pkgRoot, e.relPath))) {
        throw new PresetError(
          `Preset '${def.id}' references '${e.relPath}' but the package has no such file.`,
        );
      }
    }

    // 5. Materialize into .navori/presets/<id>/ (checked-in; Fase 2 resolves it).
    const destDir = resolve(repoRoot, ".navori/presets", def.id);
    if (existsSync(destDir)) {
      if (!options.force) {
        throw new PresetError(
          `.navori/presets/${def.id}/ already exists — use --force to overwrite (e.g. to update it).`,
        );
      }
      rmSync(destDir, { recursive: true, force: true });
    }
    mkdirSync(destDir, { recursive: true });
    for (const entry of readdirSync(pkgRoot)) {
      // Drop npm metadata; the manifest is copied separately as <id>.json.
      if (entry === "package.json" || entry === "preset.json") continue;
      cpSync(join(pkgRoot, entry), join(destDir, entry), { recursive: true });
    }
    // preset.json → <id>.json so resolvePreset finds it at <id>/<id>.json.
    cpSync(manifestPath, join(destDir, `${def.id}.json`));

    return { id: def.id };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
