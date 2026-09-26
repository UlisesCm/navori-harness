/**
 * Master-plan templates (spec 0034, design.md D3): `packages/core/core-assets/
 * master-plan/{plan,master,decisions,intake,digest,tasks,issue}.md`, base
 * Spanish, with an English sibling under `master-plan/en/`. `navori master
 * template <name>` prints these; `checks.ts` and `fit.ts` extract the header
 * list to validate against instead of keeping a second, hand-written copy in
 * TypeScript (T4).
 *
 * Language fallback mirrors `resolveAssetPath` (`lib/render/render-plan.ts`):
 * the base language is Spanish, a repo asking for English gets the sibling
 * under `en/` when it exists, and falls back to the Spanish base otherwise.
 *
 * Every file-reading function accepts an optional `root` override so tests can
 * point at a fixture directory instead of the real bundled `core-assets/`
 * (the implementer role never writes `.md` files — see `impl_0034-lote-b.json`
 * `markdownRequests` for the production template content).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getCoreRoot } from "../render/bundled-assets.ts";
import { masterMarkers } from "./markers.ts";
import type { AssetLanguage } from "../render/render-plan.ts";
import type { MasterMode, Part } from "./schema.ts";

export const TEMPLATE_NAMES = [
  "plan",
  "master",
  "decisions",
  "intake",
  "digest",
  "tasks",
  "issue",
] as const;
export type TemplateName = (typeof TEMPLATE_NAMES)[number];

export interface TemplateOptions {
  /** Override for `getCoreRoot()` — tests point this at a fixture directory. */
  root?: string;
}

/** A `## <heading>` section of a template, plus its optional `only-mode`
 * restriction (`<!-- only-mode: template|en-curso -->` as the section's first
 * line): the plan template's "Estado actual vs. objetivo" section exists only
 * in `en-curso` mode (R18, design.md D3). */
export interface TemplateSection {
  heading: string;
  onlyMode: MasterMode | null;
  body: string;
}

const ONLY_MODE_MARKER = /^<!--\s*only-mode:\s*(template|en-curso)\s*-->\s*\n?/;

/**
 * Resolves the absolute path of `<name>.md`, applying the language fallback
 * (T4). Returns whether the result is a fallback to the Spanish base (the
 * repo asked for `en` but no translation exists yet).
 */
export function resolveTemplatePath(
  name: TemplateName,
  language: AssetLanguage,
  options: TemplateOptions = {},
): { path: string; fallback: boolean } {
  const root = options.root ?? getCoreRoot();
  const baseRel = `core-assets/master-plan/${name}.md`;
  if (language === "es") {
    return { path: resolve(root, baseRel), fallback: false };
  }
  const langRel = `core-assets/master-plan/${language}/${name}.md`;
  const abs = resolve(root, langRel);
  if (existsSync(abs)) return { path: abs, fallback: false };
  return { path: resolve(root, baseRel), fallback: true };
}

export function readTemplateFile(
  name: TemplateName,
  language: AssetLanguage,
  options: TemplateOptions = {},
): string {
  const { path } = resolveTemplatePath(name, language, options);
  return readFileSync(path, "utf8");
}

/**
 * Splits a template's Markdown content into top-level `##` sections. Pure and
 * exported so tests can exercise the parsing rules (mode filtering, empty
 * bodies) against literal fixture strings, with no filesystem or `.md` write
 * involved.
 */
export function splitTemplateSections(content: string): TemplateSection[] {
  const lines = content.split("\n");
  const sections: TemplateSection[] = [];
  let heading: string | null = null;
  let bodyLines: string[] = [];

  const flush = (): void => {
    if (heading === null) return;
    let body = bodyLines.join("\n");
    let onlyMode: MasterMode | null = null;
    const marker = ONLY_MODE_MARKER.exec(body);
    if (marker) {
      onlyMode = marker[1] as MasterMode;
      body = body.slice(marker[0].length);
    }
    sections.push({ heading, onlyMode, body: body.trim() });
  };

  for (const line of lines) {
    const match = /^##\s+(.+)$/.exec(line);
    if (match) {
      flush();
      heading = match[1]!.trim();
      bodyLines = [];
    } else if (heading !== null) {
      bodyLines.push(line);
    }
  }
  flush();
  return sections;
}

/** Sections of a template applicable to `mode` — a `null` mode keeps only the
 * unconditional sections (used by templates with no mode-gated section, like
 * `digest`). */
export function sectionsForMode(
  sections: readonly TemplateSection[],
  mode: MasterMode | null,
): TemplateSection[] {
  return sections.filter((s) => s.onlyMode === null || s.onlyMode === mode);
}

/** The header list `checks.ts`/`fit.ts` validate a written document against —
 * read from the template file, never hardcoded (T4). */
export function templateHeaders(
  name: TemplateName,
  language: AssetLanguage,
  mode: MasterMode | null = null,
  options: TemplateOptions = {},
): string[] {
  const sections = splitTemplateSections(readTemplateFile(name, language, options));
  return sectionsForMode(sections, mode).map((s) => s.heading);
}

/** `navori master template <name>`: the template body, filtered to `mode`. */
export function printTemplate(
  name: TemplateName,
  language: AssetLanguage,
  mode: MasterMode | null = null,
  options: TemplateOptions = {},
): string {
  const sections = sectionsForMode(
    splitTemplateSections(readTemplateFile(name, language, options)),
    mode,
  );
  return `${sections.map((s) => `## ${s.heading}\n\n${s.body}`).join("\n\n")}\n`;
}

function bulletList(items: readonly string[], empty: string): string {
  return items.length > 0 ? items.map((i) => `- ${i}`).join("\n") : empty;
}

/** Minimal `{{token}}` interpolation for `issue.md` — deliberately separate
 * from `lib/render/interpolate.ts`, which resolves `NavoriConfig` paths; this
 * fills a fixed, known set of tokens from a `parts.json` entry (T4, R42). */
function fillTokens(content: string, vars: Readonly<Record<string, string>>): string {
  return content.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    Object.hasOwn(vars, key) ? vars[key]! : match,
  );
}

/**
 * `navori master template issue --part P<n>`: the `issue` template filled
 * from `parts.json`, with the stage in the title (R42, D11 "Issues").
 */
export function printIssueTemplate(
  part: Part,
  stageDir: string,
  specsDir: string,
  language: AssetLanguage,
  options: TemplateOptions = {},
): string {
  const content = readTemplateFile("issue", language, options);
  const markers = masterMarkers(language);
  const acceptance = bulletList(
    part.acceptance.map((a) => `${part.id}.${a.id} (${a.method}): ${a.description}`),
    markers.ningunoDigest,
  );
  return fillTokens(content, {
    stage: stageDir,
    partId: part.id,
    title: part.title,
    objective: part.objective,
    scope: bulletList(part.scope, markers.ningunoDigest),
    outOfScope: bulletList(part.outOfScope, markers.ningunoDigest),
    dependsOn: part.dependsOn.length > 0 ? part.dependsOn.join(", ") : markers.ninguna,
    acceptance,
    masterPath: `${specsDir}/_master/${stageDir}/MASTER.md`,
  });
}
