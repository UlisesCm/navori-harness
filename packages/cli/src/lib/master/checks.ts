/**
 * `navori master check` and `navori master advance` (spec 0034, design.md
 * Contracts "Comprobaciones de `advance`" and D10's read-only-after-close
 * rule; T5). `advance` writes the next phase and appends it to `state.json`'s
 * history ONLY when every mechanical check for that transition passes; `check`
 * runs the very same checks without writing. Neither ever skips a phase or
 * leaves `executing` — that only happens through `navori master close`
 * (a later lote).
 *
 * Scope note (reported in `impl_0034-lote-b.json`): the `mastered`/`executing`
 * row also asks to compare the `parts.json` region of `MASTER.md` against "its
 * render", and `check` (no `--stage`) is asked to compare `STATUS.md` against
 * its render (tasks.md T5). Both renders belong to `status.ts` (T8, Lote C),
 * which does not exist yet in this worktree — that comparison is deferred to
 * T8/T9 and is NOT implemented here; every other row of the table is.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { readConfig } from "../config/config.ts";
import { writeFileAtomic } from "../primitives/atomic.ts";
import {
  MASTER_PHASES,
  MasterStateSchema,
  PartsSchema,
  type MasterMode,
  type MasterPhase,
  type MasterState,
  type MasterIndex,
  type StageEntry,
} from "./schema.ts";
import {
  activeStage,
  lastClosedStage,
  masterDirPath,
  MasterIndexError,
  readMasterIndex,
} from "./stages.ts";
import { splitTemplateSections, templateHeaders, type TemplateSection } from "./templates.ts";
import { masterMarkers, type MasterMarkers } from "./markers.ts";
import type { AssetLanguage } from "../render/render-plan.ts";

export type CheckFailure = string;

export interface CheckContext {
  cwd: string;
  specsDir: string;
  language: AssetLanguage;
  index: MasterIndex;
  stage: StageEntry;
  stagePath: string;
  state: MasterState;
  /** Override for where `templates.ts` reads `core-assets/master-plan/` from
   * — tests point this at a fixture directory instead of the real bundled
   * assets (see `templates.ts`'s `TemplateOptions`). */
  templatesRoot?: string;
}

export interface CheckOptions {
  templatesRoot?: string;
}

export class MasterCheckSetupError extends Error {}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function statePath(ctx: Pick<CheckContext, "stagePath">): string {
  return join(ctx.stagePath, "state.json");
}

function headersOf(
  ctx: CheckContext,
  name: "digest" | "plan" | "master",
  mode: MasterMode | null,
): string[] {
  return templateHeaders(name, ctx.language, mode, { root: ctx.templatesRoot });
}

/** Reads config, index and the active stage's `state.json`. Throws
 * `MasterCheckSetupError` for anything that isn't the active stage's own
 * mechanical checks — no active stage, a broken `index.json`, a broken
 * `state.json` — so callers can report it as a single failure instead of a
 * crash. */
