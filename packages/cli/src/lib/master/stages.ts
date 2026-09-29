/**
 * `_master/index.json` registry (spec 0034, design.md D11 and Components):
 * reads and validates the index (schema + filesystem invariants), resolves
 * the active stage for every `navori master` subcommand, computes the next
 * stage number, validates a proposed slug and renders `INDEX.md`
 * deterministically. The only module that knows which stage is active (R3,
 * R5, R50, R51, R53, R54).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { MasterIndexSchema, type MasterIndex, type StageEntry } from "./schema.ts";

export const MASTER_DIR_NAME = "_master";

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_SLUG_LENGTH = 40;

/** `<specsDir>/_master` — absolute path. */
export function masterDirPath(cwd: string, specsDir: string): string {
  return resolve(cwd, specsDir, MASTER_DIR_NAME);
}

export function indexJsonPath(cwd: string, specsDir: string): string {
  return join(masterDirPath(cwd, specsDir), "index.json");
}

export function indexMdPath(cwd: string, specsDir: string): string {
  return join(masterDirPath(cwd, specsDir), "INDEX.md");
}

/** Slug shape shared by `init <slug>` and the schema: kebab-case, max 40
 * chars (design.md "Otras decisiones"). */
export function isValidSlug(slug: string): boolean {
  return slug.length > 0 && slug.length <= MAX_SLUG_LENGTH && SLUG_PATTERN.test(slug);
}

export function stageDirName(number: number, slug: string): string {
  return `${String(number).padStart(2, "0")}-${slug}`;
}

export class MasterIndexError extends Error {}

/**
 * Filesystem invariants beyond what the zod schema can see: every `NN-*`
 * folder under `_master/` has a matching entry, and every entry has a folder
 * on disk. `dir` vs `number`/`slug` and "at most one activa" are schema-level
 * (StageEntrySchema, MasterIndexSchema) and already enforced by `parse`.
 */
function checkFilesystemInvariants(cwd: string, specsDir: string, index: MasterIndex): string[] {
  const dir = masterDirPath(cwd, specsDir);
  const errors: string[] = [];
  const entryDirs = new Set(index.stages.map((s) => s.dir));

  let onDisk: string[] = [];
  try {
    onDisk = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d{2}-/.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    onDisk = [];
  }
  for (const name of onDisk) {
    if (!entryDirs.has(name)) {
      errors.push(`${name}/ has no entry in index.json`);
    }
  }
  for (const stage of index.stages) {
    // The active stage's folder may legitimately be missing: `init` writes
    // `index.json` before materializing the folder (design.md Components), so
    // a cut between those two steps must still let a second `init` run read
    // the index and repair it. A missing folder on a CLOSED/etc. entry is the
    // real inconsistency — that one has no repair command.
    if (stage.state !== "activa" && !existsSync(join(dir, stage.dir))) {
      errors.push(`index.json entry ${stage.dir} has no folder on disk`);
    }
  }
  return errors;
}

/**
 * Reads and validates `_master/index.json`. Returns `null` when the file does
 * not exist yet (first use of the flow, R3). Throws `MasterIndexError` naming
 * every inconsistency found (schema violation or folder/entry mismatch) — no
 * mutator runs on top of a broken index (design.md Contracts).
 */
export function readMasterIndex(cwd: string, specsDir: string): MasterIndex | null {
  const path = indexJsonPath(cwd, specsDir);
  if (!existsSync(path)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new MasterIndexError(`invalid JSON in ${path}: ${(cause as Error).message}`);
  }

  const parsed = MasterIndexSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new MasterIndexError(`${path} failed validation: ${issues}`);
  }

  const fsErrors = checkFilesystemInvariants(cwd, specsDir, parsed.data);
  if (fsErrors.length > 0) {
    throw new MasterIndexError(fsErrors.join("; "));
  }
  return parsed.data;
}

export function activeStage(index: MasterIndex | null): StageEntry | null {
  return index?.stages.find((s) => s.state === "activa") ?? null;
}

/** The last stage that closed as a delivery (`cerrada`), in registration
 * order — the entry point (R51) and D11's context window both key off it. */
