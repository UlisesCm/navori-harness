/**
 * `navori plan` — classify a task's complexity/level, render its Markdown
 * from the JSON source, update its progress and validate it (R1, R11, R12,
 * R15).
 */
import { defineCommand } from "citty";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { classify, declaredFlagsFromSignals, type ClassifyInput } from "../lib/plan/classify.ts";
import { checkWorkplan, formatCheckResult } from "../lib/plan/check.ts";
import { evaluatePlanGate } from "../lib/plan/gate.ts";
import { applyWorkplanUpdate, renderWorkplan, type WorkplanUpdate } from "../lib/plan/render.ts";
import { WorkplanSchema, type ProgressStatus, type Workplan } from "../lib/plan/schema.ts";
import { writeFileAtomic } from "../lib/primitives/atomic.ts";
import { readConfig } from "../lib/config/config.ts";

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

function jsonPath(cwd: string, dir: string, feature: string): string {
  return resolve(cwd, dir, `workplan_${feature}.json`);
}

function mdPath(cwd: string, dir: string, feature: string): string {
  return resolve(cwd, dir, `workplan_${feature}.md`);
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

/** `project.criticalPaths`/`project.localSkills` (R9), falling back to
 * `undefined` for a repo without `navori.config.json` or without a `project`
 * block — shared by `--files` and `--diff` classification so neither
 * re-derives the read. */
function readProjectClassifyContext(cwd: string): {
  criticalPaths: string[] | undefined;
  localSkillIds: string[] | undefined;
} {
  try {
    const project = readConfig(resolve(cwd, "navori.config.json")).project;
    return { criticalPaths: project?.criticalPaths, localSkillIds: project?.localSkills };
  } catch {
    return { criticalPaths: undefined, localSkillIds: undefined };
  }
}

/** `git diff --name-only <base>...HEAD`'s touched files, repo-relative. */
function diffFiles(cwd: string, base: string): string[] {
  const out = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], {
    cwd,
    encoding: "utf8",
  });
  return out
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);
}

function writeWorkplanAndRender(cwd: string, dir: string, feature: string, plan: Workplan): void {
  mkdirSync(resolve(cwd, dir), { recursive: true });
  writeFileAtomic(jsonPath(cwd, dir, feature), `${JSON.stringify(plan, null, 2)}\n`);
  writeFileAtomic(mdPath(cwd, dir, feature), renderWorkplan(plan));
}

const shared = {
  feature: { type: "positional" as const, required: true, description: "Feature slug" },
  dir: { type: "string" as const, description: "Progress directory", default: ".claude/progress" },
  cwd: { type: "string" as const, description: "Repo root" },
  json: { type: "boolean" as const, description: "Output as JSON" },
};

