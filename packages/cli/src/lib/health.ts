import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadPlugin, PluginNotFoundError, PluginManifestError } from "./plugins.ts";
import { readBundledCoreVersion } from "./bundled-assets.ts";
import { computeManagedHash, extractManagedContent } from "./marker.ts";
import type { NavoriConfig } from "./config.ts";

/**
 * Shared health-check logic for `doctor` (verbose) and `status` (concise) —
 * spec 0003 §3.5.3. Pure: reads the repo, never writes or exits.
 */

export interface MarkerInfo {
  id: string;
  hash: string | null;
  version: string | null;
  source: string | null;
}

/** Parse navori managed-marker metadata out of a markdown file. */
export function listMarkers(filePath: string): MarkerInfo[] {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, "utf-8");
  const re = /<!-- navori:managed [^>]*-->/g;
  const result: MarkerInfo[] = [];
  for (const match of content.matchAll(re)) {
    const tag = match[0];
    if (tag.startsWith("<!-- /navori:managed")) continue;
    const id = tag.match(/id="([^"]+)"/)?.[1] ?? "?";
    const hash = tag.match(/hash="([^"]+)"/)?.[1] ?? null;
    const version = tag.match(/version="([^"]+)"/)?.[1] ?? null;
    const source = tag.match(/source="([^"]+)"/)?.[1] ?? null;
    result.push({ id, hash, version, source });
  }
  return result;
}

export interface MissingPlugin {
  id: string;
  reason: string;
}

/** Plugins enabled in config that can't be loaded (unknown id / bad manifest). */
export function collectMissingPlugins(config: NavoriConfig): MissingPlugin[] {
  const missing: MissingPlugin[] = [];
  for (const [id, settings] of Object.entries(config.plugins ?? {})) {
    if (settings.enabled !== true) continue;
    try {
      loadPlugin(id);
    } catch (err) {
      if (err instanceof PluginNotFoundError) {
        missing.push({ id, reason: "unknown plugin id" });
      } else if (err instanceof PluginManifestError) {
        missing.push({ id, reason: err.message });
      } else {
        missing.push({ id, reason: (err as Error).message });
      }
    }
  }
  return missing;
}

export interface DriftReport {
  /** Repo-relative path of the file with the drifted marker. */
  filePath: string;
  markerId: string;
  source: string;
  /** "version" — the bundle moved ahead. "content" — the body of the
   * managed block no longer matches its `hash=` attribute, i.e. the user
   * edited inside the marker. */
  kind: "version" | "content";
  fromVersion?: string;
  toVersion?: string;
  expectedHash?: string;
  actualHash?: string;
}

/**
 * Walk `.claude/agents/` and `.claude/skills/` and report drift for each
 * managed marker found:
 *   - **version drift** — the marker's `version=` is older than the bundle's.
 *   - **content drift** — the body no longer hashes to its `hash=` attr,
 *     i.e. hand-edited. `navori sync` surfaces this as a conflict.
 * Markers without `version=`/`hash=` or with unknown sources are skipped.
 */
export function scanManagedDrift(cwd: string, config: NavoriConfig): DriftReport[] {
  const out: DriftReport[] = [];
  const coreVersion = readBundledCoreVersion();
  const pluginVersions = new Map<string, string>();
  for (const [id, settings] of Object.entries(config.plugins ?? {})) {
    if (settings.enabled !== true) continue;
    try {
      const plugin = loadPlugin(id);
      pluginVersions.set(`@navori/plugin-${id}`, plugin.manifest.version);
    } catch {
      // unknown / broken plugin — reported elsewhere via missingPlugins
    }
  }

  // Scan CLAUDE.md too, not just .claude/. Its managed blocks (idioma-rol,
  // formato-respuesta, plugin protocols, …) drift the same way; omitting it made
  // `doctor`/`status` report drift:0 while `render`/`sync` saw the same
  // hand-edited block as a conflict.
  const files: string[] = [];
  if (existsSync(join(cwd, "CLAUDE.md"))) files.push("CLAUDE.md");
  for (const dir of [".claude/agents", ".claude/skills"]) {
    const absDir = join(cwd, dir);
    if (!existsSync(absDir)) continue;
    try {
      for (const file of readdirSync(absDir)) {
        if (file.endsWith(".md")) files.push(`${dir}/${file}`);
      }
    } catch {
      continue;
    }
  }

  for (const rel of files) {
    const abs = join(cwd, rel);
    const fileContent = (() => {
      try {
        return readFileSync(abs, "utf-8");
      } catch {
        return null;
      }
    })();
    const markers = listMarkers(abs);

    for (const m of markers) {
      if (!m.source) continue;

      if (m.version) {
        const expected =
          m.source === "@navori/core" ? coreVersion : pluginVersions.get(m.source);
        if (expected && expected !== m.version) {
          out.push({
            filePath: rel,
            markerId: m.id,
            source: m.source,
            kind: "version",
            fromVersion: m.version,
            toVersion: expected,
          });
        }
      }

      if (m.hash && fileContent !== null) {
        const body = extractManagedContent(fileContent, m.id, "html");
        if (body !== null) {
          const actual = computeManagedHash(body);
          if (actual !== m.hash) {
            out.push({
              filePath: rel,
              markerId: m.id,
              source: m.source,
              kind: "content",
              expectedHash: m.hash,
              actualHash: actual,
            });
          }
        }
      }
    }
  }
  return out;
}

export interface HealthState {
  claudeMdExists: boolean;
  missingPlugins: MissingPlugin[];
  drifts: DriftReport[];
}

/**
 * Derive the suggested next actions from the current health state. Used by
 * `status` (and as the footer of `doctor`) to answer "what should I do now?".
 */
export function suggestNextSteps(state: HealthState): string[] {
  const steps: string[] = [];
  if (!state.claudeMdExists) {
    steps.push("Corré 'navori render --apply' para generar CLAUDE.md + .claude/.");
  }
  if (state.missingPlugins.length > 0) {
    steps.push(
      `Resolvé ${state.missingPlugins.length} plugin(s) faltante(s): instalalos o quitalos del config.`,
    );
  }
  if (state.drifts.some((d) => d.kind === "content")) {
    steps.push("Corré 'navori sync --interactive' para resolver bloques editados a mano.");
  }
  if (state.drifts.some((d) => d.kind === "version")) {
    steps.push("Corré 'navori render --apply' para traer los bloques a la última versión.");
  }
  if (steps.length === 0) {
    steps.push("Todo al día — sin acciones pendientes.");
  }
  return steps;
}