export function lastClosedStage(index: MasterIndex | null): StageEntry | null {
  if (!index) return null;
  const closed = index.stages.filter((s) => s.state === "cerrada");
  return closed.length > 0 ? closed[closed.length - 1]! : null;
}

/** The next stage number: the highest registered plus one. Never reuses a
 * gap left by a deleted folder (design.md "Otras decisiones"). */
export function nextStageNumber(index: MasterIndex | null): number {
  if (!index || index.stages.length === 0) return 1;
  return Math.max(...index.stages.map((s) => s.number)) + 1;
}

export interface ArchitectContext {
  /** Paths (relative to `_master/`) to read completely. */
  full: string[];
  /** Paths (relative to `_master/`) to read only as reference/citation. */
  referenceOnly: string[];
}

/**
 * D11's reading list for the three `architect`s and the consolidation step,
 * in stage ≥2: the last `cerrada` stage's `MASTER.md`/`DECISIONS.md`/
 * `CLOSURE.md` in full, plus `DECISIONS.md`/`CLOSURE.md` of every
 * `convertida`/`abandonada` stage after it; earlier stages contribute only
 * their `CLOSURE.md`, plus `INDEX.md`. Returns `null` for stage 1 (no
 * non-active stage exists yet to read).
 */
export function contextForArchitects(index: MasterIndex): ArchitectContext | null {
  const nonActive = index.stages.filter((s) => s.state !== "activa");
  if (nonActive.length === 0) return null;

  const stages = index.stages;
  let lastClosedPos = -1;
  for (let i = stages.length - 1; i >= 0; i--) {
    if (stages[i]!.state === "cerrada") {
      lastClosedPos = i;
      break;
    }
  }

  if (lastClosedPos === -1) {
    // No stage ever reached `cerrada`: read every non-active stage's
    // DECISIONS.md and CLOSURE.md in full (design.md D11).
    const full = nonActive.flatMap((s) => [`${s.dir}/DECISIONS.md`, `${s.dir}/CLOSURE.md`]);
    return { full, referenceOnly: [] };
  }

  const lastClosed = stages[lastClosedPos]!;
  const full: string[] = [
    `${lastClosed.dir}/MASTER.md`,
    `${lastClosed.dir}/DECISIONS.md`,
    `${lastClosed.dir}/CLOSURE.md`,
  ];
  for (let i = lastClosedPos + 1; i < stages.length; i++) {
    const s = stages[i]!;
    if (s.state === "convertida" || s.state === "abandonada") {
      full.push(`${s.dir}/DECISIONS.md`, `${s.dir}/CLOSURE.md`);
    }
  }

  const referenceOnly: string[] = [];
  for (let i = 0; i < lastClosedPos; i++) {
    referenceOnly.push(`${stages[i]!.dir}/CLOSURE.md`);
  }
  referenceOnly.push("INDEX.md");

  return { full, referenceOnly };
}

/**
 * Deterministic `INDEX.md` render (R54, design.md D5): the first line has the
 * exact fixed form the SessionStart hook's fallback parses
 * (`master-plan-context.sh`), so it must never change shape.
 */
export function renderIndexMd(index: MasterIndex, specsDir: string): string {
  const active = activeStage(index);
  const firstLine = active
    ? `Etapa activa: ${specsDir}/${MASTER_DIR_NAME}/${active.dir}/STATUS.md`
    : "Etapa activa: ninguna";

  const header = "| Número | Slug | Estado | Apertura | Cierre | Enlace |";
  const separator = "|---|---|---|---|---|---|";
  const linkFor = (stage: StageEntry): string => {
    if (stage.state === "activa") return `[MASTER.md](${stage.dir}/MASTER.md)`;
    return `[CLOSURE.md](${stage.dir}/CLOSURE.md)`;
  };
  const rows = index.stages.map(
    (s) =>
      `| ${s.number} | ${s.slug} | ${s.state} | ${s.openedAt} | ${s.closedAt ?? "—"} | ${linkFor(s)} |`,
  );

  return [firstLine, "", header, separator, ...rows, ""].join("\n");
}
