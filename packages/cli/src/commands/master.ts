/**
 * `navori master` — the master-plan project flow (spec 0034). Lote A wires
 * only `init` and `mode`; later lotes add `status`, `check`, `advance`,
 * `part`, `template` and `close` to this same command (design.md D1).
 */
import { defineCommand } from "citty";
import { prepareDeliverySlice } from "../lib/master/slice.ts";
import {
  approveDeliveryBaseline,
  authorizeDeliveryQueue,
  checkActiveDelivery,
  revokeDeliveryQueue,
  presentDelivery,
  decideDelivery,
  publishDelivery,
} from "../lib/master/delivery.ts";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { appendCliEvent } from "../lib/audit/cli-event.ts";
import {
  changeMasterPart,
  recordDeliveryCriterion,
  captureDeliveryReview,
} from "../lib/master/part.ts";
import { runMasterClose } from "../lib/master/close.ts";
import { readMasterStatus, statusLine, writeMasterStatus } from "../lib/master/status.ts";
import { readConfig } from "../lib/config/config.ts";
import { MasterInitError, runMasterInit } from "../lib/master/init.ts";
import {
  activeStage,
  MASTER_DIR_NAME,
  masterDirPath,
  readMasterIndex,
} from "../lib/master/stages.ts";
import {
  MASTER_MODES,
  MASTER_UX_CHOICES,
  MasterStateSchema,
  PartsSchema,
  type MasterMode,
  type MasterState,
  type MasterUxChoice,
} from "../lib/master/schema.ts";
import { writeFileAtomic } from "../lib/primitives/atomic.ts";
import { checkPart } from "../lib/master/check-part.ts";
import { checkFit } from "../lib/master/fit.ts";
import {
  checkClosedStage,
  MasterCheckSetupError,
  runMasterAdvance,
  runMasterCheck,
} from "../lib/master/checks.ts";
import {
  printIssueTemplate,
  printTemplate,
  TEMPLATE_NAMES,
  type TemplateName,
} from "../lib/master/templates.ts";

function reportError(cause: unknown): void {
  process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exitCode = 1;
}