const classifySubCommand = defineCommand({
  meta: { name: "classify", description: "Compute a task's complexity score and level" },
  args: {
    ...shared,
    files: {
      type: "string",
      description: "Comma-separated repo-relative paths touched by the task",
    },
    diff: {
      type: "string",
      description:
        "Classify `git diff --name-only <base>...HEAD` against the feature's workplan " +
        "instead of --files; value is the base ref (default origin/main, R21)",
    },
    criticalArea: { type: "boolean", description: "Declared: touches a critical area" },
    moneyCredentialsPii: {
      type: "boolean",
      description: "Declared: handles money, credentials or PII",
    },
    multiRepo: { type: "boolean", description: "Declared: spans two or more repos" },
    newExternalDependency: {
      type: "boolean",
      description: "Declared: adds a new external dependency",
    },
    sharedContract: { type: "boolean", description: "Declared: changes a shared contract" },
    dataSchemaMigration: {
      type: "boolean",
      description: "Declared: includes a data or schema migration",
    },
    bugWithoutRootCause: {
      type: "boolean",
      description: "Declared: bug worked without a confirmed root cause",
    },
  },
  run({ args }) {
    const cwd = resolve(args.cwd ?? process.cwd());
    // `criticalPaths`/`localSkills` are optional (R9): a repo without
    // `navori.config.json` or without a `project` block simply falls back to
    // the declared flag / the default "generated" classification.
    const { criticalPaths, localSkillIds } = readProjectClassifyContext(cwd);

    if (args.diff !== undefined) {
      classifyDiff(cwd, args.dir, args.feature, args.diff || "origin/main", args.json ?? false, {
        criticalPaths,
        localSkillIds,
      });
      return;
    }

    const input: ClassifyInput = {
      files: splitList(args.files),
      criticalArea: args.criticalArea,
      criticalPaths,
      localSkillIds,
      moneyCredentialsPii: args.moneyCredentialsPii,
      multiRepo: args.multiRepo,
      newExternalDependency: args.newExternalDependency,
      sharedContract: args.sharedContract,
      dataSchemaMigration: args.dataSchemaMigration,
      bugWithoutRootCause: args.bugWithoutRootCause,
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

/**
 * `navori plan classify <feature> --diff [<base>]` (R21) — classifies the
 * REAL diff (`git diff --name-only <base>...HEAD`) with the feature's
 * declared workplan signals (`declaredFlagsFromSignals`, no re-derivation of
 * `signals.ts`'s weights) and exits non-zero when that comes back at a higher
 * level than the workplan declared. The reviewer runs this exact command to
 * catch a diff that outgrew its plan.
 */
function classifyDiff(
  cwd: string,
  dir: string,
  feature: string,
  base: string,
  json: boolean,
  project: { criticalPaths: string[] | undefined; localSkillIds: string[] | undefined },
): void {
  const plan = readWorkplanOrExit(jsonPath(cwd, dir, feature));
  if (!plan) return;

  let files: string[];
  try {
    files = diffFiles(cwd, base);
  } catch (cause: unknown) {
    process.stderr.write(
      `git diff --name-only ${base}...HEAD failed: ${cause instanceof Error ? cause.message : String(cause)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const input: ClassifyInput = {
    files,
    criticalPaths: project.criticalPaths,
    localSkillIds: project.localSkillIds,
    ...declaredFlagsFromSignals(plan.classification.signals),
  };
  const result = classify(input);
  const exceedsDeclared = result.level > plan.level;

  if (json) {
    process.stdout.write(
      `${JSON.stringify({ ...result, base, files, declaredLevel: plan.level, exceedsDeclared })}\n`,
    );
  } else {
    process.stdout.write(
      `Diff vs ${base}: Complexity: ${result.score}/10 · Level: ${result.level} (declared: ${plan.level})\n` +
        `Signals: ${result.signals.join(", ") || "(none)"}\n` +
        (exceedsDeclared
          ? `Exceeds declared level: yes — the diff outgrew the workplan (level ${result.level} > ${plan.level}).\n`
          : `Exceeds declared level: no.\n`),
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
  meta: { name: "render", description: "Render workplan_<feature>.md from its JSON source" },
  args: shared,
  run({ args }) {
    const cwd = resolve(args.cwd ?? process.cwd());
    const plan = readWorkplanOrExit(jsonPath(cwd, args.dir, args.feature));
    if (!plan) return;
    writeFileAtomic(mdPath(cwd, args.dir, args.feature), renderWorkplan(plan));
    if (args.json) process.stdout.write(`${JSON.stringify({ rendered: true })}\n`);
  },
});

const updateSubCommand = defineCommand({
  meta: {
    name: "update",
    description: "Change an A<n>'s progress or append a decision, then re-render",
  },
  args: {
    ...shared,
    progress: { type: "string", description: "A<n>=status (pendiente|cumplido|bloqueado)" },
    decision: { type: "string", description: "Decision text to append" },
    date: { type: "string", description: "Decision date (ISO), required with --decision" },
  },
  run({ args }) {
    const cwd = resolve(args.cwd ?? process.cwd());
    const plan = readWorkplanOrExit(jsonPath(cwd, args.dir, args.feature));
    if (!plan) return;

    const progressEntries = normalizeProgressList(args.progress);
    let updates: WorkplanUpdate[];
    if (progressEntries.length > 0) {
      updates = [];
      for (const entry of progressEntries) {
        const [id, status] = entry.split("=") as [string, string];
        if (!id || !status) {
          process.stderr.write("--progress must look like A1=cumplido\n");
          process.exitCode = 1;
          return;
        }
        updates.push({ kind: "progress", id, status: status as ProgressStatus });
      }
    } else if (args.decision) {
      if (!args.date) {
        process.stderr.write("--decision requires --date\n");
        process.exitCode = 1;
        return;
      }
      updates = [{ kind: "decision", text: args.decision, date: args.date }];
    } else {
      process.stderr.write("plan update requires --progress or --decision\n");
      process.exitCode = 1;
      return;
    }

    // All-or-nothing: `applyWorkplanUpdate` returns a new Workplan without
    // mutating its input, so a failure mid-loop leaves `plan` (and thus the
    // file on disk) untouched.
    let updated: Workplan = plan;
    try {
      for (const update of updates) {
        updated = applyWorkplanUpdate(updated, update);
      }
    } catch (cause: unknown) {
      process.stderr.write(`${cause instanceof Error ? cause.message : "update failed"}\n`);
      process.exitCode = 1;
      return;
    }
    writeWorkplanAndRender(cwd, args.dir, args.feature, updated);
    if (args.json) process.stdout.write(`${JSON.stringify({ updated: true })}\n`);
  },
});

const checkSubCommand = defineCommand({
  meta: { name: "check", description: "Validate a workplan against its schema and R15's rules" },
  args: shared,
  run({ args }) {
    const cwd = resolve(args.cwd ?? process.cwd());
    const path = jsonPath(cwd, args.dir, args.feature);
    if (!existsSync(path)) {
      process.stderr.write(`workplan not found: ${path}\n`);
      process.exitCode = 1;
      return;
    }
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    const result = checkWorkplan(raw);
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
      // Malformed or empty stdin — nothing to gate against; a hard-fail here
      // would block every tool call the moment the payload shape changes.
      return;
    }
    const result = evaluatePlanGate(raw);
    if (result.decision === "deny") {
      process.stderr.write(`[navori] BLOCKED by plan-gate: ${result.reason}\n`);
      process.exitCode = 2;
    }
  },
});

export const planCommand = defineCommand({
  meta: { name: "plan", description: "Classify, render, update and check a level-1/2 workplan" },
  subCommands: {
    classify: classifySubCommand,
    render: renderSubCommand,
    update: updateSubCommand,
    check: checkSubCommand,
    gate: gateSubCommand,
  },
});
