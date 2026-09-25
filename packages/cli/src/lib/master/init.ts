/**
 * `navori master init <slug>` (R3, R4, R5, R16): opens or completes the
 * active master-plan stage, in the order design.md's Components section
 * fixes — `index.json`, the stage folder (`context/raw/.gitignore` included),
 * `state.json`, `INDEX.md`, then `harness.masterPlan` and the render. Every
 * step is creation-only and guarded by `existsSync`, so a run cut at any
 * point is completed by a second run without rewriting what already exists.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative, resolve } from "node:path";
import { readConfig, writeConfig } from "../config/config.ts";
import { writeFileAtomic } from "../primitives/atomic.ts";
import { runRender } from "../../commands/render.ts";
import {
  activeStage,
  indexJsonPath,
  indexMdPath,
  isValidSlug,
  masterDirPath,
  nextStageNumber,
  readMasterIndex,
  renderIndexMd,
  stageDirName,
} from "./stages.ts";
import { computeSignal, type MasterSignal } from "./signal.ts";
import {
  MasterStateSchema,
  type MasterIndex,
  type MasterState,
  type StageEntry,
} from "./schema.ts";

export class MasterInitError extends Error {}

export interface MasterInitResult {
  stage: { number: number; slug: string; dir: string };
  phase: string;
  mode: MasterState["mode"];
  signal: MasterSignal;
  /** True when an active stage already existed before this call — R5/R53. */
  alreadyActive: boolean;
  /** True when a slug was passed but ignored because a stage was already
   * active (R5). The CLI layer exits 1 on this. */
  requestedSlugIgnored: boolean;
  warnings: string[];
}

const GITIGNORE_CONTENT = "*\n!.gitignore\n";
const MAX_STAGE_NUMBER = 99;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function stagePaths(cwd: string, specsDir: string, dir: string) {
  const root = join(masterDirPath(cwd, specsDir), dir);
  return {
    root,
    rawDir: join(root, "context", "raw"),
    mdDir: join(root, "context", "md"),
    plansDir: join(root, "plans"),
    gitignore: join(root, "context", "raw", ".gitignore"),
    stateJson: join(root, "state.json"),
  };
}

/** `raw/` already had files git was tracking (a rare hand-made mistake before
 * `init` ran): warns and does NOT touch git's index — navori never mutates
 * git state the user didn't ask for (Failure modes). */
function warnIfTracked(cwd: string, rawDir: string): string | null {
  const rel = relative(cwd, rawDir);
  try {
    const out = execFileSync("git", ["ls-files", rel], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (out.length === 0) return null;
    return `${rel} ya tenía archivos rastreados por git; navori no los sacó del índice: ${out
      .split("\n")
      .join(", ")}`;
  } catch {
    return null;
  }
}

function ensureRawGitignore(path: string): void {
  if (existsSync(path)) return;
  writeFileAtomic(path, GITIGNORE_CONTENT);
}

function openNewStage(
  index: MasterIndex | null,
  slug: string,
): { index: MasterIndex; entry: StageEntry } {
  if (!isValidSlug(slug)) {
    throw new MasterInitError(
      `invalid slug "${slug}": must be kebab-case (lowercase letters, digits and hyphens), max 40 chars`,
    );
  }
  const number = nextStageNumber(index);
  if (number > MAX_STAGE_NUMBER) {
    throw new MasterInitError(
      `cannot open stage ${number}: stage numbers are two digits (max ${MAX_STAGE_NUMBER})`,
    );
  }
  const entry: StageEntry = {
    number,
    slug,
    dir: stageDirName(number, slug),
    state: "activa",
    openedAt: today(),
    closedAt: null,
    spec: null,
  };
  return { index: { version: 1, stages: [...(index?.stages ?? []), entry] }, entry };
}

/**
 * Runs (or completes) `navori master init`. Throws `MasterInitError` for any
 * precondition failure (missing `sdd.enabled`, invalid slug, no active stage
 * without a slug, a broken `index.json`) — the CLI layer reports it and exits
 * 1, writing nothing else.
 */
export function runMasterInit(cwd: string, slug: string | undefined): MasterInitResult {
  const configPath = resolve(cwd, "navori.config.json");
  const config = readConfig(configPath);
  if (config.sdd?.enabled === false) {
    throw new MasterInitError(
      "navori master init requires sdd.enabled (navori.config.json): set it to true to use the master-plan flow",
    );
  }
  const specsDir = config.sdd?.specsDir ?? "specs";

  mkdirSync(masterDirPath(cwd, specsDir), { recursive: true });

  const existingIndex = readMasterIndex(cwd, specsDir);
  const preexistingActive = activeStage(existingIndex);
  const warnings: string[] = [];
  let index: MasterIndex;
  let active: StageEntry;
  let requestedSlugIgnored = false;

  if (preexistingActive && existingIndex) {
    index = existingIndex;
    active = preexistingActive;
    if (slug) requestedSlugIgnored = true;
  } else {
    if (!slug) {
      throw new MasterInitError(
        "no active stage: 'navori master init <slug>' requires a slug to open the first one",
      );
    }
    const opened = openNewStage(existingIndex, slug);
    index = opened.index;
    active = opened.entry;
    writeFileAtomic(indexJsonPath(cwd, specsDir), `${JSON.stringify(index, null, 2)}\n`);
  }

  const paths = stagePaths(cwd, specsDir, active.dir);
  mkdirSync(paths.rawDir, { recursive: true });
  mkdirSync(paths.mdDir, { recursive: true });
  mkdirSync(paths.plansDir, { recursive: true });

  const trackedWarning = warnIfTracked(cwd, paths.rawDir);
  if (trackedWarning) warnings.push(trackedWarning);
  ensureRawGitignore(paths.gitignore);

  if (!existsSync(paths.stateJson)) {
    const state: MasterState = {
      version: 1,
      phase: "context",
      // Stage ≥2 registers `en-curso` right away (R16): the previous stage
      // already left code written, so there is nothing to ask.
      mode: active.number >= 2 ? "en-curso" : null,
      signal: computeSignal(cwd),
      outcome: null,
      history: [{ phase: "context", at: today() }],
    };
    writeFileAtomic(paths.stateJson, `${JSON.stringify(state, null, 2)}\n`);
  }

  writeFileAtomic(indexMdPath(cwd, specsDir), renderIndexMd(index, specsDir));

  if (config.harness?.masterPlan !== true) {
    writeConfig(configPath, {
      ...config,
      harness: { ...(config.harness ?? {}), masterPlan: true },
    });
    runRender(cwd);
  }

  const stateRaw: unknown = JSON.parse(readFileSync(paths.stateJson, "utf8"));
  const state = MasterStateSchema.parse(stateRaw);
  const signal = computeSignal(cwd);

  return {
    stage: { number: active.number, slug: active.slug, dir: active.dir },
    phase: state.phase,
    mode: state.mode,
    signal,
    alreadyActive: preexistingActive !== null,
    requestedSlugIgnored,
    warnings,
  };
}
