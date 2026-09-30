/**
 * UX contract gate (phase `ux`). `state.ux` records the user's choice
 * (`navori master ux <none|md|md-json>`); the checks here keep the choice and
 * the stage's `UX.md` / `ux.json` files consistent. Shared by `advance`/`check`
 * (ux -> executing) and by `status`/`close` (delivery may not skip the gate).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PartsSchema,
  UX_ID_PATTERNS,
  UxContractSchema,
  type MasterState,
  type UxEntityKind,
} from "./schema.ts";
import { checkDecisionCitations, validateSections } from "./check-helpers.ts";
import { masterMarkers } from "./markers.ts";
import { readTemplateFile, splitTemplateSections, type TemplateSection } from "./templates.ts";
import type { AssetLanguage } from "../render/render-plan.ts";

/** Minimal context so both `CheckContext` and `status.ts` can call the checks. */
export interface UxContext {
  cwd: string;
  specsDir: string;
  language: AssetLanguage;
  stagePath: string;
  stage: { dir: string };
  state: Pick<MasterState, "ux">;
  /** Override for the bundled templates (tests). */
  templatesRoot?: string;
}

/** Sections of the `ux` template that hold no ID'd entities; every template section
 * carries a `<!-- ux-kind: … -->` marker naming one of these or an entity kind. */
const PLAIN_KINDS = [
  "metadata",
  "sources",
  "information-architecture",
  "global-states",
  "navigation",
  "cross-surface",
  "traceability",
  "screen-coverage",
  "open-questions",
  "out-of-scope",
  "checklist",
  "heron-handoff",
] as const;
const ENTITY_KINDS = Object.keys(UX_ID_PATTERNS) as UxEntityKind[];
/** Every marker the `ux` template (es and en) must expose. */
export const UX_SECTION_KINDS: readonly string[] = [...ENTITY_KINDS, ...PLAIN_KINDS];

/** Kinds that must declare at least one entity. */
const REQUIRED_ENTITY_KINDS: readonly UxEntityKind[] = [
  "surfaces",
  "actors",
  "journeys",
  "flows",
  "screens",
];
/** Sections where visual-looking literals are legitimate (citations, handoff scope). */
const DENYLIST_EXEMPT_KINDS = ["metadata", "sources", "out-of-scope", "checklist", "heron-handoff"];
const HANDOFF_HEADINGS = ["Heron MUST preserve", "Heron MAY improve", "Heron owns"];

// Unambiguous visual literals only: 6/8-digit hex (never `#1088` or `#add`) and px/rem.
const HEX_COLOR = /(?<![\w&])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6})\b/g;
const CSS_UNIT = /\b\d+(?:\.\d+)?(?:px|rem)\b/g;
const FRAMEWORKS =
  /\b(?:Mantine|Tailwind|Unistyles|MUI|Chakra|Bootstrap|shadcn|React Native|SwiftUI|Jetpack Compose|Flutter)\b/gi;

