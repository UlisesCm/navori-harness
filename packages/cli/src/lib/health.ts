import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadPlugin, PluginNotFoundError, PluginManifestError } from "./plugins.ts";
import { readBundledCoreVersion } from "./bundled-assets.ts";
import { computeManagedHash, extractManagedContent, reorderManagedBlocks } from "./marker.ts";
import { canonicalManagedOrder } from "./render-plan.ts";
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
  // AGENTS.md (agents-md engine) carries one managed block with the same html
  // markers + @navori/core source, so it drifts exactly like CLAUDE.md. Omitting
  // it made doctor blind to hand-edits on repos rendering the agents-md engine.
  if (existsSync(join(cwd, "AGENTS.md"))) files.push("AGENTS.md");
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

export interface OrderReport {
  /** Managed-block ids in their current document order. */
  current: string[];
  /** The canonical order those same ids should appear in. */
  expected: string[];
  /** True when reordering is blocked because the user wrote prose between two
   * managed blocks — `render`/`sync` can't auto-fix it, the user must move the
   * text out of the managed region first. */
  interleaved: boolean;
  /** The block that should lead (canonical-first among present blocks, the
   * harness "center of gravity") with its 1-based current position — set only
   * when it isn't already first. Spotlights the common legacy case where
   * `orquestacion` got appended last. null when the lead block is correct. */
  misplacedFirst: { id: string; currentPos: number; total: number } | null;
}

/**
 * Check whether CLAUDE.md's managed blocks are in canonical order. Returns null
 * when there's nothing to flag (no CLAUDE.md, fewer than two blocks, or already
 * ordered). `render`/`sync` auto-fix the order; doctor surfaces it so a
 * hand-edited or legacy file is visible before the next render.
 */
export function scanManagedOrder(cwd: string, config: NavoriConfig): OrderReport | null {
  const claudeMdPath = join(cwd, "CLAUDE.md");
  if (!existsSync(claudeMdPath)) return null;
  const content = readFileSync(claudeMdPath, "utf-8");
  const current = listMarkers(claudeMdPath).map((m) => m.id);
  if (current.length < 2) return null;

  const canonical = canonicalManagedOrder(config, cwd);
  // Reuse the engine's reorder logic as the source of truth for "in order?".
  const result = reorderManagedBlocks(content, canonical);
  if (!result.reordered && !result.blockedByInterleaving) return null;

  const rank = new Map<string, number>();
  canonical.forEach((id, i) => {
    if (!rank.has(id)) rank.set(id, i);
  });
  const expected = current
    .map((id, i) => ({ id, i, key: rank.has(id) ? rank.get(id)! : canonical.length + i }))
    .sort((a, z) => a.key - z.key || a.i - z.i)
    .map((x) => x.id);

  // Spotlight the block that should lead: `expected[0]` is the canonical-first
  // among the present blocks. If it isn't already at index 0, name it and its
  // current position so the diagnostic is actionable, not just two id lists.
  const lead = expected[0];
  const leadPos = lead !== undefined ? current.indexOf(lead) : -1;
  const misplacedFirst =
    lead !== undefined && leadPos > 0
      ? { id: lead, currentPos: leadPos + 1, total: current.length }
      : null;

  return { current, expected, interleaved: result.blockedByInterleaving, misplacedFirst };
}

export interface MalformedMarker {
  /** File the malformed line lives in, relative to cwd. */
  filePath: string;
  /** 1-based line number of the broken marker. */
  line: number;
  /** The trimmed line text (truncated) for the diagnostic. */
  snippet: string;
}

/**
 * Detect managed-marker lines that lost their `-->` terminator (usually a hand
 * edit that deleted just the closing chars). `findMarker` then stops matching
 * the line, so the next `injectManagedSection` appends a fresh block AND leaves
 * the broken line as permanent cruft. This is a NON-destructive report only —
 * doctor surfaces it so the user fixes the line before that happens. Issue #71
 * item 11. Same file scope as `scanManagedDrift` (all html-marker files).
 */
export function scanMalformedMarkers(cwd: string): MalformedMarker[] {
  const out: MalformedMarker[] = [];
  const files: string[] = [];
  if (existsSync(join(cwd, "CLAUDE.md"))) files.push("CLAUDE.md");
  if (existsSync(join(cwd, "AGENTS.md"))) files.push("AGENTS.md");
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
  // Check close before open: the close prefix is a superset string, so testing
  // it first avoids misclassifying a close line as a broken open.
  const prefixes = ["<!-- /navori:managed", "<!-- navori:managed"];
  for (const rel of files) {
    let content: string;
    try {
      content = readFileSync(join(cwd, rel), "utf-8");
    } catch {
      continue;
    }
    content.split("\n").forEach((lineText, i) => {
      for (const prefix of prefixes) {
        const idx = lineText.indexOf(prefix);
        if (idx === -1) continue;
        // A well-formed html marker terminates with `-->` on the same line.
        if (!lineText.slice(idx + prefix.length).includes("-->")) {
          out.push({ filePath: rel, line: i + 1, snippet: lineText.trim().slice(0, 80) });
        }
        break;
      }
    });
  }
  return out;
}

export interface HealthState {
  claudeMdExists: boolean;
  missingPlugins: MissingPlugin[];
  drifts: DriftReport[];
  /** CLAUDE.md managed blocks out of canonical order, if any. */
  orderReport?: OrderReport | null;
}

/**
 * Derive the suggested next actions from the current health state. Used by
 * `status` (and as the footer of `doctor`) to answer "what should I do now?".
 */
export function suggestNextSteps(state: HealthState): string[] {
  const steps: string[] = [];
  if (!state.claudeMdExists) {
    steps.push("Corre 'navori render --apply' para generar CLAUDE.md + .claude/.");
  }
  if (state.missingPlugins.length > 0) {
    steps.push(
      `Resuelve ${state.missingPlugins.length} plugin(s) faltante(s): instálalos o quítalos del config.`,
    );
  }
  if (state.drifts.some((d) => d.kind === "content")) {
    steps.push("Corre 'navori sync --interactive' para resolver bloques editados a mano.");
  }
  if (state.drifts.some((d) => d.kind === "version")) {
    steps.push("Corre 'navori render --apply' para traer los bloques a la última versión.");
  }
  if (state.orderReport && !state.orderReport.interleaved) {
    steps.push("Corre 'navori render --apply' para reordenar los bloques de CLAUDE.md al orden canónico.");
  }
  if (state.orderReport?.interleaved) {
    const mf = state.orderReport.misplacedFirst;
    const lead = mf
      ? ` (p.ej. '${mf.id}' está en posición ${mf.currentPos} de ${mf.total} y debería ir 1º)`
      : "";
    steps.push(
      `Mueve el texto que tienes entre bloques managed de CLAUDE.md arriba del primer bloque o abajo del último${lead}; luego corre 'navori render --apply' para reordenarlos.`,
    );
  }
  if (steps.length === 0) {
    steps.push("Todo al día — sin acciones pendientes.");
  }
  return steps;
}
