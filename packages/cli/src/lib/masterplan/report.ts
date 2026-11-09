/**
 * Text and JSON output of `navori master status` and `check` for a v2 plan
 * (spec 0063). Returns the output instead of printing, so the command stays thin.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkPlan } from "./plan.ts";
import {
  PlanStateError,
  checkIncoming,
  planPath,
  readPlanState,
  type PlanState,
  type SliceStatus,
} from "./state.ts";

export interface CommandOutput {
  stdout: string;
  stderr: string;
  code: number;
}

export interface StatusOptions {
  id?: string;
  qa?: boolean;
  json?: boolean;
  fetch?: boolean;
}

export interface CheckOptions {
  incoming?: string;
  base?: string;
  /** `false` skips the fetch (a CI step that already fetched); otherwise a failed fetch fails closed. */
  fetch?: boolean;
}

export function hasPlan(cwd: string): boolean {
  return existsSync(planPath(cwd));
}

/** The slice's spec (a repo-relative path from the index) has an acceptance script. */
function hasScript(cwd: string, spec: string): boolean {
  const file = join(cwd, spec);
  return (
    spec !== "" &&
    existsSync(file) &&
    /^## (Guion de aceptaci[oó]n|Acceptance script)/im.test(readFileSync(file, "utf8"))
  );
}

function line(slice: SliceStatus): string {
  const extra = [
    slice.noEnv ? "sin entorno" : "",
    slice.notes.length ? `rechazado: ${slice.notes.length} tareas` : "",
  ].filter(Boolean);
  return `${slice.id.padEnd(4)} ${slice.state.padEnd(10)} ${slice.outcome}${extra.length ? ` · ${extra.join(" · ")}` : ""}`;
}

function header(state: PlanState): string {
  const { env, url, branch, target, wip } = state.acceptance;
  const counted = state.counted.length ? `: ${state.counted.join(", ")}` : "";
  return `aceptación en ${env}${url ? ` (${url})` : ""}, rama ${branch} · destino ${target} · WIP ${state.counted.length}/${wip}${counted}`;
}

export const fail = (message: string): CommandOutput => ({
  stdout: "",
  stderr: `[navori] ${message}\n`,
  code: 1,
});

/** Runs `fn`, turning a fail-closed git error into exit 1. */
export function guarded(fn: () => CommandOutput): CommandOutput {
  try {
    return fn();
  } catch (cause) {
    if (cause instanceof PlanStateError) return fail(cause.message);
    throw cause;
  }
}

export function runPlanStatus(cwd: string, options: StatusOptions): CommandOutput {
  return guarded(() => {
    const state = readPlanState(cwd, { fetch: options.fetch });
    const warnings = state.warnings.map((w) => `aviso: ${w}\n`);
    if (options.json)
      return { stdout: `${JSON.stringify(state)}\n`, stderr: warnings.join(""), code: 0 };
    if (options.id) {
      const slice = state.slices.find((s) => s.id === options.id?.toUpperCase());
      if (!slice) return fail(`${options.id} no está en el índice`);
      const notes = slice.notes.map((n) => `- [ ] ${n}\n`).join("");
      const evidence = slice.evidence ? `evidencia: ${slice.evidence}\n` : "";
      return {
        stdout: `${line(slice)}\n${slice.spec ? `spec: ${slice.spec}\n` : ""}${evidence}${notes}`,
        stderr: warnings.join(""),
        code: 0,
      };
    }
    if (options.qa) {
      const { env, url } = state.acceptance;
      const round = state.slices.filter((s) => s.state === "integrado");
      const stdout = [
        `Ronda de QA en ${env}${url ? ` (${url})` : ""}`,
        ...round.map((s) => `${s.id} ${s.outcome}: guion en ${s.spec || "(sin spec)"}`),
      ];
      for (const s of round)
        if (!hasScript(cwd, s.spec)) warnings.push(`aviso: ${s.id} sin guion de aceptación\n`);
      return { stdout: `${stdout.join("\n")}\n`, stderr: warnings.join(""), code: 0 };
    }
    const stdout = [header(state), ...state.slices.map(line)];
    for (const d of state.decisions) if (!d.approved) stdout.push(`${d.id}   propuesta  ${d.text}`);
    return { stdout: `${stdout.join("\n")}\n`, stderr: warnings.join(""), code: 0 };
  });
}

export function runPlanCheck(cwd: string, options: CheckOptions): CommandOutput {
  const errors = checkPlan(readFileSync(planPath(cwd), "utf8"))
    .filter((f) => f.severity === "error")
    .map((f) => f.message);
  if (errors.length) return fail(errors.join("\n[navori] "));
  const fetch = options.fetch === false ? false : "required";
  return guarded(() => {
    if (!options.incoming) {
      const state = readPlanState(cwd, { fetch });
      const warnings = state.warnings.map((w) => `aviso: ${w}\n`);
      if (state.counted.length > state.acceptance.wip) {
        warnings.push(
          `aviso: ${state.counted.length} integrados sin aceptar (WIP ${state.acceptance.wip}): ${state.counted.join(", ")}\n`,
        );
      }
      return { stdout: `plan ok · ${header(state)}\n`, stderr: warnings.join(""), code: 0 };
    }
    const result = checkIncoming(cwd, options.incoming, options.base, { fetch });
    if (result.ok)
      return {
        stdout: `WIP ok · trae: ${result.incoming.join(", ") || "ningún slice"}\n`,
        stderr: "",
        code: 0,
      };
    return fail(
      `${result.newSlices.join(", ")} no se integra: ${result.counted.join(", ")} sin aceptar (WIP ${result.limit})`,
    );
  });
}
