import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { codexHome } from "./home.ts";

/**
 * Last-known model id per Codex family (spec 0041 R32). Used only when the
 * local catalog is missing, unreadable or lists no model of the family.
 */
export const CODEX_FAMILY_FALLBACK: Readonly<Record<string, string>> = {
  sol: "gpt-6-sol",
  luna: "gpt-6-luna",
  astra: "gpt-6-astra",
};

/** How a `codexMap` value became the rendered model id. */
export type CodexModelSource = "family" | "pin" | "fallback" | "rendered";

export interface CodexModelResolution {
  model: string;
  source: CodexModelSource;
  /** Set when `source` is `fallback`: the family whose catalog lookup failed. */
  family?: string;
}

const CatalogSchema = z.object({ models: z.array(z.unknown()) });
const EntrySchema = z.object({ slug: z.string() });

// `gpt-<version>-<family>`, e.g. gpt-6-sol, gpt-6.1-sol, gpt-5.6-luna.
const SLUG_RE = /^gpt-(\d+(?:\.\d+)*)-([a-z]+)$/;
// A family is a bare lowercase word; anything else (hyphen, digit, slash) is a pin.
const FAMILY_RE = /^[a-z]+$/;

/** True when a `codexMap` value names a family rather than a full model id. */
export function isCodexFamily(value: string): boolean {
  return FAMILY_RE.test(value);
}

/** Default catalog location: `<codexHome()>/models_cache.json`, or null when CODEX_HOME is invalid. */
export function defaultCodexCatalogPath(): string | null {
  try {
    return join(codexHome(), "models_cache.json");
  } catch {
    return null;
  }
}

/**
 * Read the model slugs from the local Codex catalog. Read-only and defensive:
 * a missing file, bad JSON or an unexpected shape yields `[]`; entries without
 * a string `slug` are skipped. Never throws.
 */
export function readCodexCatalogSlugs(catalogPath: string | null): string[] {
  if (catalogPath === null) return [];
  try {
    const parsed = CatalogSchema.safeParse(JSON.parse(readFileSync(catalogPath, "utf-8")));
    if (!parsed.success) return [];
    const slugs: string[] = [];
    for (const entry of parsed.data.models) {
      const slug = EntrySchema.safeParse(entry);
      if (slug.success) slugs.push(slug.data.slug);
    }
    return slugs;
  } catch {
    return [];
  }
}

/** Numeric, component-wise comparison of dotted versions: 6.1 > 6 > 5.6. */
function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Parse a `gpt-<version>-<family>` slug; null when it does not match. */
function parseSlug(slug: string): { version: number[]; family: string } | null {
  const match = SLUG_RE.exec(slug);
  return match ? { version: match[1]!.split(".").map(Number), family: match[2]! } : null;
}

/** Highest-version slug of `family` among `slugs`, or null. Unparseable slugs are ignored. */
export function highestOfFamily(family: string, slugs: readonly string[]): string | null {
  let best: { slug: string; version: number[] } | null = null;
  for (const slug of slugs) {
    const parsed = parseSlug(slug);
    if (!parsed || parsed.family !== family) continue;
    const version = parsed.version;
    if (best === null || compareVersions(version, best.version) > 0) best = { slug, version };
  }
  return best?.slug ?? null;
}

/**
 * Resolve a `codexMap` value to a concrete model id. A full id is a pin and is
 * returned verbatim. A family resolves to the highest-version catalog model of
 * that family; without one it falls back to the last-known id (or, for a family
 * with no declared fallback, to the value itself). Never throws.
 *
 * Never-downgrade rule: without a catalog match, a `previous` (already rendered)
 * id of the same family whose version is >= the fallback's is kept, so a repo
 * rendered on a machine with a newer catalog stays stable on CI or machines
 * without one. The fallback applies only when `previous` is absent, of another
 * family, older, or unparseable (e.g. a pin).
 *
 * @param catalogPath Catalog file to read; defaults to `<codexHome()>/models_cache.json`.
 * @param previous Model id currently rendered for this agent, if any.
 */
export function resolveCodexModelValue(
  value: string,
  catalogPath: string | null = defaultCodexCatalogPath(),
  previous: string | null = null,
): CodexModelResolution {
  if (!isCodexFamily(value)) return { model: value, source: "pin" };
  const found = highestOfFamily(value, readCodexCatalogSlugs(catalogPath));
  if (found !== null) return { model: found, source: "family" };
  const fallback = CODEX_FAMILY_FALLBACK[value];
  const prev = previous === null ? null : parseSlug(previous);
  const floor = fallback === undefined ? null : parseSlug(fallback);
  if (
    previous !== null &&
    prev?.family === value &&
    floor &&
    compareVersions(prev.version, floor.version) >= 0
  ) {
    return { model: previous, source: "rendered" };
  }
  return { model: fallback ?? value, source: "fallback", family: value };
}
