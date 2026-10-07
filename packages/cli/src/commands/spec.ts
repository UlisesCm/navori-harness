/**
 * `navori spec` — classify a spec's `tasks.md` as one PR or one PR per
 * delivery (spec 0044 R4-R9). Read-only: it never runs the acceptance
 * commands and never opens a PR (invariant 9).
 */
import { defineCommand } from "citty";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { ConfigError, readConfig } from "../lib/config/config.ts";
import {
  DEFAULT_DELIVERIES,
  resolveDeliveryThresholds,
  type DeliveryThresholds,
} from "../lib/config/schema.ts";
import { checkSpec } from "../lib/spec/check.ts";
import { classifySpec, type SpecWarning } from "../lib/spec/classify.ts";
import { locateSpecDir } from "../lib/spec/locate.ts";
import { parseRequirementIds } from "../lib/spec/requirements.ts";
import { parseTasks, type ParsedTasks } from "../lib/spec/tasks.ts";

/** Version of the `--json` contract; additive changes only (design "Contracts"). */
const FORMAT_VERSION = 1;

/** ERROR / WHY / FIX, the same triple `navori plan update` prints. */
interface Failure {
  what: string;
  why: string;
  fix: string;
}

/** Everything a `spec` subcommand needs once the feature resolved. */
interface SpecContext {
  feature: string;
  /** Repo-relative, forward-slash path of `tasks.md` (for messages and JSON). */
  tasksPath: string;
  /** The requirements file next to `tasks.md`. */
  requirementsFile: string;
  thresholds: DeliveryThresholds;
  parsed: ParsedTasks;
}

const shared = {
  feature: { type: "positional" as const, required: true, description: "Spec directory name" },
  cwd: { type: "string" as const, description: "Repo root" },
  json: { type: "boolean" as const, description: "Output as JSON" },
};

/** The ERROR / WHY / FIX triple on stderr. */
function printFailure(failure: Failure): void {
  process.stderr.write(`ERROR: ${failure.what}\nWHY:   ${failure.why}\nFIX:   ${failure.fix}\n`);
}

