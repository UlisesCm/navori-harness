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
import { MasterStateSchema, type MasterMode, type MasterState } from "../lib/master/schema.ts";
import { writeFileAtomic } from "../lib/primitives/atomic.ts";

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

export const masterCommand = defineCommand({
  meta: { name: "master", description: "Master-plan project flow (spec 0034)" },
  subCommands: {
    init: initSubCommand,
    mode: modeSubCommand,
  },
});