export function buildCheckContext(cwd: string, options: CheckOptions = {}): CheckContext {
  const config = readConfig(join(cwd, "navori.config.json"));
  const specsDir = config.sdd?.specsDir ?? "specs";
  const language = config.language;

  let index: MasterIndex | null;
  try {
    index = readMasterIndex(cwd, specsDir);
  } catch (cause) {
    if (cause instanceof MasterIndexError) throw new MasterCheckSetupError(cause.message);
    throw cause;
  }
  const stage = activeStage(index);
  if (!index || !stage) {
    throw new MasterCheckSetupError("no hay etapa activa: corra 'navori master init <slug>'");
  }
  const stagePath = join(masterDirPath(cwd, specsDir), stage.dir);
  // `stages.ts`'s filesystem invariants deliberately let an `activa` entry have
  // no folder yet, so a cut `init` (index.json written, folder not yet
  // materialized) can still be repaired by a second `init` run (Lote A review
  // note). `check`/`advance` must NOT treat that as healthy: they mutate or
  // report on the stage's own files, so a missing folder here is a real
  // failure, not a recoverable gap.
  if (!existsSync(stagePath)) {
    throw new MasterCheckSetupError(
      `${stage.dir}: la etapa activa no tiene carpeta en disco (repárelo con: navori master init)`,
    );
  }
  const path = statePath({ stagePath });
  if (!existsSync(path)) {
    throw new MasterCheckSetupError(`${stage.dir}: falta state.json`);
  }
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const parsedState = MasterStateSchema.safeParse(raw);
  if (!parsedState.success) {
    throw new MasterCheckSetupError(
      `${stage.dir}/state.json no es válido: ${parsedState.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  return {
    cwd,
    specsDir,
    language,
    index,
    stage,
    stagePath,
    state: parsedState.data,
    templatesRoot: options.templatesRoot,
  };
}

// --- always-on checks (design.md Contracts, "En todas las fases") ---------

/** `context/raw/.gitignore` must exist in every phase (R4, D8) — checked on
 * every `check`/`advance` call, not just at `init` time. */
export function checkRawGitignore(ctx: CheckContext): CheckFailure[] {
  const path = join(ctx.stagePath, "context", "raw", ".gitignore");
  if (existsSync(path)) return [];
  return [`falta ${ctx.stage.dir}/context/raw/.gitignore (repárelo con: navori master init)`];
}

/** `state.json`'s `history` must be a chain of strictly consecutive phases
 * (no skip, no repeat) — tasks.md T5's extra check for `check`. */
export function checkHistoryChain(ctx: CheckContext): CheckFailure[] {
  const history = ctx.state.history;
  if (history.length === 0) return [`${ctx.stage.dir}: state.json.history está vacío`];
  if (history[0]!.phase !== MASTER_PHASES[0]) {
    return [`${ctx.stage.dir}: state.json.history no empieza en '${MASTER_PHASES[0]}'`];
  }
  for (let i = 1; i < history.length; i++) {
    const prevIdx = MASTER_PHASES.indexOf(history[i - 1]!.phase);
    const currIdx = MASTER_PHASES.indexOf(history[i]!.phase);
    if (currIdx !== prevIdx + 1) {
      return [
        `${ctx.stage.dir}: state.json.history salta de '${history[i - 1]!.phase}' a '${history[i]!.phase}'`,
      ];
    }
  }
  return [];
}

// --- generic Markdown helpers ---------------------------------------------

function readStageFile(ctx: CheckContext, relPath: string): string | null {
  const path = join(ctx.stagePath, relPath);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/** Validates that `content` has every heading in `expected`, each with a
 * non-empty body (a body that is exactly `<noAplica marker> <razón>` counts as
 * non-empty on purpose — R21). `noAplica` is the language-resolved marker
 * (`No aplica:` / `Not applicable:`), never a hardcoded literal. */
function validateSections(
  content: string,
  expected: readonly string[],
  label: string,
  noAplica: string,
): CheckFailure[] {
  const sections = new Map(splitTemplateSections(content).map((s) => [s.heading, s] as const));
  const failures: CheckFailure[] = [];
  for (const heading of expected) {
    const section = sections.get(heading);
    if (!section) {
      failures.push(`${label}: falta la sección "## ${heading}"`);
      continue;
    }
    if (section.body.trim().length === 0) {
      failures.push(`${label}: la sección "## ${heading}" está vacía`);
      continue;
    }
    // Plain string search, not a dynamic RegExp built from `noAplica` — the
    // marker is a fixed, non-attacker-controlled literal from `markers.ts`,
    // but semgrep's detect-non-literal-regexp rule flags any `new RegExp(var)`
    // regardless, so this stays literal-free by design.
    const noAplicaLine = section.body
      .split("\n")
      .find((line) => line.trimStart().startsWith(noAplica));
    if (
      noAplicaLine &&
      noAplicaLine.slice(noAplicaLine.indexOf(noAplica) + noAplica.length).trim().length === 0
    ) {
      failures.push(`${label}: "## ${heading}" dice "${noAplica}" sin razón`);
    }
  }
  return failures;
}

interface MarkdownTable {
  headers: string[];
  rows: string[][];
}

/** Parses the first Markdown table (`| a | b |` rows) found in `content`. */
function parseFirstTable(content: string): MarkdownTable | null {
  const lines = content.split("\n").filter((l) => l.trim().startsWith("|"));
  if (lines.length < 2) return null;
  const cells = (line: string): string[] =>
    line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
  const headers = cells(lines[0]!);
  const rows = lines.slice(2).map(cells); // lines[1] is the --- separator
  return { headers, rows };
}

// --- phase transitions (design.md Contracts table) -------------------------

const MARKITDOWN_VERSION = /markitdown\s+\d+\.\d+\.\d+/;
const CONTEXT_MD_REF = /context\/md\/[^\s)|]+/;

function checkTranscribed(ctx: CheckContext): CheckFailure[] {
  const markers = masterMarkers(ctx.language);
  const failures: CheckFailure[] = [];
  if (ctx.state.mode === null) failures.push(`${ctx.stage.dir}: mode no está registrado`);

  const rawDir = join(ctx.stagePath, "context", "raw");
  const rawFiles = existsSync(rawDir) ? readdirSync(rawDir).filter((f) => f !== ".gitignore") : [];
  if (rawFiles.length === 0) {
    failures.push(`${ctx.stage.dir}: context/raw/ no tiene ningún archivo aparte de .gitignore`);
  }

  const intake = readStageFile(ctx, "context/INTAKE.md");
  if (intake === null) {
    failures.push(`${ctx.stage.dir}: falta context/INTAKE.md`);
    return failures;
  }
  const table = parseFirstTable(intake);
  if (!table) {
    failures.push(`${ctx.stage.dir}: context/INTAKE.md no tiene una tabla`);
    return failures;
  }
  // Plain case-insensitive substring search, not `new RegExp(marker)` — the
  // marker is a fixed, non-attacker-controlled literal from `markers.ts`, but
  // semgrep's detect-non-literal-regexp rule flags any `new RegExp(var)`
  // regardless of where the variable comes from, so column matching and the
  // header-line check below stay regex-free by design.
  const includesCI = (haystack: string, needle: string): boolean =>
    haystack.toLowerCase().includes(needle.toLowerCase());
  const fileCol = table.headers.findIndex((h) => includesCI(h, markers.archivoColumn));
  const methodCol = table.headers.findIndex((h) => includesCI(h, markers.metodoColumn));
  const resultCol = table.headers.findIndex((h) => includesCI(h, markers.resultadoColumn));
  const methodLabel = `${markers.metodoLabel}:`;
  for (const raw of rawFiles) {
    const row = table.rows.find((r) => r[fileCol]?.includes(raw));
    if (!row) {
      failures.push(`${ctx.stage.dir}: context/INTAKE.md no tiene una fila para ${raw}`);
      continue;
    }
    const method = row[methodCol] ?? "";
    const result = row[resultCol] ?? "";
    const ref = CONTEXT_MD_REF.exec(result);
    if (ref) {
      const mdRelPath = ref[0];
      const mdPath = join(ctx.stagePath, mdRelPath);
      if (!existsSync(mdPath)) {
        failures.push(`${ctx.stage.dir}: ${raw} apunta a ${mdRelPath}, que no existe`);
        continue;
      }
      const firstLine = readFileSync(mdPath, "utf8").split("\n")[0] ?? "";
      if (!firstLine.includes(raw) || !includesCI(firstLine, methodLabel)) {
        failures.push(
          `${ctx.stage.dir}: ${mdRelPath} no empieza con el archivo original y el método`,
        );
      }
      if (/markitdown/i.test(method) && !MARKITDOWN_VERSION.test(firstLine)) {
        failures.push(`${ctx.stage.dir}: ${mdRelPath} usa markitdown sin versión en su cabecera`);
      }
    } else if (result.trim().length === 0) {
      failures.push(`${ctx.stage.dir}: ${raw} no se convirtió y no tiene causa en INTAKE.md`);
    }
  }
  return failures;
}

// CODEBASE.md has no `templates.ts` template (it's the `scout`'s free-form
// deliverable, not something an `architect` fills from a template file), so
// its section names cannot be read from a file the way `digest`'s can.
// TODO(i18n): hardcoded Spanish; add an English fixture pair here once a repo
// with `language: "en"` actually exercises the master-plan flow.
const CODEBASE_HEADERS = ["Stack", "Estructura", "Convenciones", "Specs"] as const;

function checkMapped(ctx: CheckContext): CheckFailure[] {
  const markers = masterMarkers(ctx.language);
  const failures: CheckFailure[] = [];
  const digest = readStageFile(ctx, "context/DIGEST.md");
  if (digest === null) {
    failures.push(`${ctx.stage.dir}: falta context/DIGEST.md`);
  } else {
    const headers = headersOf(ctx, "digest", null);
    failures.push(
      ...validateSections(digest, headers, `${ctx.stage.dir}/context/DIGEST.md`, markers.noAplica),
    );
    const sections = new Map(splitTemplateSections(digest).map((s) => [s.heading, s] as const));
    // The first section ("Resumen por archivo") and the last ("Hallazgos")
    // carry no citation requirement; every section in between is a counting
    // section whose bullets must cite an existing `context/md/…` file. Reading
    // this off `headers` (not a hardcoded Spanish list) keeps it correct for
    // whatever language `digest.md`'s translation uses.
    const countSections = headers.slice(1, -1);
    for (const heading of countSections) {
      const body = sections.get(heading)?.body.trim() ?? "";
      if (body === markers.ningunoDigest) continue;
      for (const line of body.split("\n").filter((l) => l.trim().startsWith("-"))) {
        if (!CONTEXT_MD_REF.test(line)) {
          failures.push(
            `${ctx.stage.dir}/context/DIGEST.md: una viñeta de "${heading}" no cita un context/md/… existente: "${line.trim()}"`,
          );
          continue;
        }
        const ref = CONTEXT_MD_REF.exec(line)![0];
        if (!existsSync(join(ctx.stagePath, ref))) {
          failures.push(`${ctx.stage.dir}/context/DIGEST.md: cita ${ref}, que no existe`);
        }
      }
    }
  }

  const codebase = readStageFile(ctx, "context/CODEBASE.md");
  if (codebase === null) {
    failures.push(`${ctx.stage.dir}: falta context/CODEBASE.md`);
  } else {
    failures.push(
      ...validateSections(
        codebase,
        CODEBASE_HEADERS,
        `${ctx.stage.dir}/context/CODEBASE.md`,
        markers.noAplica,
      ),
    );
  }
  return failures;
}

const URL_PATTERN = /https?:\/\/\S+/g;
// Fixed, hardcoded literal — never built from a marker — so this line stays
// well clear of semgrep's detect-non-literal-regexp rule.
const ISO_DATE = /\d{4}-\d{2}-\d{2}/;

function checkPlanned(ctx: CheckContext): CheckFailure[] {
  const markers = masterMarkers(ctx.language);
  const failures: CheckFailure[] = [];
  const headers = headersOf(ctx, "plan", ctx.state.mode);
  const otherStages = ctx.index.stages.filter((s) => s.dir !== ctx.stage.dir);

  for (const planFile of ["plan1.md", "plan2.md", "plan3.md"]) {
    const content = readStageFile(ctx, `plans/${planFile}`);
    if (content === null) {
      failures.push(`${ctx.stage.dir}: falta plans/${planFile}`);
      continue;
    }
    const label = `${ctx.stage.dir}/plans/${planFile}`;
    failures.push(...validateSections(content, headers, label, markers.noAplica));

    for (const line of content.split("\n")) {
      if (
        /^RN-\d+/.test(line.trim()) &&
        !line.includes("context/md/") &&
        !line.includes(markers.supuesto)
      ) {
        failures.push(`${label}: "${line.trim()}" no cita context/md/… ni ${markers.supuesto}`);
      }
    }
    for (const line of content.split("\n")) {
      const urls = line.match(URL_PATTERN);
      if (!urls) continue;
      const hasConsultado =
        line.toLowerCase().includes(markers.consultado.toLowerCase()) && ISO_DATE.test(line);
      if (!hasConsultado && !line.includes(markers.sinVerificar)) {
        failures.push(
          `${label}: una URL no lleva "${markers.consultado} AAAA-MM-DD" ni ${markers.sinVerificar}: "${line.trim()}"`,
        );
      }
    }

    if (ctx.stage.number >= 2 && otherStages.length > 0) {
      const sections = new Map(splitTemplateSections(content).map((s) => [s.heading, s] as const));
      // "Metadatos" is always headers[0] — the plan template's first fixed
      // section (design.md D3) — read off the resolved header list instead of
      // a hardcoded literal, so this works for whatever language the template
      // is authored in.
      const metadataHeading = headers[0]!;
      const metadata = sections.get(metadataHeading)?.body ?? "";
      const mentionsClosedStage = otherStages.some((s) => metadata.includes(s.dir));
      if (!mentionsClosedStage) {
        failures.push(
          `${label}: "${metadataHeading}" no lista los archivos de etapas cerradas leídos`,
        );
      }
    }
  }
  return failures;
}

const DECISION_HEADING = /^D(\d+)$/;

function checkDecisionsFile(
  content: string,
  label: string,
  markers: MasterMarkers,
): { failures: CheckFailure[]; count: number } {
  if (content.trim() === markers.sinDecisiones) return { failures: [], count: 0 };
  const sections = splitTemplateSections(content).filter((s) => DECISION_HEADING.test(s.heading));
  if (sections.length === 0) {
    return {
      failures: [`${label}: ni "${markers.sinDecisiones}" ni ningún "## D<n>"`],
      count: 0,
    };
  }
  const failures: CheckFailure[] = [];
  const ids = sections.map((s) => Number(DECISION_HEADING.exec(s.heading)![1]));
  const sorted = [...ids].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i] !== i + 1) {
      failures.push(`${label}: los ids "D<n>" no son consecutivos desde D1`);
      break;
    }
  }
  for (const section of sections) {
    for (const field of [markers.pregunta, markers.elegida, markers.descartadas, markers.fecha]) {
      if (!section.body.includes(field)) {
        failures.push(
          `${label}: "## D${DECISION_HEADING.exec(section.heading)![1]}" no tiene "${field}"`,
        );
      }
    }
  }
  return { failures, count: sections.length };
}

function checkQuestioned(ctx: CheckContext): CheckFailure[] {
  const markers = masterMarkers(ctx.language);
  const failures: CheckFailure[] = [];
  const content = readStageFile(ctx, "DECISIONS.md");
  const label = `${ctx.stage.dir}/DECISIONS.md`;
  if (content === null) {
    failures.push(`${ctx.stage.dir}: falta DECISIONS.md`);
    return failures;
  }
  const { failures: decisionFailures } = checkDecisionsFile(content, label, markers);
  failures.push(...decisionFailures);

  if (ctx.stage.number >= 2) {
    const lastClosed = lastClosedStage(ctx.index);
    if (lastClosed) {
      const partsPath = join(masterDirPath(ctx.cwd, ctx.specsDir), lastClosed.dir, "parts.json");
      if (existsSync(partsPath)) {
        const raw: unknown = JSON.parse(readFileSync(partsPath, "utf8"));
        const parsed = PartsSchema.safeParse(raw);
        if (parsed.success) {
          const deferred = parsed.data.parts.filter((p) => p.state === "diferida");
          for (const part of deferred) {
            const marker = `${lastClosed.dir}/${part.id}`;
            if (!content.includes(marker)) {
              failures.push(`${label}: falta un D<n> para la parte diferida ${marker}`);
            }
          }
        }
      }
    }
  }
  return failures;
}

function checkMasterDocument(ctx: CheckContext): CheckFailure[] {
  const markers = masterMarkers(ctx.language);
  const failures: CheckFailure[] = [];
  const content = readStageFile(ctx, "MASTER.md");
  const label = `${ctx.stage.dir}/MASTER.md`;
  if (content === null) {
    failures.push(`${ctx.stage.dir}: falta MASTER.md`);
    return failures;
  }
  const headers = headersOf(ctx, "master", ctx.state.mode);
  failures.push(...validateSections(content, headers, label, markers.noAplica));

  const sections = new Map(splitTemplateSections(content).map((s) => [s.heading, s] as const));
  // "Preguntas abiertas" is always the LAST section of the master/plan
  // template list (design.md D3, item 18) — read off the resolved header
  // list, never a hardcoded literal, so this works in whatever language
  // master.md's translation uses.
  const openQuestionsHeading = headers[headers.length - 1]!;
  for (const heading of headers) {
    if (heading === openQuestionsHeading) continue;
    const section = sections.get(heading);
    if (section && !section.body.includes(markers.origen)) {
      failures.push(`${label}: "## ${heading}" no tiene una línea "${markers.origen}"`);
    }
  }
  const openQuestions = sections.get(openQuestionsHeading)?.body.trim();
  if (openQuestions !== undefined && openQuestions !== markers.ninguna) {
    failures.push(`${label}: "## ${openQuestionsHeading}" debe decir "${markers.ninguna}" (R32)`);
  }
  for (const marker of [markers.supuesto, markers.sinVerificar]) {
    if (content.includes(marker)) {
      failures.push(`${label}: contiene ${marker} sin resolver`);
    }
  }

  const partsPath = join(ctx.stagePath, "parts.json");
  if (!existsSync(partsPath)) {
    failures.push(`${ctx.stage.dir}: falta parts.json`);
  } else {
    const raw: unknown = JSON.parse(readFileSync(partsPath, "utf8"));
    const parsed = PartsSchema.safeParse(raw);
    if (!parsed.success) {
      failures.push(
        `${ctx.stage.dir}/parts.json no es válido: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      );
    }
  }

  const decisionIdsCited = new Set<string>();
  for (const match of content.matchAll(/(?:\b(\d{2}-[a-z0-9-]+)\/)?\bD(\d+)\b/g)) {
    decisionIdsCited.add(match[1] ? `${match[1]}/D${match[2]}` : `D${match[2]}`);
  }
  const localDecisions = readStageFile(ctx, "DECISIONS.md") ?? "";
  const localIds = new Set(
    splitTemplateSections(localDecisions)
      .filter((s) => DECISION_HEADING.test(s.heading))
      .map((s) => s.heading),
  );
  for (const cited of decisionIdsCited) {
    if (!cited.includes("/")) {
      if (!localIds.has(cited))
        failures.push(`${label}: cita ${cited}, que no existe en DECISIONS.md`);
      continue;
    }
    const [stageDir, id] = cited.split("/");
    const otherDecisions = join(masterDirPath(ctx.cwd, ctx.specsDir), stageDir!, "DECISIONS.md");
    if (!existsSync(otherDecisions)) {
      failures.push(`${label}: cita ${cited}, y ${stageDir}/DECISIONS.md no existe`);
      continue;
    }
    const otherIds = new Set(
      splitTemplateSections(readFileSync(otherDecisions, "utf8"))
        .filter((s) => DECISION_HEADING.test(s.heading))
        .map((s) => s.heading),
    );
    if (!otherIds.has(id!)) failures.push(`${label}: cita ${cited}, que no existe`);
  }

  return failures;
}

