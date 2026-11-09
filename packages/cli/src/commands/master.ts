/**
 * `navori master` — the master-plan project flow. The v2 plan (specs/_plan/PLAN.md)
 * owns the writes; the v1 stage flow is read-only for one release (spec 0063 T6):
 * its writing subcommands stay registered but only point to `navori master migrate`.
 */
import { defineCommand } from "citty";
import { checkActiveDelivery } from "../lib/master/delivery.ts";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveLang } from "../lib/i18n.ts";
import { runPlanInit } from "../lib/masterplan/init.ts";
import { runPlanMigrate } from "../lib/masterplan/migrate.ts";
import { recordVerdicts } from "../lib/masterplan/accept.ts";
import {
  type CommandOutput,
  hasPlan,
  runPlanCheck,
  runPlanStatus,
} from "../lib/masterplan/report.ts";
import { readMasterStatus, statusLine } from "../lib/master/status.ts";
import { readConfig } from "../lib/config/config.ts";
import { activeStage, masterDirPath, readMasterIndex } from "../lib/master/stages.ts";
import { MasterStateSchema, PartsSchema, type MasterState } from "../lib/master/schema.ts";
import { checkPart } from "../lib/master/check-part.ts";
import { checkFit } from "../lib/master/fit.ts";
import { checkClosedStage, MasterCheckSetupError, runMasterCheck } from "../lib/master/checks.ts";
import {
  printIssueTemplate,
  printTemplate,
  TEMPLATE_NAMES,
  type TemplateName,
} from "../lib/master/templates.ts";

/** Prints a v2 plan command's output (spec 0063) and sets the exit code. */
function emit(out: CommandOutput): void {
  process.stdout.write(out.stdout);
  process.stderr.write(out.stderr);
  if (out.code !== 0) process.exitCode = out.code;
}

function reportError(cause: unknown): void {
  process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exitCode = 1;
}

/** Why a v1 writing subcommand refuses to run (spec 0063 T6). */
function v1ReadOnlyMessage(name: string): string {
  return `[navori] 'navori master ${name}' ya no escribe: la v1 del plan maestro es de solo lectura. Corre 'navori master migrate' para pasar la etapa al plan v2 (specs/_plan/PLAN.md).\n`;
}

/** A v1 writing subcommand: stays registered, writes nothing, exits 1 pointing to migrate. */
function refused(name: string, description: string) {
  return defineCommand({
    meta: { name, description: `${description} (v1, read-only: run navori master migrate)` },
    run() {
      emit({ stdout: "", stderr: v1ReadOnlyMessage(name), code: 1 });
    },
  });
}

/** A v1 stage is open: `init` refuses to resume it and points to `migrate`. */
function hasActiveV1Stage(cwd: string): boolean {
  try {
    const specsDir = readConfig(join(cwd, "navori.config.json")).sdd?.specsDir ?? "specs";
    return activeStage(readMasterIndex(cwd, specsDir)) !== null;
  } catch {
    return false;
  }
}

const initSubCommand = defineCommand({
  meta: {
    name: "init",
    description: "Create the master plan (PLAN.md); v1 stages (--workflow) are read-only",
  },
  args: {
    slug: { type: "positional", required: false, description: "Ignored by the v2 plan" },
    cwd: { type: "string", description: "Repo root" },
    workflow: { type: "string", description: "v1 only: refused, run navori master migrate" },
  },
  run({ args }) {
    const cwd = resolve(args.cwd ?? process.cwd());
    if (args.workflow || hasActiveV1Stage(cwd)) {
      emit({ stdout: "", stderr: v1ReadOnlyMessage("init"), code: 1 });
      return;
    }
    emit(runPlanInit(cwd, args.slug || undefined));
  },
});

