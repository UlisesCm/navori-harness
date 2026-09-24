/**
 * `navori plan` — classify a task's complexity/level, render its Markdown
 * from the JSON source, update its progress and validate it (R1, R11, R12,
 * R15).
 */
import { defineCommand } from "citty";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { classify, type ClassifyInput } from "../lib/plan/classify.ts";
import { checkWorkplan, formatCheckResult } from "../lib/plan/check.ts";
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
    // `criticalPaths` is optional (R9): a repo without `navori.config.json` or
    // without a `project` block simply falls back to the declared flag.
    let criticalPaths: string[] | undefined;
    try {
      criticalPaths = readConfig(resolve(cwd, "navori.config.json")).project?.criticalPaths;
    } catch {
      criticalPaths = undefined;
    }
    const input: ClassifyInput = {
      files: splitList(args.files),
      criticalArea: args.criticalArea,
      criticalPaths,
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

    let update: WorkplanUpdate;
    if (args.progress) {
      const [id, status] = args.progress.split("=") as [string, string];
      if (!id || !status) {
        process.stderr.write("--progress must look like A1=cumplido\n");
        process.exitCode = 1;
        return;
      }
      update = { kind: "progress", id, status: status as ProgressStatus };
    } else if (args.decision) {
      if (!args.date) {
        process.stderr.write("--decision requires --date\n");
        process.exitCode = 1;
        return;
      }
      update = { kind: "decision", text: args.decision, date: args.date };
    } else {
      process.stderr.write("plan update requires --progress or --decision\n");
      process.exitCode = 1;
      return;
    }

    let updated: Workplan;
    try {
      updated = applyWorkplanUpdate(plan, update);
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
    if (!result.ok) process.exitCode = 2;
  },
});

export const planCommand = defineCommand({
  meta: { name: "plan", description: "Classify, render, update and check a level-1/2 workplan" },
  subCommands: {
    classify: classifySubCommand,
    render: renderSubCommand,
    update: updateSubCommand,
    check: checkSubCommand,
  },
});