/** Prints a failure as ERROR / WHY / FIX on stderr (plus JSON on stdout) and exits 1. */
function fail(feature: string, failure: Failure, json: boolean): undefined {
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ formatVersion: FORMAT_VERSION, feature, error: failure })}\n`,
    );
  }
  printFailure(failure);
  process.exitCode = 1;
  return undefined;
}

/** Warnings go to stderr with the `WARN:` prefix, in text and JSON modes alike. */
function printWarnings(warnings: readonly SpecWarning[]): void {
  for (const warning of warnings) process.stderr.write(`WARN:  ${warning.message}\n`);
}

/**
 * Resolves config, spec directory and `tasks.md`, or reports the failure
 * (R3 invalid config, R9 unreadable `tasks.md`, path outside `specsDir`) and
 * returns `undefined`. Shared by every `spec` subcommand.
 */
function loadSpec(
  feature: string,
  cwdArg: string | undefined,
  json: boolean,
): SpecContext | undefined {
  const cwd = resolve(cwdArg ?? process.cwd());
  const configPath = join(cwd, "navori.config.json");
  let specsDir = "specs";
  let thresholds: DeliveryThresholds = { ...DEFAULT_DELIVERIES };
  if (existsSync(configPath)) {
    try {
      const config = readConfig(configPath);
      specsDir = config.sdd?.specsDir ?? specsDir;
      thresholds = resolveDeliveryThresholds(config);
    } catch (cause: unknown) {
      if (!(cause instanceof ConfigError)) throw cause;
      const issues = (cause.issues ?? []).map((i) => `${i.path.join(".")}: ${i.message}`);
      return fail(
        feature,
        {
          what: "navori.config.json is invalid",
          why: issues.length > 0 ? issues.join("; ") : cause.message,
          fix: `correct the field in ${configPath}, then run the command again`,
        },
        json,
      );
    }
  }

  const location = locateSpecDir(cwd, specsDir, feature);
  if (!location.ok) {
    return fail(
      feature,
      {
        what: `cannot resolve spec "${feature}"`,
        why: location.why,
        fix: `pass the name of a directory under ${specsDir}/`,
      },
      json,
    );
  }
  const tasksFile = join(location.dir, "tasks.md");
  const tasksPath = relative(cwd, tasksFile).split("\\").join("/");
  let text: string;
  try {
    text = readFileSync(tasksFile, "utf8");
  } catch (cause: unknown) {
    return fail(
      feature,
      {
        what: `cannot read ${tasksPath}`,
        why: `expected ${tasksPath} (${cause instanceof Error ? cause.message : String(cause)})`,
        fix: `create ${tasksPath} (see the spec-bootstrap skill) or check the spec name`,
      },
      json,
    );
  }
  return {
    feature,
    tasksPath,
    requirementsFile: join(location.dir, "requirements.md"),
    thresholds,
    parsed: parseTasks(text),
  };
}

const classifySubCommand = defineCommand({
  meta: {
    name: "classify",
    description: "Classify a spec as single (1 PR) or split (1 PR per delivery)",
  },
  args: shared,
  run({ args }) {
    const spec = loadSpec(args.feature, args.cwd, args.json ?? false);
    if (!spec) return;
    const classification = classifySpec(spec.parsed, spec.thresholds);
    printWarnings(classification.warnings);
    const { error, ...rest } = classification;
    if (args.json) {
      process.stdout.write(
        `${JSON.stringify({
          formatVersion: FORMAT_VERSION,
          feature: spec.feature,
          tasksPath: spec.tasksPath,
          ...rest,
          error,
        })}\n`,
      );
    } else {
      const s = classification.signals;
      process.stdout.write(
        `${spec.feature}: ${classification.shape} (${classification.prCount} PR${classification.prCount === 1 ? "" : "s"}) — ` +
          `${s.tasks} tasks, ${s.deliveries} deliveries, ${s.estimatedLoc} estimated LOC ` +
          `(thresholds >${classification.thresholds.splitMinTasks} tasks, >${classification.thresholds.splitMinLoc} LOC, max ${classification.thresholds.maxPrsPerSpec} PRs)\n`,
      );
    }
    if (error) {
      printFailure(error);
      process.exitCode = 1;
      return;
    }
    // Explicit on every branch: a stale non-zero code from an earlier command
    // in this same process must not leak into a passing run.
    process.exitCode = 0;
  },
});

const checkSubCommand = defineCommand({
  meta: {
    name: "check",
    description: "Validate a spec's tasks.md: milestones, criteria, coverage, vertical deliveries",
  },
  args: shared,
  run({ args }) {
    const json = args.json ?? false;
    const spec = loadSpec(args.feature, args.cwd, json);
    if (!spec) return;
    let requirementIds: string[] | undefined;
    try {
      requirementIds = parseRequirementIds(readFileSync(spec.requirementsFile, "utf8"));
    } catch {
      requirementIds = undefined;
    }
    const result = checkSpec(spec.parsed, spec.thresholds, requirementIds);
    const errors = result.findings.filter((f) => f.severity === "error");
    const where = (line: number | undefined): string =>
      line === undefined ? spec.tasksPath : `${spec.tasksPath}:${line}`;
    for (const f of result.findings) {
      if (f.severity === "warning") {
        process.stderr.write(`WARN:  [${f.rule}] ${where(f.line)} — ${f.message}\n`);
      }
    }
    if (json) {
      process.stdout.write(
        `${JSON.stringify({
          formatVersion: FORMAT_VERSION,
          feature: spec.feature,
          format: result.format,
          ok: result.ok,
          findings: result.findings,
          classification: result.classification,
        })}\n`,
      );
    } else {
      process.stdout.write(
        `${spec.feature}: ${result.ok ? "ok" : "findings"} — ${errors.length} error(s), ${result.findings.length - errors.length} warning(s)\n`,
      );
    }
    if (errors.length > 0) {
      printFailure({
        what: `${spec.tasksPath} has ${errors.length} error finding(s)`,
        why: errors.map((f) => `[${f.rule}] ${where(f.line)} — ${f.message}`).join("\n       "),
        fix: "correct each finding in tasks.md (or the requirements file), then run `navori spec check` again",
      });
      process.exitCode = 2;
      return;
    }
    process.exitCode = 0;
  },
});

export const specCommand = defineCommand({
  meta: { name: "spec", description: "Classify and validate a spec's tasks.md" },
  subCommands: { classify: classifySubCommand, check: checkSubCommand },
});