const PREFIXED_TOKENS: readonly (readonly [UxEntityKind, RegExp])[] = [
  ["actors", /(?<![\w-])ACT-[A-Z0-9]+(?:-[A-Z0-9]+)*(?![\w-])/g],
  ["screens", /(?<![\w-])SCR-[A-Z_]+-\d{2,}\b/g],
  ["patterns", /(?<![\w-])PT\d{2,}\b/g],
  ["ux-requirements", /(?<![\w-])UX-\d+\b/g],
];
const BARE_KIND: Readonly<Record<string, UxEntityKind>> = {
  J: "journeys",
  F: "flows",
  C: "components",
};
const BARE_TOKEN = /(?<![\w-])([JFC])\d{2,}\b/g;
const BARE_LIST_CELL = /^(?:[JFC]\d{2,}(?:\s*(?:,|;|\/|\by\b|\band\b)\s*|\s+)?)+$/;
const LABELED_LINE =
  /^\s*(?:[-*+]\s+)?(?:\*\*)?[^:|`]{1,40}?(?:\*\*)?:\s*(?:\*\*)?\s*([JFC]\d{2,}\b.*)$/;
const MASTER_REF = /(?<![\w-])(?:RNF|RN|RF)-\d+\b/g;
const PART_REF = /(?<![\w-])P(\d+)(?:\.(A\d+))?\b/g;

type Refs = Map<UxEntityKind, Set<string>>;

/** Text zones where J/F/C ids are real references, not prose like "F12" or "C99":
 * backtick spans, table cells that are only an id list, and `Label: F04 …` lines. */
function bareReferenceZones(text: string): string[] {
  const zones: string[] = [];
  for (const line of text.split("\n")) {
    for (const span of line.matchAll(/`([^`\n]+)`/g)) zones.push(span[1]!);
    if (line.trimStart().startsWith("|")) {
      for (const cell of line.split("|")) {
        const clean = cell.replace(/[*`]/g, "").trim();
        if (BARE_LIST_CELL.test(clean)) zones.push(clean);
      }
    } else {
      const labeled = LABELED_LINE.exec(line);
      if (labeled) zones.push(labeled[1]!);
    }
  }
  return zones;
}

/** Ids referenced in `text`, per declared kind (surfaces are never scanned). */
function referencedIds(text: string): Refs {
  const refs: Refs = new Map(ENTITY_KINDS.map((k) => [k, new Set<string>()]));
  for (const [kind, re] of PREFIXED_TOKENS) {
    for (const m of text.matchAll(re)) refs.get(kind)!.add(m[0]);
  }
  for (const zone of bareReferenceZones(text)) {
    for (const m of zone.matchAll(BARE_TOKEN)) refs.get(BARE_KIND[m[1]!]!)!.add(m[0]);
  }
  return refs;
}

interface Block {
  heading: string;
  body: string;
}

/** `### <heading>` blocks of a section body (text before the first one is ignored). */
function splitBlocks(body: string): Block[] {
  const blocks: Block[] = [];
  for (const line of body.split("\n")) {
    const match = /^###\s+(.+)$/.exec(line);
    if (match) blocks.push({ heading: match[1]!.trim(), body: "" });
    else if (blocks.length > 0) blocks.at(-1)!.body += `${line}\n`;
  }
  return blocks;
}

const idOfHeading = (heading: string): string => heading.split(/\s+[—–-]\s+/)[0]!.trim();

/** Drops fenced and inline code so literals quoted in backticks are never flagged. */
function stripCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
}

/** Hex colors and px/rem units in `text` (code spans excluded). Exported for tests. */
export function visualLiterals(text: string): string[] {
  const clean = stripCode(text);
  return [...clean.matchAll(HEX_COLOR), ...clean.matchAll(CSS_UNIT)].map((m) => m[0]);
}

/** UI framework names in `text`; enforced on ux.json string values only. */
export function frameworkNames(text: string): string[] {
  return [...text.matchAll(FRAMEWORKS)].map((m) => m[0]);
}

/** RN/RF/RNF tokens must exist in MASTER.md, P<n>[.A<m>] in parts.json, D<n> in DECISIONS.md. */
function checkMasterRefs(text: string, label: string, ctx: UxContext): string[] {
  const failures: string[] = [];
  const masterPath = join(ctx.stagePath, "MASTER.md");
  const master = existsSync(masterPath) ? readFileSync(masterPath, "utf8") : "";
  const masterIds = new Set(master.match(MASTER_REF) ?? []);
  for (const id of new Set(text.match(MASTER_REF) ?? [])) {
    if (!masterIds.has(id)) failures.push(`${label}: cita ${id}, que no existe en MASTER.md`);
  }
  const partsPath = join(ctx.stagePath, "parts.json");
  const parsed = existsSync(partsPath)
    ? PartsSchema.safeParse(JSON.parse(readFileSync(partsPath, "utf8")) as unknown)
    : null;
  const parts = new Map(
    (parsed?.success ? parsed.data.parts : []).map((p) => [
      p.id,
      new Set(p.acceptance.map((a) => a.id)),
    ]),
  );
  for (const m of text.matchAll(PART_REF)) {
    const part = `P${m[1]}`;
    if (!parts.has(part)) failures.push(`${label}: cita ${part}, que no existe en parts.json`);
    else if (m[2] && !parts.get(part)!.has(m[2]))
      failures.push(`${label}: cita ${part}.${m[2]}, que no existe en parts.json`);
  }
  return [...new Set(failures), ...checkDecisionCitations(text, label, ctx)];
}

interface UxDocs {
  /** ux-kind -> the template section (heading, guidance) that carries it. */
  template: Map<string, TemplateSection>;
  /** Declared ids per entity kind, read off the `###` headings of UX.md. */
  declared: Map<UxEntityKind, Set<string>>;
}

/** The decision must be recorded before leaving phase `ux`. */
export function checkUxDecision(ctx: UxContext): string[] {
  if (ctx.state.ux !== undefined) return [];
  return [
    `${ctx.stage.dir}: falta la decisión de UX; registre una con: navori master ux <none|md|md-json>`,
  ];
}

const setDiff = (a: ReadonlySet<string>, b: ReadonlySet<string>): string[] =>
  [...a].filter((x) => !b.has(x)).sort();

/** Structural checks of one entity kind's section: `### <ID> — <Name>` headings that
 * match the kind's regex, no duplicates; returns the declared ids. */
function declareIds(kind: UxEntityKind, body: string, label: string, failures: string[]) {
  const ids = new Set<string>();
  for (const { heading } of splitBlocks(body)) {
    const id = idOfHeading(heading);
    if (!UX_ID_PATTERNS[kind].test(id))
      failures.push(`${label}: "### ${heading}" no es un id de ${kind} válido`);
    else if (ids.has(id)) failures.push(`${label}: id duplicado ${id}`);
    else ids.add(id);
  }
  return ids;
}

/** Coherence of UX.md against its own template, MASTER.md, parts.json and DECISIONS.md. */
function checkUxMarkdown(ctx: UxContext, md: string): { failures: string[]; docs: UxDocs | null } {
  const label = `${ctx.stage.dir}/UX.md`;
  const markers = masterMarkers(ctx.language);
  const tplSections = splitTemplateSections(
    readTemplateFile("ux", ctx.language, { root: ctx.templatesRoot }),
  );
  const template = new Map(tplSections.flatMap((s) => (s.kind ? [[s.kind, s] as const] : [])));
  const missingKinds = UX_SECTION_KINDS.filter((k) => !template.has(k));
  if (missingKinds.length > 0)
    return {
      failures: [`plantilla ux sin marcador ux-kind: ${missingKinds.join(", ")}`],
      docs: null,
    };

  const failures = validateSections(
    md,
    tplSections.map((s) => s.heading),
    label,
    markers.noAplica,
  );
  const sections = new Map(splitTemplateSections(md).map((s) => [s.heading, s] as const));
  const bodyOf = (kind: string): string => sections.get(template.get(kind)!.heading)?.body ?? "";
  const declared = new Map(
    ENTITY_KINDS.map((k) => [k, declareIds(k, bodyOf(k), label, failures)] as const),
  );
  for (const kind of REQUIRED_ENTITY_KINDS)
    if (declared.get(kind)!.size === 0) failures.push(`${label}: no declara ningún id de ${kind}`);

  const dangling = new Set<string>();
  for (const [kind, ids] of referencedIds(md)) {
    for (const id of ids)
      if (!declared.get(kind)!.has(id))
        dangling.add(`${label}: ${id} se cita pero no está declarado (${kind})`);
  }
  failures.push(...dangling);

  const need = (kind: UxEntityKind, from: UxEntityKind, what: string): void => {
    for (const block of splitBlocks(bodyOf(kind)))
      if (referencedIds(block.body).get(from)!.size === 0)
        failures.push(`${label}: ${idOfHeading(block.heading)} no referencia ${what}`);
  };
  need("journeys", "flows", "ningún flow");
  need("flows", "screens", "ninguna pantalla");
  for (const block of splitBlocks(bodyOf("screens"))) {
    const id = idOfHeading(block.heading);
    if (!/(?<![\w-])(?:RNF|RN|RF)-\d+\b|(?<![\w-])P\d+\b/.test(block.body))
      failures.push(`${label}: ${id} no referencia ningún RN/RF/RNF/P<n>`);
    const surface = UX_ID_PATTERNS.screens.exec(id)?.[1];
    if (surface && !declared.get("surfaces")!.has(surface))
      failures.push(`${label}: ${id} usa la superficie ${surface}, que no está declarada`);
  }

  failures.push(...checkMasterRefs(md, label, ctx));
  if (bodyOf("open-questions").trim() !== markers.ninguna)
    failures.push(
      `${label}: "## ${template.get("open-questions")!.heading}" debe decir "${markers.ninguna}"`,
    );

  const checkbox = /^\s*[-*]\s+\[[ xX]\]/gm;
  const checklist = bodyOf("checklist");
  const tplCount = template.get("checklist")!.body.match(checkbox)?.length ?? 0;
  if (/^\s*[-*]\s+\[ \]/m.test(checklist))
    failures.push(`${label}: la validación tiene casillas sin marcar`);
  if ((checklist.match(checkbox)?.length ?? 0) !== tplCount)
    failures.push(`${label}: la validación debe tener las ${tplCount} casillas de la plantilla`);

  const handoff = new Map(
    splitBlocks(bodyOf("heron-handoff")).map((b) => [b.heading, b.body.trim()]),
  );
  for (const h of HANDOFF_HEADINGS)
    if (!handoff.get(h)) failures.push(`${label}: falta el subapartado "### ${h}" o está vacío`);

  for (const section of sections.values()) {
    const exempt = DENYLIST_EXEMPT_KINDS.some((k) => template.get(k)!.heading === section.heading);
    if (exempt) continue;
    for (const hit of new Set(visualLiterals(section.body)))
      failures.push(
        `${label}: "## ${section.heading}" contiene "${hit}" (decisión visual; pertenece a Heron)`,
      );
  }
  return { failures, docs: { template, declared } };
}

const JSON_KIND_KEYS: Readonly<Record<UxEntityKind, string>> = {
  surfaces: "surfaces",
  actors: "actors",
  journeys: "journeys",
  flows: "flows",
  screens: "screens",
  components: "functionalComponents",
  patterns: "patterns",
  "ux-requirements": "uxRequirements",
};

/** Every string value of a parsed JSON tree, with its dotted path. */
function jsonStrings(value: unknown, path = ""): [string, string][] {
  if (typeof value === "string") return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((v, i) => jsonStrings(v, `${path}[${i}]`));
  if (value && typeof value === "object")
    return Object.entries(value).flatMap(([k, v]) => jsonStrings(v, path ? `${path}.${k}` : k));
  return [];
}

/** ux.json: strict schema, `masterStage`, ID sets equal to UX.md's, no visual/framework
 * literals in string values, and every cited RN/RF/RNF/P<n>/D<n> must exist. */
function checkUxJson(ctx: UxContext, docs: UxDocs | null): string[] {
  const label = `${ctx.stage.dir}/ux.json`;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(ctx.stagePath, "ux.json"), "utf8"));
  } catch (error) {
    return [`${label}: no es JSON válido (${(error as Error).message})`];
  }
  const parsed = UxContractSchema.safeParse(raw);
  if (!parsed.success)
    return parsed.error.issues.map(
      (i) => `${label}: ${i.path.join(".") || "(raíz)"}: ${i.message}`,
    );
  const failures: string[] = [];
  if (parsed.data.masterStage !== ctx.stage.dir)
    failures.push(`${label}: masterStage '${parsed.data.masterStage}' no es '${ctx.stage.dir}'`);
  if (docs) {
    for (const kind of ENTITY_KINDS) {
      const items = parsed.data[JSON_KIND_KEYS[kind] as keyof typeof parsed.data] as {
        id: string;
      }[];
      const json = new Set(items.map((i) => i.id));
      const md = docs.declared.get(kind)!;
      const onlyMd = setDiff(md, json);
      const onlyJson = setDiff(json, md);
      if (onlyMd.length + onlyJson.length > 0)
        failures.push(
          `${label}: ids de ${kind} distintos entre UX.md y ux.json; solo en UX.md: [${onlyMd.join(", ")}]; solo en ux.json: [${onlyJson.join(", ")}]`,
        );
    }
  }
  const strings = jsonStrings(raw);
  for (const [path, value] of strings) {
    for (const hit of new Set([...visualLiterals(value), ...frameworkNames(value)]))
      failures.push(`${label}: ${path} contiene "${hit}" (decisión visual o framework)`);
  }
  failures.push(...checkMasterRefs(strings.map(([, v]) => v).join("\n"), label, ctx));
  return failures;
}

/**
 * Content validation of UX.md and, when present, ux.json (schema + coherence, see
 * `checkUxMarkdown` / `checkUxJson`). Runs only once presence is consistent.
 */
export function checkUxContent(ctx: UxContext): string[] {
  const mdPath = join(ctx.stagePath, "UX.md");
  const { failures, docs } = existsSync(mdPath)
    ? checkUxMarkdown(ctx, readFileSync(mdPath, "utf8"))
    : { failures: [], docs: null };
  if (existsSync(join(ctx.stagePath, "ux.json"))) failures.push(...checkUxJson(ctx, docs));
  return failures;
}

/**
 * Presence consistency between `state.ux` and the files on disk: `none` allows
 * neither file, `md` requires UX.md only, `md-json` requires both. With no decision
 * (legacy stages) only a ux.json without UX.md is inconsistent.
 */
export function checkUxArtifacts(ctx: UxContext): string[] {
  const dir = ctx.stage.dir;
  const hasMd = existsSync(join(ctx.stagePath, "UX.md"));
  const hasJson = existsSync(join(ctx.stagePath, "ux.json"));
  const choice = ctx.state.ux;
  const failures: string[] = [];
  if (choice === undefined) {
    if (hasJson && !hasMd) failures.push(`${dir}: ux.json existe sin UX.md`);
  } else if (choice === "none") {
    if (hasMd) failures.push(`${dir}: la decisión de UX es 'none' pero existe UX.md`);
    if (hasJson) failures.push(`${dir}: la decisión de UX es 'none' pero existe ux.json`);
  } else {
    if (!hasMd) failures.push(`${dir}: la decisión de UX es '${choice}' pero falta UX.md`);
    if (choice === "md-json" && !hasJson)
      failures.push(`${dir}: la decisión de UX es 'md-json' pero falta ux.json`);
    if (choice === "md" && hasJson)
      failures.push(`${dir}: la decisión de UX es 'md' pero existe ux.json`);
  }
  if (failures.length === 0 && hasMd) failures.push(...checkUxContent(ctx));
  return failures;
}
