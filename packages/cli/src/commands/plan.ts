/**
 * `navori plan` — classify a task's complexity/level, render its Markdown
 * from the JSON source, update its progress and validate it (R1, R11, R12,
 * R15).
 */
import { defineCommand } from "citty";
import { z } from "zod";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ensureStateDirectory,
  resolveStateRoot,
  stateArtifactPath,
  type StateRoot,
  writeStateFileAtomic,
} from "../lib/primitives/state-root.ts";
import {
  classify,
  declaredFlagsFromSignals,
  projectClassifyContext,
  type ClassifyInput,
} from "../lib/plan/classify.ts";
import { checkWorkplan, formatCheckResult, type CheckResult } from "../lib/plan/check.ts";
import {
  acknowledgePlanEscalation,
  applyPlanGate,
  recordAndCountRejections,
  UNREADABLE_PAYLOAD,
} from "../lib/plan/gate.ts";
import {
  applyMutationsToRaw,
  applyWorkplanUpdate,
  renderWorkplan,
  type RawMutation,
  type WorkplanUpdate,
} from "../lib/plan/render.ts";
import { withPlanStateLock } from "../lib/plan/update-lock.ts";
import { LockTimeoutError } from "../lib/primitives/lockfile.ts";
import { writeAcceptanceIndex } from "../lib/plan/acceptance-index.ts";
import { validateEvidence } from "../lib/plan/evidence.ts";
import { WorkplanSchema, type ProgressStatus, type Workplan } from "../lib/plan/schema.ts";
import { effectiveConfig, readConfig } from "../lib/config/config.ts";
import { appendCliEvent } from "../lib/audit/cli-event.ts";
import { parseExpected } from "../lib/plan/expected.ts";
import {
  isCittyCamelAlias,
  reparseBareValueFlags,
  restoreRepeatedFlags,
} from "../lib/primitives/args.ts";
import { resumePlans } from "../lib/plan/resume.ts";

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

/** citty hands a single `--progress` as a string but a repeated `--progress`
 * as an array — its declared arg type doesn't reflect that, so the value
 * arrives here as `unknown` and gets normalized to a flat list either way. */
function normalizeProgressList(value: unknown): string[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value.map((v) => String(v));
  return [String(value)];
}

/** One `--progress` entry (R10). */
const PROGRESS_ENTRY = /^(A\d+)=(pendiente|cumplido|bloqueado)$/;

function jsonPath(root: StateRoot, feature: string): string {
  return stateArtifactPath(root, `workplan_${feature}.json`);
}

/** A workplan draft's `files[].path` and, if well-formed, its
 * `classification.signals` — read WITHOUT `WorkplanSchema`, since a draft
 * written before `classify` ran has no `level`/`classification` yet and the
 * full schema would reject it. */
interface DraftClassifyContext {
  files: string[];
  signals: string[];
}

/** Best-effort read of `workplan_<feature>.json`'s draft shape for
 * `classify` (#1067): when `--files` is omitted, the CLI falls back to the
 * draft's declared files/signals instead of silently classifying an empty
 * list. Returns `undefined` when no draft exists at `path` — the caller
 * then keeps today's behavior. Throws when the file exists but isn't valid
 * JSON or its `files` entries aren't a well-formed `{ path: string }[]`, so
 * a broken draft fails loudly instead of returning a silent 0/10.
 */