/** Dispatches the mechanical checks for moving INTO `target` (design.md
 * Contracts, "Comprobaciones de `advance`"). `closed` is not reachable this
 * way (D10: only `navori master close` gets there). */
export function checksForTransition(ctx: CheckContext, target: MasterPhase): CheckFailure[] {
  switch (target) {
    case "transcribed":
      return checkTranscribed(ctx);
    case "mapped":
      return checkMapped(ctx);
    case "planned":
      return checkPlanned(ctx);
    case "questioned":
      return checkQuestioned(ctx);
    case "mastered":
    case "executing":
      return checkMasterDocument(ctx);
    case "context":
    case "closed":
      return [`no hay comprobación mecánica para avanzar a '${target}'`];
  }
}

function nextPhase(phase: MasterPhase): MasterPhase | null {
  const idx = MASTER_PHASES.indexOf(phase);
  const next = MASTER_PHASES[idx + 1];
  return next && next !== "closed" ? next : null;
}

export interface AdvanceResult {
  advanced: boolean;
  from: MasterPhase;
  to: MasterPhase | null;
  failures: CheckFailure[];
}

/**
 * `navori master advance`: moves the active stage to its next phase ONLY when
 * every mechanical check for that transition passes (R8). Never skips a phase
 * (the target is always `MASTER_PHASES[current + 1]`) and never leaves
 * `executing` (that phase has no `next`; only `close` does).
 */
