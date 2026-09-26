/**
 * `navori master` — the master-plan project flow (spec 0034). Lote A wires
 * only `init` and `mode`; later lotes add `status`, `check`, `advance`,
 * `part`, `template` and `close` to this same command (design.md D1).
 */
import { defineCommand } from "citty";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readConfig } from "../lib/config/config.ts";
import { MasterInitError, runMasterInit } from "../lib/master/init.ts";
import { activeStage, masterDirPath, readMasterIndex } from "../lib/master/stages.ts";
import {
  MasterStateSchema,
  PartsSchema,
  type MasterMode,
  type MasterState,
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

const MASTER_MODES: readonly MasterMode[] = ["template", "en-curso"];

function reportError(cause: unknown): void {
  process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exitCode = 1;
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
  },
  run({ args }) {
    const cwd = resolve(args.cwd ?? process.cwd());
    try {
      const result = runMasterInit(cwd, args.slug || undefined);
      for (const warning of result.warnings) process.stderr.write(`[navori] ${warning}\n`);
      const signal = result.signal;
      process.stdout.write(
        `Etapa ${result.stage.dir} · fase ${result.phase}${result.mode ? ` · modo ${result.mode}` : ""}\n` +
          `Señal: commits=${signal.commits ?? "?"} primerCommit=${signal.firstCommit ?? "?"} ` +
          `archivosCambiados=${signal.filesChangedSinceFirst ?? "?"} framework=${signal.framework ?? "ninguno"} ` +
          `sugerido=${signal.suggested}\n`,
      );
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
  if (!MASTER_MODES.includes(value as MasterMode)) {
    throw new Error(`invalid mode "${value}": expected "template" or "en-curso"`);
  }
  const configPath = resolve(cwd, "navori.config.json");
  const config = readConfig(configPath);
  const specsDir = config.sdd?.specsDir ?? "specs";
  const index = readMasterIndex(cwd, specsDir);
  const active = activeStage(index);
  if (!active) {
    throw new Error("no active stage: run 'navori master init <slug>' first");
  }
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

const modeSubCommand = defineCommand({
  meta: { name: "mode", description: "Register the first stage's mode: template | en-curso (R16)" },
  args: {
    value: { type: "positional", required: true, description: "template | en-curso" },
    cwd: { type: "string", description: "Repo root" },
  },
  run({ args }) {
    const cwd = resolve(args.cwd ?? process.cwd());
    try {
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
      if (args.part) {
        if (name !== "issue") {
          throw new Error("--part solo aplica a 'navori master template issue'");
        }
        const index = readMasterIndex(cwd, specsDir);
        const stage = activeStage(index);
        if (!stage) throw new Error("no hay etapa activa");
        const partsPath = join(masterDirPath(cwd, specsDir), stage.dir, "parts.json");
        if (!existsSync(partsPath)) throw new Error(`falta ${stage.dir}/parts.json`);
        const raw: unknown = JSON.parse(readFileSync(partsPath, "utf8"));
        const parsed = PartsSchema.parse(raw);
        const part = parsed.parts.find((p) => p.id === args.part);
        if (!part) throw new Error(`no existe la parte ${String(args.part)}`);
        process.stdout.write(`${printIssueTemplate(part, stage.dir, specsDir, config.language)}\n`);
        return;
      }
      const state = activeStageState(cwd, specsDir);
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
  const path = join(masterDirPath(cwd, specsDir), stage.dir, "state.json");
  if (!existsSync(path)) return null;
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  return MasterStateSchema.parse(raw);
}

const advanceSubCommand = defineCommand({
  meta: { name: "advance", description: "Advance the active stage one phase (R8)" },
  args: { cwd: { type: "string", description: "Repo root" } },
  run({ args }) {
    const cwd = resolve(args.cwd ?? process.cwd());
    try {
      const result = runMasterAdvance(cwd);
      if (!result.advanced) {
        for (const failure of result.failures) process.stderr.write(`[navori] ${failure}\n`);
        process.exitCode = 1;
        return;
      }
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

export const masterCommand = defineCommand({
  meta: { name: "master", description: "Master-plan project flow (spec 0034)" },
  subCommands: {
    init: initSubCommand,
    mode: modeSubCommand,
    template: templateSubCommand,
    check: checkSubCommand,
    advance: advanceSubCommand,
  },
});