const templateSubCommand = defineCommand({
  meta: { name: "template", description: "Print a master-plan template, or a filled issue (R42)" },
  args: {
    name: { type: "positional", required: true, description: TEMPLATE_NAMES.join(" | ") },
    part: { type: "string", description: "P<n>: print 'issue' filled from parts.json" },
    cwd: { type: "string", description: "Repo root" },
  },
  run({ args }) {
    const cwd = resolve(args.cwd ?? process.cwd());
    const name = args.name as string;
    if (!TEMPLATE_NAMES.includes(name as TemplateName)) {
      reportError(new Error(`plantilla desconocida "${name}": ${TEMPLATE_NAMES.join(", ")}`));
      return;
    }
    try {
      const config = readConfig(join(cwd, "navori.config.json"));
      const specsDir = config.sdd?.specsDir ?? "specs";
      const index = readMasterIndex(cwd, specsDir);
      const active = activeStage(index);
      const deliveryTemplate = name === "delivery-master" || name === "slice";
      if (deliveryTemplate && active?.workflow !== "deliveries")
        throw new Error(`${name} requires an active deliveries stage`);
      if (!deliveryTemplate && active?.workflow === "deliveries")
        throw new Error(`${active.dir}: legacy templates are not available for deliveries`);
      if (args.part) {
        if (name !== "issue") {
          throw new Error("--part solo aplica a 'navori master template issue'");
        }
        const index = readMasterIndex(cwd, specsDir);
        const stage = activeStage(index);
        if (!stage) throw new Error("no hay etapa activa");
        if (stage.workflow === "deliveries")
          throw new Error(`${stage.dir}: legacy part templates are not available for deliveries`);
        const partsPath = join(masterDirPath(cwd, specsDir), stage.dir, "parts.json");
        if (!existsSync(partsPath)) throw new Error(`falta ${stage.dir}/parts.json`);
        const raw: unknown = JSON.parse(readFileSync(partsPath, "utf8"));
        const parsed = PartsSchema.parse(raw);
        const part = parsed.parts.find((p) => p.id === args.part);
        if (!part) throw new Error(`no existe la parte ${String(args.part)}`);
        process.stdout.write(`${printIssueTemplate(part, stage.dir, specsDir, config.language)}\n`);
        return;
      }
      const state = deliveryTemplate ? null : activeStageState(cwd, specsDir);
      process.stdout.write(
        printTemplate(name as TemplateName, config.language, state?.mode ?? null),
      );
    } catch (cause) {
      reportError(cause);
    }
  },
});

function activeStageState(cwd: string, specsDir: string): MasterState | null {
  const index = readMasterIndex(cwd, specsDir);
  const stage = activeStage(index);
  if (!stage) return null;
  if (stage.workflow === "deliveries")
    throw new Error(`${stage.dir}: legacy templates are not available for deliveries`);
  const path = join(masterDirPath(cwd, specsDir), stage.dir, "state.json");
  if (!existsSync(path)) return null;
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  return MasterStateSchema.parse(raw);
}

const migrateSubCommand = defineCommand({
  meta: {
    name: "migrate",
    description: "Turn a v1 stage into the v2 PLAN.md (one release); prints it without --write",
  },
  args: {
    stage: { type: "string", description: "Stage number (default: the active one)" },
    write: { type: "boolean", description: "Write PLAN.md, enable harness.masterPlan, re-render" },
    cwd: { type: "string", description: "Repo root" },
  },
  run({ args }) {
    const stage = args.stage === undefined ? undefined : Number(args.stage);
    if (stage !== undefined && !(Number.isInteger(stage) && stage > 0)) {
      reportError(new Error(`--stage debe ser un número de etapa (recibí "${args.stage}")`));
      return;
    }
    emit(
      runPlanMigrate(resolve(args.cwd ?? process.cwd()), {
        ...(stage ? { stage } : {}),
        write: args.write,
      }),
    );
  },
});