export function runMasterAdvance(cwd: string, options: CheckOptions = {}): AdvanceResult {
  const ctx = buildCheckContext(cwd, options);
  const target = nextPhase(ctx.state.phase);
  if (!target) {
    return {
      advanced: false,
      from: ctx.state.phase,
      to: null,
      failures: [
        `${ctx.stage.dir} ya está en fase 'executing': para cerrar la etapa use 'navori master close'`,
      ],
    };
  }
  const failures = [...checkRawGitignore(ctx), ...checksForTransition(ctx, target)];
  if (failures.length > 0) {
    return { advanced: false, from: ctx.state.phase, to: target, failures };
  }
  const updated: MasterState = {
    ...ctx.state,
    phase: target,
    history: [...ctx.state.history, { phase: target, at: today() }],
  };
  writeFileAtomic(statePath(ctx), `${JSON.stringify(updated, null, 2)}\n`);
  return { advanced: true, from: ctx.state.phase, to: target, failures: [] };
}

export interface CheckResult {
  phase: MasterPhase;
  nextPhase: MasterPhase | null;
  failures: CheckFailure[];
}

/** `navori master check` (active stage, no `--stage`): runs the same checks
 * `advance` would run for the next transition, without writing, plus the
 * history-chain integrity check (tasks.md T5). */