function readDraftClassifyContext(path: string): DraftClassifyContext | undefined {
  if (!existsSync(path)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause: unknown) {
    throw new Error(
      `cannot read draft workplan ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`draft workplan ${path} is not a JSON object`);
  }
  const record = raw as Record<string, unknown>;
  const rawFiles = record.files;
  const files: string[] = [];
  if (rawFiles !== undefined) {
    if (!Array.isArray(rawFiles)) {
      throw new Error(`draft workplan ${path}: "files" must be an array`);
    }
    for (const entry of rawFiles) {
      if (
        typeof entry !== "object" ||
        entry === null ||
        typeof (entry as { path?: unknown }).path !== "string"
      ) {
        throw new Error(`draft workplan ${path}: every "files" entry needs a string "path"`);
      }
      files.push((entry as { path: string }).path);
    }
  }
  const rawSignals = (record.classification as { signals?: unknown } | undefined)?.signals;
  const signals: string[] = [];
  if (rawSignals !== undefined) {
    if (!Array.isArray(rawSignals) || rawSignals.some((s) => typeof s !== "string")) {
      throw new Error(`draft workplan ${path}: "classification.signals" must be a string array`);
    }
    signals.push(...(rawSignals as string[]));
  }
  return { files, signals };
}

function readWorkplan(path: string): Workplan {
  if (!existsSync(path)) throw new Error(`workplan not found: ${path}`);
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  return WorkplanSchema.parse(raw);
}

/** Reads and validates the workplan JSON, or prints the failure and sets a
 * non-zero exit code. Shared by `render` and `update`, whose failure mode on
 * a missing/invalid workplan is identical. */
function readWorkplanOrExit(path: string): Workplan | undefined {
  try {
    return readWorkplan(path);
  } catch (cause: unknown) {
    process.stderr.write(`${cause instanceof Error ? cause.message : "invalid workplan"}\n`);
    process.exitCode = 1;
    return undefined;
  }
}

/** Default `--diff` base: `origin/<prTarget>` of the repo's config, or
 * `origin/main` when there is no readable configuration (R18). */
function defaultDiffBase(cwd: string): string {
  try {
    const config = effectiveConfig(readConfig(resolve(cwd, "navori.config.json")));
    return `origin/${config.prTarget ?? config.branchBase}`;
  } catch {
    return "origin/main";
  }
}

/** Runs git in `cwd` and splits its NUL-terminated output (`-z`). */
function gitLines(cwd: string, args: string[]): string[] {
  const out = execFileSync("git", ["-c", "core.fsmonitor=false", "--no-optional-locks", ...args], {
    cwd,
    encoding: "utf8",
  });
  return out.split("\0").filter(Boolean);
}

/**
 * The work tree's touched files vs `base` (R18): the union of
 * `git diff --name-only <merge-base>` (committed + uncommitted tracked
 * changes) and `git ls-files --others --exclude-standard` (untracked files),
 * repo-relative, sorted and de-duplicated.
 */
function diffFiles(cwd: string, base: string): string[] {
  const mergeBase = gitLines(cwd, ["merge-base", "HEAD", base]).at(0)?.trim() ?? "";
  const tracked = gitLines(cwd, ["diff", "--name-only", "-z", mergeBase || base]);
  const untracked = gitLines(cwd, ["ls-files", "-z", "--others", "--exclude-standard"]);
  return [...new Set([...tracked, ...untracked])].sort();
}

/** Writes the JSON text as given (raw, so undeclared fields survive — R16),
 * then the Markdown rendered from the validated plan and the acceptance index.
 * Callers hold the plan-state lock (R11). */
function writeWorkplanAndRender(
  root: StateRoot,
  feature: string,
  jsonText: string,
  plan: Workplan,
): void {
  writeStateFileAtomic(root, `workplan_${feature}.json`, jsonText);
  writeStateFileAtomic(root, `workplan_${feature}.md`, renderWorkplan(plan));
  writeAcceptanceIndex(root);
}

/** Requires host-recorded execution in identified Claude, Pi and Codex sessions.
 * Claude's child and Pi's native session signals retain their existing priority.
 * An identified session with a present-but-unreadable config fails closed (R12). */
function evidenceRequired(cwd: string): boolean {
  const claudeChild = process.env.CLAUDE_CODE_CHILD_SESSION === "1";
  const piSession = /^[A-Za-z0-9._-]+$/.test(process.env.PI_SESSION_ID ?? "");
  const codexSession = Boolean(process.env.CODEX_THREAD_ID);
  if (!claudeChild && !piSession && !codexSession) return false;
  try {
    const { engines } = readConfig(resolve(cwd, "navori.config.json"));
    return claudeChild
      ? engines.includes("claude")
      : piSession
        ? engines.includes("pi")
        : engines.includes("codex");
  } catch {
    // Inside an identified session, a config that exists but can't be read
    // fails closed for every engine; an absent one means no navori setup (R12).
    return existsSync(resolve(cwd, "navori.config.json"));
  }
}

/** `worktree` declared by the feature's `impl_<feature>.json`, if readable. */
function readImplWorktree(root: StateRoot, feature: string): string | undefined {
  try {
    const path = stateArtifactPath(root, `impl_${feature}.json`);
    if (!existsSync(path)) return undefined;
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    const worktree = (raw as { worktree?: unknown } | null)?.worktree;
    return typeof worktree === "string" && worktree ? worktree : undefined;
  } catch {
    return undefined;
  }
}

/** Reports a rejected `cumplido` (R9): ERROR / WHY / FIX on stderr, or the
 * structured form with `--json`; always exit 1 and nothing written. */
function rejectCumplido(
  cwd: string,
  id: string,
  command: string,
  verdict: { why: string; fix: string },
  json: boolean,
): void {
  appendCliEvent(cwd, { name: "plan-update-evidence", verdict: "block" });
  if (json) {
    process.stdout.write(
      `${JSON.stringify({
        updated: false,
        id,
        error: {
          what: `${id} not marked cumplido — no valid evidence`,
          why: verdict.why,
          fix: verdict.fix,
          command,
        },
      })}\n`,
    );
  }
  process.stderr.write(
    `ERROR: ${id} not marked cumplido — no valid evidence\nWHY:   ${verdict.why}\nFIX:   ${verdict.fix}\n`,
  );
  process.exitCode = 1;
}

const shared = {
  feature: {
    type: "positional" as const,
    required: true as const,
    description: "Feature slug",
  },
  dir: { type: "string" as const, description: "Progress directory" },
  cwd: { type: "string" as const, description: "Repo root" },
  json: { type: "boolean" as const, description: "Output as JSON" },
};

const classifyArgs = {
  ...shared,
  files: {
    type: "string",
    description: "Comma-separated repo-relative paths touched by the task",
  },
  diff: {
    type: "string",
    description:
      "Classify the work tree's changes (committed, uncommitted and untracked) against the feature's workplan " +
      "instead of --files; value is the base ref (default origin/<prTarget>)",
  },
  criticalArea: {
    type: "boolean",
    description: "Declared: touches a critical area",
  },
  moneyCredentialsPii: {
    type: "boolean",
    description: "Declared: handles money, credentials or PII",
  },
  multiRepo: {
    type: "boolean",
    description: "Declared: spans two or more repos",
  },
  newExternalDependency: {
    type: "boolean",
    description: "Declared: adds a new external dependency",
  },
  sharedContract: {
    type: "boolean",
    description: "Declared: changes a shared contract",
  },
  dataSchemaMigration: {
    type: "boolean",
    description: "Declared: includes a data or schema migration",
  },
  bugWithoutRootCause: {
    type: "boolean",
    description: "Declared: bug worked without a confirmed root cause",
  },
} as const;

const classifySubCommand = defineCommand({
  meta: {
    name: "classify",
    description: "Compute a task's complexity score and level",
  },
  args: classifyArgs,
  run(context) {
    const args = reparseBareValueFlags(context.args, context.rawArgs, classifyArgs, ["diff"]);
    const root = resolveStateRoot({
      cwd: args.cwd ?? process.cwd(),
      feature: args.feature,
      dir: args.dir,
    });
    const cwd = root.cwd;
    // `criticalPaths`/`localSkills` are optional (R9): a repo without
    // `navori.config.json` or without a `project` block simply falls back to
    // the declared flag / the default "generated" classification.
    const { criticalPaths, localSkillIds } = projectClassifyContext(cwd);

    if (args.diff !== undefined) {
      classifyDiff(root, args.feature, args.diff || defaultDiffBase(cwd), args.json ?? false, {
        criticalPaths,
        localSkillIds,
      });
      return;
    }

    // No `--files`: fall back to the feature's draft workplan (files +
    // declared signals) instead of silently classifying an empty list
    // (#1067) — `--files` explicit always wins over the draft.
    let draft: DraftClassifyContext | undefined;
    if (args.files === undefined) {
      try {
        draft = readDraftClassifyContext(jsonPath(root, args.feature));
      } catch (cause: unknown) {
        process.stderr.write(
          `${cause instanceof Error ? cause.message : "invalid draft workplan"}\n`,
        );
        process.exitCode = 1;
        return;
      }
    }
    if (args.files === undefined && (draft?.files.length ?? 0) === 0) {
      process.stderr.write(
        "classify needs --files, --diff or a workplan draft with files; refusing to report level 0 for an empty list\n",
      );
      process.exitCode = 1;
      return;
    }
    const declaredFromDraft = draft ? declaredFlagsFromSignals(draft.signals) : {};

    const input: ClassifyInput = {
      files: args.files !== undefined ? splitList(args.files) : (draft?.files ?? []),
      criticalArea: args.criticalArea ?? declaredFromDraft.criticalArea,
      criticalPaths,
      localSkillIds,
      moneyCredentialsPii: args.moneyCredentialsPii ?? declaredFromDraft.moneyCredentialsPii,
      multiRepo: args.multiRepo ?? declaredFromDraft.multiRepo,
      newExternalDependency: args.newExternalDependency ?? declaredFromDraft.newExternalDependency,
      sharedContract: args.sharedContract ?? declaredFromDraft.sharedContract,
      dataSchemaMigration: args.dataSchemaMigration ?? declaredFromDraft.dataSchemaMigration,
      bugWithoutRootCause: args.bugWithoutRootCause ?? declaredFromDraft.bugWithoutRootCause,
    };
    const result = classify(input);
    if (args.json) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    process.stdout.write(
      `Complexity: ${result.score}/10 · Level: ${result.level}\nSignals: ${result.signals.join(", ") || "(none)"}\n`,
    );
  },
});

/** Pass-2 review depth published by `classify --diff` (R29, 0045 D9). */
interface ReviewDepth {
  reviewDepth: "light" | "full";
  /** Only on `full`: why the light review does not apply. */
  depthReason?:
    | "workplan"
    | "level"
    | "floor"
    | "criticalPaths-undeclared"
    | "critical-path-matched";
}

/**
 * `light` only when there is no workplan, the level is 0, no floor signal fired,
 * `project.criticalPaths` is declared and none of its globs matched the diff;
 * `full` otherwise. Without declared paths a critical file cannot be told apart
 * (`matchesCriticalPaths` is always false), so the absence itself forces `full`.
 */
function reviewDepth(
  hasWorkplan: boolean,
  result: { level: number; signals: string[] },
  criticalPaths: string[] | undefined,
): ReviewDepth {
  if (hasWorkplan) return { reviewDepth: "full", depthReason: "workplan" };
  if (result.level !== 0) return { reviewDepth: "full", depthReason: "level" };
  if (result.signals.some((signal) => signal.startsWith("floor:"))) {
    return { reviewDepth: "full", depthReason: "floor" };
  }
  if ((criticalPaths ?? []).length === 0) {
    return { reviewDepth: "full", depthReason: "criticalPaths-undeclared" };
  }
  if (result.signals.some((signal) => signal.startsWith("critical-area:"))) {
    return { reviewDepth: "full", depthReason: "critical-path-matched" };
  }
  return { reviewDepth: "light" };
}

/**
 * `navori plan classify <feature> --diff [<base>]` (R21) — classifies the
 * REAL diff (`git diff --name-only <merge-base>` plus untracked files) with the feature's
 * declared workplan signals (`declaredFlagsFromSignals`, no re-derivation of
 * `signals.ts`'s weights) and exits non-zero when that comes back at a higher
 * level than the workplan declared. The reviewer runs this exact command to
 * catch a diff that outgrew its plan.
 */
function classifyDiff(
  root: StateRoot,
  feature: string,
  base: string,
  json: boolean,
  project: {
    criticalPaths: string[] | undefined;
    localSkillIds: string[] | undefined;
  },
): void {
  const cwd = root.cwd;
  // No workplan (a `nivel-0:` delivery) is classified as declared level 0 with
  // no declared signals (0045 D9); an invalid one still fails.
  const hasWorkplan = existsSync(jsonPath(root, feature));
  const plan = hasWorkplan ? readWorkplanOrExit(jsonPath(root, feature)) : undefined;
  if (hasWorkplan && !plan) return;
  const declaredLevel = plan?.level ?? 0;

  let files: string[];
  try {
    files = diffFiles(cwd, base);
  } catch (cause: unknown) {
    process.stderr.write(
      `git diff --name-only ${base} failed: ${cause instanceof Error ? cause.message : String(cause)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const input: ClassifyInput = {
    files,
    criticalPaths: project.criticalPaths,
    localSkillIds: project.localSkillIds,
    ...(plan ? declaredFlagsFromSignals(plan.classification.signals) : {}),
  };
  const result = classify(input);
  const exceedsDeclared = result.level > declaredLevel;
  const depth = reviewDepth(hasWorkplan, result, project.criticalPaths);

  if (json) {
    process.stdout.write(
      `${JSON.stringify({ ...result, base, files, declaredLevel, exceedsDeclared, workplan: hasWorkplan, ...depth })}\n`,
    );
  } else {
    process.stdout.write(
      `Diff vs ${base}: Complexity: ${result.score}/10 · Level: ${result.level} (declared: ${declaredLevel})\n` +
        `Signals: ${result.signals.join(", ") || "(none)"}\n` +
        (exceedsDeclared
          ? `Exceeds declared level: yes — the diff outgrew the workplan (level ${result.level} > ${declaredLevel}).\n`
          : `Exceeds declared level: no.\n`) +
        `Review depth: ${depth.reviewDepth}${depth.depthReason ? ` (${depth.depthReason})` : ""}\n`,
    );
  }
  // Always sets a definitive value (never leaves the exit code whatever a
  // previous, unrelated command run in this same process left behind) — this
  // command can run repeatedly in one process (tests, `plan gate`'s own
  // subprocess reuse), and a stale `1` from an earlier invocation must not
  // leak into a passing one.
  process.exitCode = exceedsDeclared ? 1 : 0;
}

const renderSubCommand = defineCommand({
  meta: {
    name: "render",
    description: "Render workplan_<feature>.md from its JSON source",
  },
  args: shared,
  run({ args }) {
    const root = resolveStateRoot({
      cwd: args.cwd ?? process.cwd(),
      feature: args.feature,
      dir: args.dir,
    });
    // Early exit on a missing/invalid workplan, before the lock creates anything.
    if (!readWorkplanOrExit(jsonPath(root, args.feature))) return;
    try {
      const rendered = withPlanStateLock(root, () => {
        // Re-read under the lock: an `update` may have written since the check above.
        const plan = readWorkplanOrExit(jsonPath(root, args.feature));
        if (!plan) return false;
        writeStateFileAtomic(root, `workplan_${args.feature}.md`, renderWorkplan(plan));
        // Bootstraps the index the evidence hook reads (idempotent); `plan update` is the only other writer.
        writeAcceptanceIndex(root);
        return true;
      });
      if (rendered && args.json) process.stdout.write(`${JSON.stringify({ rendered: true })}\n`);
    } catch (cause: unknown) {
      if (!(cause instanceof LockTimeoutError)) throw cause;
      failUsage(cause.message);
    }
  },
});

const updateArgs = {
  ...shared,
  progress: {
    type: "string",
    description: "A<n>=status (pendiente|cumplido|bloqueado)",
  },
  decision: { type: "string", description: "Decision text to append" },
  date: {
    type: "string",
    description: "Decision date (ISO), required with --decision",
  },
} as const;

const updateSubCommand = defineCommand({
  meta: {
    name: "update",
    description: "Change an A<n>'s progress or append a decision, then re-render",
  },
  args: updateArgs,
  run(context) {
    const args = restoreRepeatedFlags(context.args, context.rawArgs, updateArgs);
    const root = resolveStateRoot({
      cwd: args.cwd ?? process.cwd(),
      feature: args.feature,
      dir: args.dir,
    });
    const plan = readWorkplanOrExit(jsonPath(root, args.feature));
    if (!plan) return;

    // Strict parsing (R10): nothing is written unless every flag is well-formed.
    const progressEntries = normalizeProgressList(args.progress);
    if (progressEntries.length > 0 && args.decision !== undefined) {
      failUsage("--progress and --decision are mutually exclusive");
      return;
    }
    if (args.date !== undefined && !z.iso.date().safeParse(args.date).success) {
      failUsage(`--date must be an ISO date (YYYY-MM-DD), got ${JSON.stringify(args.date)}`);
      return;
    }
    let updates: WorkplanUpdate[];
    if (progressEntries.length > 0) {
      updates = [];
      for (const entry of progressEntries) {
        const match = PROGRESS_ENTRY.exec(entry);
        if (!match) {
          failUsage(`--progress must look like A1=pendiente|cumplido|bloqueado, got "${entry}"`);
          return;
        }
        updates.push({
          kind: "progress",
          id: match[1] as string,
          status: match[2] as ProgressStatus,
        });
      }
    } else if (args.decision) {
      if (!args.date) {
        failUsage("--decision requires --date");
        return;
      }
      updates = [{ kind: "decision", text: args.decision, date: args.date }];
    } else {
      failUsage("plan update requires --progress or --decision");
      return;
    }

    // Validates every id against the workplan's criteria (unknown id throws)
    // before any evidence work; the result is discarded — phase 2 applies the
    // mutations to the raw JSON instead (R16).
    try {
      let probe: Workplan = plan;
      for (const update of updates) probe = applyWorkplanUpdate(probe, update);
    } catch (cause: unknown) {
      process.stderr.write(`${cause instanceof Error ? cause.message : "update failed"}\n`);
      process.exitCode = 1;
      return;
    }

    // Evidence gate (R8, R9): compares the host's recorded run with the
    // criterion; never executes the criterion's `command` (R7). Validated for
    // every `cumplido` before anything is written (all-or-nothing).
    const required = evidenceRequired(root.cwd);
    const mutations: RawMutation[] = [];
    const validatedCriteria = new Map<string, { command: string; expected: string }>();
    for (const update of updates) {
      if (update.kind === "decision") {
        mutations.push(update);
        continue;
      }
      mutations.push(update);
      if (update.status !== "cumplido") {
        mutations.push({ kind: "evidence", id: update.id, value: null });
        continue;
      }
      const criterion = plan.acceptance.find((a) => a.id === update.id);
      if (!criterion) continue;
      validatedCriteria.set(update.id, {
        command: criterion.command,
        expected: criterion.expected,
      });
      if (!required) {
        if (parseExpected(criterion.expected).kind !== "free") {
          rejectCumplido(
            root.cwd,
            update.id,
            criterion.command,
            {
              why: "comparison not recorded for the current expected value",
              fix: "Structured expectations require host-recorded evidence; an unsupported-engine acknowledgement cannot verify them.",
            },
            args.json ?? false,
          );
          return;
        }
        mutations.push({
          kind: "evidence",
          id: update.id,
          value: { kind: "unevidenced", reason: "engine-without-signal" },
        });
        process.stderr.write(
          `WARNING: ${update.id} marked cumplido without evidence — this engine/session ` +
            `exposes no verifiable Bash success signal\n`,
        );
        continue;
      }
      const verdict = validateEvidence({
        root,
        feature: args.feature,
        id: update.id,
        command: criterion.command,
        expected: criterion.expected,
        implWorktree: readImplWorktree(root, args.feature),
      });
      if (!verdict.ok) {
        rejectCumplido(root.cwd, update.id, criterion.command, verdict, args.json ?? false);
        return;
      }
      mutations.push({ kind: "evidence", id: update.id, value: verdict.evidence });
    }

    // Phase 2 (R11): re-read the RAW JSON and apply the mutations under the
    // state-root lock, so concurrent updates stack instead of overwriting.
    try {
      const wrote = withPlanStateLock(root, () => {
        const path = jsonPath(root, args.feature);
        let raw: unknown;
        try {
          raw = JSON.parse(readFileSync(path, "utf8"));
        } catch (cause: unknown) {
          failUsage(`cannot re-read ${path}: ${cause instanceof Error ? cause.message : cause}`);
          return false;
        }
        const rawAcceptance = (raw as { acceptance?: unknown } | null)?.acceptance;
        const rawCriteria = new Map<string, { command: unknown; expected: unknown }>(
          Array.isArray(rawAcceptance)
            ? rawAcceptance.map((a: { id?: unknown; command?: unknown; expected?: unknown }) => [
                a?.id as string,
                { command: a?.command, expected: a?.expected },
              ])
            : [],
        );
        for (const [id, criterion] of validatedCriteria) {
          if (
            rawCriteria.get(id)?.command !== criterion.command ||
            rawCriteria.get(id)?.expected !== criterion.expected
          ) {
            failUsage("criterion changed concurrently; rerun");
            return false;
          }
        }
        const next = applyMutationsToRaw(raw, mutations);
        const parsed = WorkplanSchema.safeParse(next);
        if (!parsed.success) {
          failUsage(`update would write an invalid workplan: ${parsed.error.message}`);
          return false;
        }
        writeWorkplanAndRender(
          root,
          args.feature,
          `${JSON.stringify(next, null, 2)}\n`,
          parsed.data,
        );
        return true;
      });
      if (wrote && args.json) process.stdout.write(`${JSON.stringify({ updated: true })}\n`);
    } catch (cause: unknown) {
      if (!(cause instanceof LockTimeoutError)) throw cause;
      failUsage(cause.message);
    }
  },
});

const checkSubCommand = defineCommand({
  meta: {
    name: "check",
    description: "Validate a workplan against its schema and R15's rules",
  },
  args: shared,
  run({ args }) {
    const root = resolveStateRoot({
      cwd: args.cwd ?? process.cwd(),
      feature: args.feature,
      dir: args.dir,
    });
    const path = jsonPath(root, args.feature);
    if (!existsSync(path)) {
      process.stderr.write(`workplan not found: ${path}\n`);
      process.exitCode = 1;
      return;
    }
    let raw: unknown;
    let unreadable: string | undefined;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (cause) {
      unreadable = cause instanceof Error ? cause.message : String(cause);
    }
    const result: CheckResult =
      unreadable === undefined
        ? checkWorkplan(raw, { cwd: root.cwd, feature: args.feature, evidence: "finding" })
        : { ok: false, findings: [{ rule: "schema", message: unreadable }], warnings: [] };
    process.stdout.write(`${args.json ? JSON.stringify(result) : formatCheckResult(result)}\n`);
    // Explicit on both branches — see `classifyDiff`'s comment on the same
    // pattern: a stale non-zero code from an earlier command run in this
    // same process must not leak into a passing `check`.
    process.exitCode = result.ok ? 0 : 2;
  },
});

const gateSubCommand = defineCommand({
  meta: {
    name: "gate",
    description:
      "PreToolUse(Agent) gate for harness.planTiers (R16/R17/R19) — reads the hook payload from stdin",
  },
  args: {},
  run() {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(0, "utf8"));
    } catch {
      // Unreadable stdin is a payload problem: the gate denies it under planTiers (R4).
      raw = UNREADABLE_PAYLOAD;
    }
    applyPlanGate(raw);
  },
});

const acknowledgeArgs = {
  feature: shared.feature,
  cwd: shared.cwd,
  json: shared.json,
  opening: {
    type: "string",
    required: true as const,
    description: "Exact normal dispatch opening",
  },
  decision: {
    type: "string",
    description: "Explicit user workflow escalation decision retained by the orchestrator",
  },
  inspect: {
    type: "boolean",
    description: "Read-only terminal grant and current snapshot inspection",
  },
  "continue-after": { type: "string", description: "Explicit consumed predecessor reference" },
  "authorization-id": {
    type: "string",
    description: "Operator-assigned intent/idempotency identifier, not authentication",
  },
  snapshot: { type: "string", description: "Expected current snapshot SHA-256" },
} as const;

const acknowledgeSubCommand = defineCommand({
  meta: {
    name: "acknowledge",
    description:
      "Record one bound user workflow escalation decision; does not approve review or protected effects",
  },
  args: acknowledgeArgs,
  run(context) {
    const args = restoreRepeatedFlags(context.args, context.rawArgs, acknowledgeArgs);
    try {
      const strings = new Set([
        "feature",
        "cwd",
        "opening",
        "decision",
        "continue-after",
        "authorization-id",
        "snapshot",
      ]);
      const booleans = new Set(["json", "inspect"]);
      for (const [key, value] of Object.entries(args)) {
        if (key === "_") {
          if (!Array.isArray(value) || value.length !== 1)
            throw new Error("exactly one feature required");
        } else if (isCittyCamelAlias(key, [...strings, ...booleans])) {
          continue;
        } else if (
          value !== undefined &&
          !(strings.has(key)
            ? typeof value === "string"
            : booleans.has(key) && typeof value === "boolean")
        ) {
          throw new Error(`unknown or repeated acknowledgement flag: ${key}`);
        }
      }
      const supplied = [args["continue-after"], args["authorization-id"], args.snapshot];
      const continuing = supplied.some((value) => value !== undefined);
      if (continuing && supplied.some((value) => value === undefined))
        throw new Error("continue-after, authorization-id and snapshot are required together");
      if (args.inspect ? args.decision !== undefined || continuing : !args.decision?.trim())
        throw new Error("inspect excludes mutation inputs; mutations require decision");
      const result = acknowledgePlanEscalation(
        args.cwd ?? process.cwd(),
        args.feature,
        args.opening,
        args.decision ?? "",
        {
          inspect: args.inspect,
          ...(continuing
            ? {
                continuation: {
                  continueAfter: args["continue-after"]!,
                  authorizationId: args["authorization-id"]!,
                  snapshot: args.snapshot!,
                },
              }
            : {}),
        },
      );
      process.stdout.write(
        `${args.json || result.status === "inspected" ? JSON.stringify(result) : `${result.feature}: ${result.status}${"reference" in result && result.reference ? ` ${result.reference}` : ""}`}\n`,
      );
      process.exitCode = 0;
    } catch (cause: unknown) {
      const error = cause instanceof Error ? cause.message : "invalid escalation acknowledgement";
      process.stdout.write(`${args.json ? JSON.stringify({ status: "denied", error }) : error}\n`);
      process.exitCode = 2;
    }
  },
});

/** Exits 1 with a one-line usage error, writing nothing. */
function failUsage(message: string): void {
  process.stderr.write(`ERROR: ${message}\n`);
  process.exitCode = 1;
}

/**
 * `navori plan escalation-reset` (R9): the user's explicit restart of the
 * rejection count after two `CHANGES_REQUESTED` at level >= 2. Appends one
 * `reset` line to the gate log. A local seatbelt, not an authenticated
 * attestation: the host asks for confirmation (ask rule + hook).
 */
const escalationResetSubCommand = defineCommand({
  meta: {
    name: "escalation-reset",
    description: "Restart the gate's rejection count for a level >= 2 feature (user approval)",
  },
  args: {
    ...shared,
    "approved-by": { type: "string", description: "Must be user" },
    reason: { type: "string", description: "Why another review round is authorized" },
  },
  run({ args }) {
    const reason = typeof args.reason === "string" ? args.reason.trim() : "";
    if (args["approved-by"] !== "user") {
      return failUsage("escalation-reset requires --approved-by user");
    }
    if (reason === "") return failUsage("escalation-reset requires a non-empty --reason");
    if (reason.length > 4096) return failUsage("escalation-reset reason exceeds 4096 characters");
    const root = resolveStateRoot({
      cwd: args.cwd ?? process.cwd(),
      feature: args.feature,
      dir: args.dir,
    });
    const path = jsonPath(root, args.feature);
    if (!existsSync(path)) return failUsage(`workplan not found: ${path}`);
    let level: unknown;
    try {
      level = (JSON.parse(readFileSync(path, "utf8")) as { level?: unknown } | null)?.level;
    } catch {
      return failUsage(`${path} is not valid JSON; run \`navori plan check ${args.feature}\``);
    }
    if (typeof level !== "number" || level < 2) {
      return failUsage(
        "escalation-reset applies to level >= 2 workplans; at level 0/1 the way out is a new " +
          "solution and its challenge",
      );
    }
    const { count } = recordAndCountRejections(root, args.feature);
    if (count < 2) {
      return failUsage(`escalation-reset needs two recorded rejections (found ${count})`);
    }
    const entry = {
      ts: new Date().toISOString(),
      kind: "reset",
      approvedBy: "user",
      reason,
      rejectionsBefore: count,
    };
    if (Buffer.byteLength(JSON.stringify(entry)) > 8192)
      return failUsage("escalation-reset record exceeds 8192 bytes");
    ensureStateDirectory(root);
    appendFileSync(
      stateArtifactPath(root, `workplan_${args.feature}.gate.jsonl`),
      `${JSON.stringify(entry)}\n`,
    );
    appendCliEvent(root.cwd, { name: "plan-escalation-reset", verdict: "allow" });
    if (args.json)
      process.stdout.write(`${JSON.stringify({ reset: true, rejectionsBefore: count })}\n`);
  },
});

export const planCommand = defineCommand({
  meta: {
    name: "plan",
    description: "Classify, render, update and check a level-1/2 workplan",
  },
  subCommands: {
    resume: defineCommand({
      meta: {
        name: "resume",
        description: "Revalidate continuity without reviving stale guarantees",
      },
      args: { json: { type: "boolean", description: "Output JSON" } },
      run({ args }) {
        const result = resumePlans(process.cwd());
        process.stdout.write(
          `${args.json ? JSON.stringify(result) : JSON.stringify(result, null, 2)}\n`,
        );
      },
    }),
    classify: classifySubCommand,
    render: renderSubCommand,
    update: updateSubCommand,
    check: checkSubCommand,
    gate: gateSubCommand,
    acknowledge: acknowledgeSubCommand,
    "escalation-reset": escalationResetSubCommand,
  },
});