const checkSubCommand = defineCommand({
  meta: {
    name: "check",
    description: "Validate the active stage, or a closed one with --stage (R50)",
  },
  args: {
    stage: { type: "string", description: "NN-slug of a closed stage to validate" },
    part: { type: "string", description: "P<n> of a linked part spec to validate" },
    fit: { type: "boolean", description: "Count D9 fit criteria without making a decision" },
    json: { type: "boolean", description: "Print machine-readable result for --fit" },
    incoming: { type: "string", description: "v2: WIP gate for the slices this ref brings" },
    base: { type: "string", description: "v2: PR target branch; required with --incoming" },
    branch: { type: "string", description: "v2: PR branch; slice/S<n>-… counts as a mark" },
    title: { type: "string", description: "v2: PR title; its [S<n>] marks count" },
    fetch: { type: "boolean", default: true, description: "v2: fetch the plan branches first" },
    cwd: { type: "string", description: "Repo root" },
  },
  run({ args }) {
    const cwd = resolve(args.cwd ?? process.cwd());
    if (hasPlan(cwd) || args.incoming) {
      emit(
        runPlanCheck(cwd, {
          incoming: args.incoming,
          base: args.base,
          branch: args.branch,
          title: args.title,
          fetch: args.fetch,
        }),
      );
      return;
    }
    try {
      if (
        [Boolean(args.stage), args.part !== undefined, Boolean(args.fit)].filter(Boolean).length >
          1 ||
        (args.json && !args.fit)
      ) {
        reportError(
          new Error("--stage, --part and --fit are mutually exclusive; --json requires --fit"),
        );
        return;
      }
      if (args.part !== undefined) {
        const partId = String(args.part).trim();
        if (!partId) {
          reportError(new Error("--part requires a P<n> value"));
          return;
        }
        const findings = checkPart(cwd, partId);
        for (const finding of findings) process.stderr.write(`[navori] ${finding}\n`);
        if (findings.some((finding) => !finding.startsWith("warning:"))) process.exitCode = 1;
        else process.stdout.write(`${partId}: ok\n`);
        return;
      }
      if (args.fit) {
        const result = checkFit(cwd);
        if (args.json) process.stdout.write(`${JSON.stringify(result)}\n`);
        else {
          for (const criterion of result.verifiable)
            process.stdout.write(
              `${criterion.id}: ${String(criterion.value)} / ${String(criterion.threshold)} ${criterion.pass ? "pass" : "fail"}\n`,
            );
          process.stdout.write("J1, J2, J3: juicio\n");
        }
        if (!result.allVerifiablePass) process.exitCode = 1;
        return;
      }
      if (args.stage) {
        const config = readConfig(join(cwd, "navori.config.json"));
        const specsDir = config.sdd?.specsDir ?? "specs";
        const failures = checkClosedStage(cwd, specsDir, args.stage as string, config.language);
        if (failures.length > 0) {
          for (const failure of failures) process.stderr.write(`[navori] ${failure}\n`);
          process.exitCode = 1;
          return;
        }
        process.stdout.write(`${args.stage as string}: ok\n`);
        return;
      }
      const result = runMasterCheck(cwd);
      if (result.failures.length > 0) {
        for (const failure of result.failures) process.stderr.write(`[navori] ${failure}\n`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(
        `fase ${result.phase}${result.nextPhase ? ` · lista para avanzar a ${result.nextPhase}` : ""}\n`,
      );
    } catch (cause) {
      if (cause instanceof MasterCheckSetupError) {
        reportError(cause);
        return;
      }
      throw cause;
    }
  },
});

/** `accept` / `reject` of a v2 plan: the user's QA verdict on slices or decisions. */
function verdictSubCommand(verdict: "accepted" | "rejected") {
  const name = verdict === "accepted" ? "accept" : "reject";
  return defineCommand({
    meta: {
      name,
      description: `v2: record the user's ${name} verdict in navori/acceptance`,
    },
    args: {
      ids: {
        type: "positional",
        required: false,
        description: "S<n> slices or D<n> decisions",
      },
      evidence: {
        type: "string",
        description: "accept: external evidence URL (http/https)",
      },
      notes: {
        type: "string",
        description: "reject: open task (repeatable, required)",
      },
      "approved-by": { type: "string", description: "must be user" },
      fetch: {
        type: "boolean",
        default: true,
        description: "fetch the plan branches first",
      },
      cwd: { type: "string", description: "Repo root" },
    },
    run({ args, rawArgs }) {
      const cwd = resolve(args.cwd ?? process.cwd());
      if (!hasPlan(cwd)) {
        const stderr = `[navori] ${name} requiere specs/_plan/PLAN.md (plan maestro v2)\n`;
        emit({ stdout: "", stderr, code: 1 });
        return;
      }
      const configFile = join(cwd, "navori.config.json");
      // citty keeps only the last value of a repeated flag: read every --notes from rawArgs.
      const notes = rawArgs.flatMap((a, i) =>
        a === "--notes" ? [rawArgs[i + 1] ?? ""] : a.startsWith("--notes=") ? [a.slice(8)] : [],
      );
      emit(
        recordVerdicts(cwd, {
          verdict,
          ids: args._.map(String),
          evidence: args.evidence,
          notes,
          approvedBy: args["approved-by"],
          fetch: args.fetch,
          lang: resolveLang(existsSync(configFile) ? readConfig(configFile).language : undefined),
        }),
      );
    },
  });
}

const statusSubCommand = defineCommand({
  meta: { name: "status", description: "Show derived master-plan status (read-only)" },
  args: {
    id: { type: "positional", required: false, description: "v2: one slice in detail" },
    qa: { type: "boolean", description: "v2: environment and acceptance scripts for a QA round" },
    fetch: { type: "boolean", default: true, description: "v2: fetch the plan branches first" },
    json: { type: "boolean", description: "Read-only JSON status" },
    line: { type: "boolean", description: "Read-only SessionStart line" },
    cwd: { type: "string", description: "Repo root" },
  },
  run({ args }) {
    const cwd = resolve(args.cwd ?? process.cwd());
    if (hasPlan(cwd)) {
      const configFile = join(cwd, "navori.config.json");
      emit(
        runPlanStatus(cwd, {
          id: args.id,
          qa: args.qa,
          json: args.json,
          fetch: args.fetch && !args.line,
          line: args.line,
          lang: resolveLang(existsSync(configFile) ? readConfig(configFile).language : undefined),
        }),
      );
      return;
    }
    try {
      if (args.json && args.line) throw new Error("--json and --line are mutually exclusive");
      const status = readMasterStatus(cwd);
      if (args.json) process.stdout.write(`${JSON.stringify(status)}\n`);
      else if (args.line) {
        if (!status.stage) {
          process.exitCode = 1;
          return;
        }
        const config = readConfig(join(cwd, "navori.config.json"));
        process.stdout.write(`${statusLine(status, config.sdd?.specsDir ?? "specs")}\n`);
      } else
        process.stdout.write(
          `etapa ${status.stage?.dir ?? "ninguna"}: ${status.phase ?? "sin fase"}\n`,
        );
    } catch (cause) {
      reportError(cause);
    }
  },
});

export const masterCommand = defineCommand({
  meta: { name: "master", description: "Master-plan project flow (v2 plan; v1 read-only)" },
  subCommands: {
    "delivery-check": defineCommand({
      meta: { name: "delivery-check", description: "Check delivery preparation without writes" },
      args: { cwd: { type: "string", description: "Repo root" } },
      run({ args }) {
        try {
          const result = checkActiveDelivery(
            resolve(typeof args.cwd === "string" ? args.cwd : process.cwd()),
          );
          process.stdout.write(
            `${JSON.stringify({ ready: result.blockers.length === 0, blockers: result.blockers, expectedDigest: result.expectedDigest })}\n`,
          );
          if (result.blockers.length) process.exitCode = 1;
        } catch (cause) {
          reportError(cause);
        }
      },
    }),
    init: initSubCommand,
    migrate: migrateSubCommand,
    template: templateSubCommand,
    check: checkSubCommand,
    accept: verdictSubCommand("accepted"),
    reject: verdictSubCommand("rejected"),
    status: statusSubCommand,
    mode: refused("mode", "Register the first stage's mode"),
    ux: refused("ux", "Record the UX contract decision"),
    advance: refused("advance", "Advance the active stage one phase"),
    part: refused("part", "Update a master-plan part or record acceptance"),
    close: refused("close", "Close, convert or abandon the active stage"),
    "delivery-slice": refused("delivery-slice", "Project an authorized slice into a workplan"),
    "delivery-baseline": refused("delivery-baseline", "Record operator baseline approval"),
    "delivery-queue": refused("delivery-queue", "Authorize a bounded delivery queue"),
    "delivery-revoke": refused("delivery-revoke", "Revoke queue authority"),
    "delivery-criterion": refused("delivery-criterion", "Record a delivery criterion"),
    "delivery-review": refused("delivery-review", "Capture a technical delivery review"),
    "delivery-present": refused("delivery-present", "Record a reviewed demo identity"),
    "delivery-decision": refused("delivery-decision", "Record a client decision"),
    "delivery-publication": refused("delivery-publication", "Attest a release/deploy reference"),
  },
});