function stringArg(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function rejectMutationStage(stage: string | undefined): void {
  if (stage)
    throw new Error(
      `--stage ${stage} es de solo lectura; use 'navori master check --stage ${stage}'`,
    );
}

const initSubCommand = defineCommand({
  meta: { name: "init", description: "Open, or complete, the active master-plan stage (R3, R5)" },
  args: {
    slug: {
      type: "positional",
      required: false,
      description: "kebab-case slug for a new stage (required only when none is active)",
    },
    cwd: { type: "string", description: "Repo root" },
    workflow: {
      type: "string",
      description: "legacy | deliveries (optional; omitted resumes active workflow)",
    },
  },
  run({ args }) {
    const cwd = resolve(args.cwd ?? process.cwd());
    try {
      if (args.workflow && args.workflow !== "legacy" && args.workflow !== "deliveries")
        throw new MasterInitError(
          `invalid workflow "${args.workflow}": expected legacy or deliveries`,
        );
      const result = runMasterInit(
        cwd,
        args.slug || undefined,
        args.workflow as "legacy" | "deliveries" | undefined,
      );
      for (const warning of result.warnings) process.stderr.write(`[navori] ${warning}\n`);
      const signal = result.signal;
      process.stdout.write(
        `Etapa ${result.stage.dir} · fase ${result.phase}${result.mode ? ` · modo ${result.mode}` : ""}\n` +
          `Señal: commits=${signal.commits ?? "?"} primerCommit=${signal.firstCommit ?? "?"} ` +
          `archivosCambiados=${signal.filesChangedSinceFirst ?? "?"} framework=${signal.framework ?? "ninguno"} ` +
          `sugerido=${signal.suggested}\n`,
      );
      if (result.workflow === "deliveries")
        process.stdout.write(
          "Deliveries: preparación, baseline y cola disponibles; ejecución, aceptación y publicación aún no disponibles.\n",
        );
      if (result.phase === "context") {
        const specsDir = readConfig(join(cwd, "navori.config.json")).sdd?.specsDir ?? "specs";
        process.stdout.write(
          `Contexto: deja tus archivos (documentos PDF/Word/Excel, imágenes o texto) en ` +
            `${specsDir}/${MASTER_DIR_NAME}/${result.stage.dir}/context/raw/\n`,
        );
      }
      if (result.requestedSlugIgnored) process.exitCode = 1;
    } catch (cause) {
      if (cause instanceof MasterInitError) {
        reportError(cause);
        return;
      }
      throw cause;
    }
  },
});

/**
 * Sets `state.json`'s `mode` for the FIRST stage only (R16): the phase must
 * still be `context`, and stage ≥2 always carries `en-curso` from `init` —
 * changing it mid-flow would invalidate the plans already read against it.
 */
function setMasterMode(cwd: string, value: string): void {
  if (!(MASTER_MODES as readonly string[]).includes(value)) {
    throw new Error(
      `invalid mode "${value}": expected ${MASTER_MODES.map((m) => `"${m}"`).join(", ")}`,
    );
  }
  const configPath = resolve(cwd, "navori.config.json");
  const config = readConfig(configPath);
  const specsDir = config.sdd?.specsDir ?? "specs";
  const index = readMasterIndex(cwd, specsDir);
  const active = activeStage(index);
  if (!active) {
    throw new Error("no active stage: run 'navori master init <slug>' first");
  }
  if (active.workflow === "deliveries")
    throw new Error(`${active.dir}: mode is not available for deliveries yet`);
  if (active.number >= 2) {
    throw new Error("mode is automatic ('en-curso') from stage 2 onward; it cannot be changed");
  }
  const statePath = join(masterDirPath(cwd, specsDir), active.dir, "state.json");
  if (!existsSync(statePath)) {
    throw new Error(`state.json not found for stage ${active.dir}`);
  }
  const raw: unknown = JSON.parse(readFileSync(statePath, "utf8"));
  const state = MasterStateSchema.parse(raw);
  if (state.phase !== "context") {
    throw new Error(`mode can only be set in phase 'context' (current phase: '${state.phase}')`);
  }
  const updated: MasterState = { ...state, mode: value as MasterMode };
  writeFileAtomic(statePath, `${JSON.stringify(updated, null, 2)}\n`);
}

/**
 * Records the UX decision of the active stage. Only valid in phase `ux` (no
 * late opt-in once `executing`); regenerates STATUS.md in the same operation so
 * `navori master check` does not report a stale render.
 */
function setMasterUx(cwd: string, value: string): void {
  if (!(MASTER_UX_CHOICES as readonly string[]).includes(value)) {
    throw new Error(
      `invalid ux choice "${value}": expected ${MASTER_UX_CHOICES.map((m) => `"${m}"`).join(", ")}`,
    );
  }
  const config = readConfig(resolve(cwd, "navori.config.json"));
  const specsDir = config.sdd?.specsDir ?? "specs";
  const active = activeStage(readMasterIndex(cwd, specsDir));
  if (!active) {
    throw new Error("no active stage: run 'navori master init <slug>' first");
  }
  if (active.workflow === "deliveries")
    throw new Error(`${active.dir}: ux is not available for deliveries yet`);
  const statePath = join(masterDirPath(cwd, specsDir), active.dir, "state.json");
  if (!existsSync(statePath)) {
    throw new Error(`state.json not found for stage ${active.dir}`);
  }
  const state = MasterStateSchema.parse(JSON.parse(readFileSync(statePath, "utf8")) as unknown);
  if (state.phase !== "ux") {
    throw new Error(`ux can only be set in phase 'ux' (current phase: '${state.phase}')`);
  }
  const updated: MasterState = { ...state, ux: value as MasterUxChoice };
  writeFileAtomic(statePath, `${JSON.stringify(updated, null, 2)}\n`);
  writeMasterStatus(cwd);
}

const uxSubCommand = defineCommand({
  meta: {
    name: "ux",
    description: "Record the UX contract decision in phase ux: none | md | md-json",
  },
  args: {
    value: { type: "positional", required: true, description: "none | md | md-json" },
    stage: { type: "string", description: "Closed stages are read-only" },
    cwd: { type: "string", description: "Repo root" },
  },
  run({ args }) {
    const cwd = resolve(args.cwd ?? process.cwd());
    try {
      rejectMutationStage(args.stage);
      setMasterUx(cwd, args.value as string);
    } catch (cause) {
      reportError(cause);
    }
  },
});

const modeSubCommand = defineCommand({
  meta: {
    name: "mode",
    description: "Register the first stage's mode: template | en-curso | desde-cero (R16)",
  },
  args: {
    value: { type: "positional", required: true, description: "template | en-curso | desde-cero" },
    stage: { type: "string", description: "Closed stages are read-only" },
    cwd: { type: "string", description: "Repo root" },
  },
  run({ args }) {
    const cwd = resolve(args.cwd ?? process.cwd());
    try {
      rejectMutationStage(args.stage);
      setMasterMode(cwd, args.value as string);
    } catch (cause) {
      reportError(cause);
    }
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

const advanceSubCommand = defineCommand({
  meta: { name: "advance", description: "Advance the active stage one phase (R8)" },
  args: {
    stage: { type: "string", description: "Closed stages are read-only" },
    cwd: { type: "string", description: "Repo root" },
  },
  run({ args }) {
    const cwd = resolve(args.cwd ?? process.cwd());
    try {
      if (args.stage) {
        reportError(
          new Error(
            `--stage ${args.stage} es de solo lectura; use 'navori master check --stage ${args.stage}'`,
          ),
        );
        return;
      }
      const result = runMasterAdvance(cwd);
      if (!result.advanced) {
        for (const failure of result.failures) process.stderr.write(`[navori] ${failure}\n`);
        appendCliEvent(cwd, { name: "master-advance", verdict: "block" });
        process.exitCode = 1;
        return;
      }
      appendCliEvent(cwd, { name: "master-advance", verdict: "allow" });
      process.stdout.write(`${result.from} -> ${result.to}\n`);
    } catch (cause) {
      if (cause instanceof MasterCheckSetupError) {
        reportError(cause);
        return;
      }
      throw cause;
    }
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
    cwd: { type: "string", description: "Repo root" },
  },
  run({ args }) {
    const cwd = resolve(args.cwd ?? process.cwd());
    try {
      if (
        [Boolean(args.stage), Boolean(args.part), Boolean(args.fit)].filter(Boolean).length > 1 ||
        (args.json && !args.fit)
      ) {
        throw new Error("--stage, --part and --fit are mutually exclusive; --json requires --fit");
      }
      if (args.part) {
        const findings = checkPart(cwd, args.part as string);
        for (const finding of findings) process.stderr.write(`[navori] ${finding}\n`);
        if (findings.some((finding) => !finding.startsWith("warning:"))) process.exitCode = 1;
        else process.stdout.write(`${args.part as string}: ok\n`);
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

const statusSubCommand = defineCommand({
  meta: { name: "status", description: "Show or regenerate derived master-plan status" },
  args: {
    json: { type: "boolean", description: "Read-only JSON status" },
    line: { type: "boolean", description: "Read-only SessionStart line" },
    cwd: { type: "string", description: "Repo root" },
  },
  run({ args }) {
    const cwd = resolve(args.cwd ?? process.cwd());
    try {
      if (args.json && args.line) throw new Error("--json and --line are mutually exclusive");
      const status = args.json || args.line ? readMasterStatus(cwd) : writeMasterStatus(cwd);
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

const partSubCommand = defineCommand({
  meta: { name: "part", description: "Update a master-plan part or record acceptance evidence" },
  args: {
    id: { type: "positional", required: true, description: "P<n>" },
    state: { type: "string", description: "Part state" },
    reason: { type: "string", description: "Reason for discarded/deferred state" },
    spec: { type: "string", description: "Existing linked spec directory" },
    issue: { type: "string", description: "GitHub issue number" },
    accept: { type: "string", description: "A<m> acceptance criterion" },
    command: { type: "string", description: "Command run for test/comando evidence" },
    result: { type: "string", description: "Observed result" },
    "approved-by": { type: "string", description: "user for manual acceptance" },
    stage: { type: "string", description: "Closed stages are read-only" },
    cwd: { type: "string", description: "Repo root" },
  },
  run({ args }) {
    try {
      rejectMutationStage(args.stage);
      const cwd = resolve(args.cwd ?? process.cwd());
      changeMasterPart(cwd, args.id as string, {
        state: args.state,
        reason: args.reason,
        spec: args.spec,
        issue: args.issue,
        accept: args.accept,
        command: args.command,
        result: args.result,
        approvedBy: args["approved-by"],
      });
      if (args.accept) appendCliEvent(cwd, { name: "master-part-accept", verdict: "allow" });
      process.stdout.write(`${args.id as string}: updated\n`);
    } catch (cause) {
      reportError(cause);
    }
  },
});

const closeSubCommand = defineCommand({
  meta: {
    name: "close",
    description: "Close, convert or abandon the active stage (R47, R57, R58)",
  },
  args: {
    convert: { type: "string", description: "Convert to an empty spec path under specsDir" },
    abandon: { type: "boolean", description: "Abandon before mastered" },
    reason: { type: "string", description: "Required reason for conversion or abandonment" },
    stage: { type: "string", description: "Closed stages are read-only" },
    cwd: { type: "string", description: "Repo root" },
  },
  run({ args }) {
    try {
      rejectMutationStage(args.stage);
      const cwd = resolve(args.cwd ?? process.cwd());
      const result = runMasterClose(cwd, {
        convert: args.convert,
        abandon: args.abandon,
        reason: args.reason,
      });
      appendCliEvent(cwd, { name: "master-close", verdict: "allow" });
      process.stdout.write(
        result.reconciled
          ? "no hay etapa activa; se apagó harness.masterPlan\n"
          : result.stage
            ? `${result.stage}: ${result.outcome}\n`
            : "no hay etapa activa; cierre ya completo\n",
      );
    } catch (cause) {
      reportError(cause);
    }
  },
});

export const masterCommand = defineCommand({
  meta: { name: "master", description: "Master-plan project flow (spec 0034)" },
  subCommands: {
    "delivery-slice": defineCommand({
      meta: { name: "delivery-slice", description: "Project an authorized slice into a workplan" },
      args: {
        cwd: { type: "string", description: "Repo root" },
        part: { type: "string", description: "P<n>", required: true },
        refresh: {
          type: "boolean",
          description: "Explicitly refresh current-queue reverification and reset pending criteria",
        },
        "approved-by": { type: "string", description: "user for projection refresh" },
      },
      run({ args }) {
        try {
          const cwd = resolve(typeof args.cwd === "string" ? args.cwd : process.cwd());
          process.stdout.write(
            `${JSON.stringify(prepareDeliverySlice(cwd, typeof args.part === "string" ? args.part : "", Boolean(args.refresh), typeof args["approved-by"] === "string" ? args["approved-by"] : undefined))}\n`,
          );
        } catch (cause: unknown) {
          reportError(cause);
        }
      },
    }),
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
    "delivery-baseline": defineCommand({
      meta: {
        name: "delivery-baseline",
        description: "Record explicit operator baseline approval",
      },
      args: {
        cwd: { type: "string", description: "Repo root" },
        "approved-by": { type: "string", description: "Must be user" },
      },
      run({ args }) {
        try {
          process.stdout.write(
            `${JSON.stringify(approveDeliveryBaseline(resolve(typeof args.cwd === "string" ? args.cwd : process.cwd()), typeof args["approved-by"] === "string" ? args["approved-by"] : ""))}\n`,
          );
        } catch (cause) {
          reportError(cause);
        }
      },
    }),
    "delivery-queue": defineCommand({
      meta: { name: "delivery-queue", description: "Authorize a bounded delivery queue" },
      args: {
        cwd: { type: "string", description: "Repo root" },
        delivery: { type: "string", description: "E<n>" },
        parts: { type: "string", description: "Comma-separated P<n>" },
        "approved-by": { type: "string", description: "Must be user" },
        transition: {
          type: "string",
          description: "replacement (conservative default) | continuation",
        },
      },
      run({ args }) {
        try {
          if (
            args.transition &&
            args.transition !== "replacement" &&
            args.transition !== "continuation"
          )
            throw new Error("invalid authority transition");
          process.stdout.write(
            `${JSON.stringify(authorizeDeliveryQueue(resolve(typeof args.cwd === "string" ? args.cwd : process.cwd()), typeof args.delivery === "string" ? args.delivery : "", typeof args.parts === "string" ? args.parts.split(",").filter(Boolean) : [], typeof args["approved-by"] === "string" ? args["approved-by"] : "", args.transition === "continuation" ? "continuation" : "replacement"))}\n`,
          );
        } catch (cause) {
          reportError(cause);
        }
      },
    }),
    "delivery-revoke": defineCommand({
      meta: {
        name: "delivery-revoke",
        description: "Explicitly revoke queue authority and prior generation proof",
      },
      args: {
        cwd: { type: "string", description: "Repo root" },
        "approved-by": { type: "string", description: "Must be user" },
      },
      run({ args }) {
        try {
          process.stdout.write(
            `${JSON.stringify(revokeDeliveryQueue(resolve(stringArg(args.cwd) || process.cwd()), stringArg(args["approved-by"])))}\n`,
          );
        } catch (cause: unknown) {
          reportError(cause);
        }
      },
    }),
    "delivery-criterion": defineCommand({
      meta: {
        name: "delivery-criterion",
        description: "Consume current host provenance or explicit manual attestation",
      },
      args: {
        cwd: { type: "string", description: "Repo root" },
        part: { type: "string", required: true, description: "P<n>" },
        criterion: { type: "string", required: true, description: "A<n>" },
        "approved-by": { type: "string", description: "user only for manual criterion" },
      },
      run({ args }) {
        try {
          process.stdout.write(
            `${JSON.stringify(recordDeliveryCriterion(resolve(stringArg(args.cwd) || process.cwd()), stringArg(args.part), stringArg(args.criterion), typeof args["approved-by"] === "string" ? args["approved-by"] : undefined))}\n`,
          );
        } catch (cause: unknown) {
          reportError(cause);
        }
      },
    }),
    "delivery-review": defineCommand({
      meta: {
        name: "delivery-review",
        description:
          "Operator-attested technical review; CLI verifies content/receipt, not identity or QA execution",
      },
      args: {
        cwd: { type: "string", description: "Repo root" },
        part: { type: "string", required: true, description: "P<n>" },
        report: {
          type: "string",
          required: true,
          description: "Report artifact filename in this feature handoff directory",
        },
        envelope: {
          type: "string",
          required: true,
          description: "Strict technical review envelope filename",
        },
        "approved-by": {
          type: "string",
          description:
            "user attests separate reviewer and observed full QA for this exact snapshot",
        },
      },
      run({ args }) {
        try {
          process.stdout.write(
            `${JSON.stringify(captureDeliveryReview(resolve(stringArg(args.cwd) || process.cwd()), stringArg(args.part), stringArg(args.report), stringArg(args.envelope), stringArg(args["approved-by"])))}\n`,
          );
        } catch (cause: unknown) {
          reportError(cause);
        }
      },
    }),
    "delivery-present": defineCommand({
      meta: {
        name: "delivery-present",
        description: "Record a current technically reviewed demo identity, not client consent",
      },
      args: {
        cwd: { type: "string", description: "Repo root" },
        delivery: { type: "string", required: true, description: "E<n>" },
      },
      run({ args }) {
        try {
          process.stdout.write(
            `${JSON.stringify(presentDelivery(resolve(stringArg(args.cwd) || process.cwd()), stringArg(args.delivery)))}\n`,
          );
        } catch (cause: unknown) {
          reportError(cause);
        }
      },
    }),
    "delivery-decision": defineCommand({
      meta: {
        name: "delivery-decision",
        description: "Explicit operator-attested client decision on an exact reviewed identity",
      },
      args: {
        cwd: { type: "string", description: "Repo root" },
        delivery: { type: "string", required: true, description: "E<n>" },
        identity: {
          type: "string",
          required: true,
          description: "Exact presented identity, or current scope for deferral/discard",
        },
        decision: {
          type: "string",
          required: true,
          description: "accepted | declined | deferred | discarded",
        },
        reason: { type: "string", description: "Required non-acceptance reason" },
        reference: { type: "string", description: "Optional external consent reference" },
        "approved-by": { type: "string", description: "Must be user" },
      },
      run({ args }) {
        try {
          const decision = args.decision;
          if (
            decision !== "accepted" &&
            decision !== "declined" &&
            decision !== "deferred" &&
            decision !== "discarded"
          )
            throw new Error("invalid delivery decision");
          process.stdout.write(
            `${JSON.stringify(decideDelivery(resolve(stringArg(args.cwd) || process.cwd()), stringArg(args.delivery), stringArg(args.identity), decision, stringArg(args["approved-by"]), typeof args.reason === "string" ? args.reason : undefined, typeof args.reference === "string" ? args.reference : undefined))}\n`,
          );
        } catch (cause: unknown) {
          reportError(cause);
        }
      },
    }),
    "delivery-publication": defineCommand({
      meta: {
        name: "delivery-publication",
        description: "Attest release/deploy reference without executing deployment",
      },
      args: {
        cwd: { type: "string", description: "Repo root" },
        delivery: { type: "string", required: true, description: "E<n>" },
        identity: { type: "string", required: true, description: "Exact accepted identity" },
        kind: { type: "string", required: true, description: "release | deploy (not merge)" },
        reference: {
          type: "string",
          required: true,
          description: "Explicit release or deploy reference",
        },
        "approved-by": { type: "string", description: "Must be user" },
      },
      run({ args }) {
        try {
          if (args.kind !== "release" && args.kind !== "deploy")
            throw new Error("publication kind must be release or deploy");
          process.stdout.write(
            `${JSON.stringify(publishDelivery(resolve(stringArg(args.cwd) || process.cwd()), stringArg(args.delivery), stringArg(args.identity), args.kind, stringArg(args.reference), stringArg(args["approved-by"])))}\n`,
          );
        } catch (cause: unknown) {
          reportError(cause);
        }
      },
    }),
    init: initSubCommand,
    mode: modeSubCommand,
    ux: uxSubCommand,
    template: templateSubCommand,
    check: checkSubCommand,
    advance: advanceSubCommand,
    status: statusSubCommand,
    part: partSubCommand,
    close: closeSubCommand,
  },
});