export function runMasterCheck(cwd: string, options: CheckOptions = {}): CheckResult {
  const ctx = buildCheckContext(cwd, options);
  const target = nextPhase(ctx.state.phase);
  const failures = [...checkRawGitignore(ctx), ...checkHistoryChain(ctx)];
  if (target) failures.push(...checksForTransition(ctx, target));
  return { phase: ctx.state.phase, nextPhase: target, failures };
}

// --- closed-stage validation (`check --stage`, R50) ------------------------

function sha256Normalized(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

/** Reads `CLOSURE.md`'s hash table under the `integridad`-named heading
 * (`Integridad`/`Integrity`, `markers.ts`). Returns `null` when the section or
 * its table is missing or has no rows — a closed stage MUST carry this table
 * (R50), so `null` is a failure to the caller, never treated as "nothing to
 * check" (Lote B review: an absent table used to silently pass). */
function parseIntegrityTable(
  closure: string,
  integridadHeading: string,
): Map<string, string> | null {
  const sections = splitTemplateSections(closure);
  const integrity: TemplateSection | undefined = sections.find(
    (s) => s.heading === integridadHeading,
  );
  const table = integrity ? parseFirstTable(integrity.body) : null;
  if (!table || table.rows.length === 0) return null;
  const map = new Map<string, string>();
  for (const row of table.rows) {
    if (row[0] && row[1]) map.set(row[0], row[1]);
  }
  return map.size > 0 ? map : null;
}

/**
 * `navori master check --stage <NN-slug>`: a closed stage is read-only (R50).
 * Verifies its `state.json` is `closed`, its `raw/.gitignore` is still there,
 * and every hash in `CLOSURE.md`'s "Integridad"/"Integrity" table (resolved by
 * `language`, `markers.ts`) still matches its file, computed over
 * line-ending-normalized content (`\r\n`/`\r` → `\n`) so a Windows
 * `core.autocrlf=true` checkout never reads as a hand-edit. A missing or empty
 * table is itself a failure — it must never silently pass a closed stage
 * through with nothing verified.
 */
export function checkClosedStage(
  cwd: string,
  specsDir: string,
  stageDir: string,
  language: AssetLanguage,
): CheckFailure[] {
  const markers = masterMarkers(language);
  const stagePath = join(masterDirPath(cwd, specsDir), stageDir);
  if (!existsSync(stagePath)) return [`${stageDir}: no existe`];
  const failures: CheckFailure[] = [];

  const gitignore = join(stagePath, "context", "raw", ".gitignore");
  if (!existsSync(gitignore)) {
    failures.push(
      `${stageDir}: falta context/raw/.gitignore (repárelo con: git checkout -- ${gitignore})`,
    );
  }

  const statePathAbs = join(stagePath, "state.json");
  if (!existsSync(statePathAbs)) {
    failures.push(`${stageDir}: falta state.json`);
  } else {
    const raw: unknown = JSON.parse(readFileSync(statePathAbs, "utf8"));
    const parsed = MasterStateSchema.safeParse(raw);
    if (!parsed.success) {
      failures.push(`${stageDir}/state.json no es válido`);
    } else if (parsed.data.phase !== "closed") {
      failures.push(`${stageDir}: state.json.phase es '${parsed.data.phase}', no 'closed'`);
    }
  }

  const closurePath = join(stagePath, "CLOSURE.md");
  if (!existsSync(closurePath)) {
    failures.push(`${stageDir}: falta CLOSURE.md`);
    return failures;
  }
  const closure = readFileSync(closurePath, "utf8");
  const integrity = parseIntegrityTable(closure, markers.integridad);
  if (!integrity) {
    failures.push(
      `${stageDir}: CLOSURE.md no tiene una tabla de "${markers.integridad}" con al menos una fila — no se puede verificar la etapa`,
    );
    return failures;
  }
  for (const [file, expectedHash] of integrity) {
    const filePath = join(stagePath, file);
    if (!existsSync(filePath)) {
      failures.push(`${stageDir}: falta ${file} (referenciado en "${markers.integridad}")`);
      continue;
    }
    const actual = sha256Normalized(readFileSync(filePath, "utf8"));
    if (actual !== expectedHash) {
      failures.push(
        `${stageDir}: ${file} no coincide con el hash de "${markers.integridad}" en CLOSURE.md`,
      );
    }
  }
  return failures;
}

export type { MasterMode };
