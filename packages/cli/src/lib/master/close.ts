/** Reentrant six-step master-plan closure (spec 0034, D10). */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { readConfig, writeConfig } from "../config/config.ts";
import { runRender } from "../../commands/render.ts";
import { writeFileAtomic } from "../primitives/atomic.ts";
import { masterMarkers } from "./markers.ts";
import {
  MasterStateSchema,
  PartsSchema,
  type MasterIndex,
  type MasterState,
  type Part,
} from "./schema.ts";
import {
  activeStage,
  indexJsonPath,
  indexMdPath,
  masterDirPath,
  readMasterIndex,
  renderIndexMd,
} from "./stages.ts";
import { closeBlockers, readMasterStatus, writeMasterStatus, type MasterStatus } from "./status.ts";
import { deliveryAuthority, deliveryLifecycle, writeDeliveryState } from "./delivery.ts";

export interface CloseOptions {
  convert?: string;
  abandon?: boolean;
  reason?: string;
  /** Test seam: simulate interruption after a durable step. */
  afterStep?: (step: number) => void;
}

export interface CloseResult {
  stage: string | null;
  outcome: "entregada" | "convertida" | "abandonada" | null;
  reconciled: boolean;
}

function json<T>(path: string, parse: (input: unknown) => T): T {
  return parse(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

function save(path: string, value: unknown): void {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

function finishRender(
  cwd: string,
  configPath: string,
  config: ReturnType<typeof readConfig>,
): void {
  const harness = { ...(config.harness ?? {}), masterPlan: false };
  writeConfig(configPath, { ...config, harness });
  try {
    const render = runRender(cwd);
    if (!render.ok) throw new Error(render.reason ?? "render failed after close");
  } catch (cause) {
    // Preserve the recovery signal when rendering failed after the registry was closed.
    writeConfig(configPath, { ...config, harness: { ...harness, masterPlan: true } });
    throw cause;
  }
}

function hash(content: string): string {
  return createHash("sha256")
    .update(content.replace(/\r\n/g, "\n").replace(/\r/g, "\n"), "utf8")
    .digest("hex");
}

function escapeCell(value: string | number | null | undefined): string {
  return String(value ?? "—")
    .replace(/\|/g, "\\|")
    .replace(/[\r\n]+/g, " ");
}

function decisionCount(path: string): number {
  if (!existsSync(path)) return 0;
  return [...readFileSync(path, "utf8").matchAll(/^## D\d+\b/gm)].length;
}

function specPath(cwd: string, specsDir: string, requested: string): string {
  const root = resolve(cwd, specsDir);
  const target = resolve(cwd, requested);
  if (target === root || !target.startsWith(`${root}${sep}`))
    throw new Error(`--convert debe estar dentro de ${specsDir}`);
  const subpath = relative(root, target);
  if (subpath.split(sep).includes("_master"))
    throw new Error("--convert no puede estar en _master/");
  let existing = target;
  while (!existsSync(existing)) existing = resolve(existing, "..");
  const realRoot = realpathSync(root);
  const realExisting = realpathSync(existing);
  if (realExisting !== realRoot && !realExisting.startsWith(`${realRoot}${sep}`))
    throw new Error("--convert resuelve fuera de specsDir");
  if (existsSync(target) && readdirSync(target).length > 0)
    throw new Error(`--convert requiere una ruta libre o vacía: ${requested}`);
  return relative(cwd, target).split(sep).join("/");
}

function renderClosure(
  cwd: string,
  stagePath: string,
  stageDir: string,
  openedAt: string,
  state: MasterState,
  parts: readonly Part[],
  status: MasterStatus | null,
  language: "es" | "en",
  finalStateBytes: string,
): string {
  const outcome = state.outcome!;
  const lines = [
    `# ${language === "es" ? "Cierre" : "Closure"}: ${stageDir}`,
    "",
    `- ${language === "es" ? "Resultado" : "Outcome"}: ${outcome}`,
    `- ${language === "es" ? "Apertura" : "Opened"}: ${openedAt}`,
    `- ${language === "es" ? "Cierre" : "Closed"}: ${state.closedAt}`,
  ];
  if (outcome === "abandonada") {
    lines.push(
      `- ${language === "es" ? "Razón" : "Reason"}: ${escapeCell(state.abandonment?.reason)}`,
    );
    lines.push(`- ${language === "es" ? "Fase" : "Phase"}: ${state.abandonment?.phase}`);
  } else {
    if (outcome === "convertida") {
      lines.push(
        `- ${language === "es" ? "Razón" : "Reason"}: ${escapeCell(state.conversion?.reason)}`,
      );
      lines.push(`- Spec: ${state.conversion?.spec}`);
    }
    lines.push(
      "",
      "## Partes",
      "",
      "| ID | Estado | Spec | Issue | Razón |",
      "|---|---|---|---|---|",
    );
    for (const part of parts) {
      const effective = status?.parts.find((p) => p.id === part.id)?.effective ?? part.state;
      lines.push(
        `| ${part.id} | ${effective} | ${escapeCell(part.spec)} | ${escapeCell(part.issue)} | ${escapeCell(part.reason)} |`,
      );
    }
    lines.push("", "## Criterios", "", "| ID | Método | Evidencia | Fecha |", "|---|---|---|---|");
    for (const part of parts)
      for (const criterion of part.acceptance) {
        const disposition = part.state === "descartada" || part.state === "diferida";
        const evidence = disposition ? null : criterion.evidence;
        let detail = "no verificado";
        if (evidence?.kind === "approval") detail = "aprobado por el usuario";
        if (evidence?.kind === "run") {
          let orphan = false;
          let behind: string | null = null;
          try {
            execFileSync("git", ["merge-base", "--is-ancestor", evidence.commit, "HEAD"], {
              cwd,
              stdio: "ignore",
            });
            behind = execFileSync("git", ["rev-list", "--count", `${evidence.commit}..HEAD`], {
              cwd,
              encoding: "utf8",
              stdio: ["ignore", "pipe", "ignore"],
            }).trim();
          } catch {
            orphan = true;
          }
          detail = `${evidence.command}; ${evidence.result}; ${evidence.commit.slice(0, 8)}${orphan ? " · orphan" : ` · commitsBehind=${behind}`}`;
        }
        lines.push(
          `| ${part.id}.${criterion.id} | ${criterion.method} | ${escapeCell(detail)} | ${evidence?.date ?? "—"} |`,
        );
      }
    lines.push(
      "",
      `- ${language === "es" ? "Decisiones" : "Decisions"}: ${decisionCount(join(stagePath, "DECISIONS.md"))}`,
    );
  }
  lines.push(
    "",
    `## ${masterMarkers(language).integridad}`,
    "",
    "| Archivo | SHA-256 |",
    "|---|---|",
  );
  for (const file of [
    "MASTER.md",
    "DECISIONS.md",
    "UX.md",
    "ux.json",
    "parts.json",
    "state.json",
  ]) {
    const path = join(stagePath, file);
    if (existsSync(path))
      lines.push(
        `| ${file} | ${hash(file === "state.json" ? finalStateBytes : readFileSync(path, "utf8"))} |`,
      );
  }
  return `${lines.join("\n")}\n`;
}

/** Close one active stage, or repair only the final config/render step after a cut. */
export function runMasterClose(cwd: string, options: CloseOptions = {}): CloseResult {
  if (options.convert && options.abandon) throw new Error("--convert y --abandon son excluyentes");
  const configPath = join(cwd, "navori.config.json");
  const config = readConfig(configPath);
  const specsDir = config.sdd?.specsDir ?? "specs";
  const index = readMasterIndex(cwd, specsDir);
  const stage = activeStage(index);
  if (stage?.workflow === "deliveries") {
    if (options.convert || options.abandon || options.reason)
      throw new Error(
        "deliveries close requires identity-bound dispositions, not legacy close options",
      );
    const context = deliveryAuthority(cwd);
    const lifecycle = context.state.closure ? null : deliveryLifecycle(cwd);
    if (lifecycle?.blockers.length) throw new Error(lifecycle.blockers.join("; "));
    // Publication writes are rejected on closed stages, so it must precede close.
    if (lifecycle?.pendingPublication.length)
      throw new Error(
        `accepted deliveries await publication: ${lifecycle.pendingPublication.join(", ")}; run 'navori master delivery-publication' for each before close`,
      );
    const paths = [
      indexJsonPath(cwd, specsDir),
      indexMdPath(cwd, specsDir),
      configPath,
      join(context.stagePath, "STATUS.md"),
    ];
    const root = realpathSync(cwd);
    for (const path of paths) {
      const parent = realpathSync(resolve(path, ".."));
      if (!parent.startsWith(`${root}${sep}`) && parent !== root)
        throw new Error("close output escapes repository");
      if (existsSync(path) && realpathSync(path) !== path)
        throw new Error("close output is redirected");
    }
    if (!context.state.closure) {
      const fresh = deliveryAuthority(cwd);
      if (
        JSON.stringify(fresh.state) !== JSON.stringify(context.state) ||
        JSON.stringify(deliveryLifecycle(cwd)) !== JSON.stringify(lifecycle)
      )
        throw new Error("delivery changed before close");
      fresh.state.closure = {
        closedAt: new Date().toISOString(),
        baselineIdentity: fresh.identity,
        authorityGeneration: fresh.state.authorityGeneration!,
        // Always empty: close refuses while publication is pending (see above).
        pendingPublication: [],
      };
      fresh.state.phase = "closed";
      writeDeliveryState(cwd, fresh.stagePath, fresh.state);
      context.state = fresh.state;
    }
    options.afterStep?.(1);
    writeMasterStatus(cwd);
    options.afterStep?.(2);
    const finalIndex: MasterIndex = {
      ...index!,
      stages: index!.stages.map((entry) =>
        entry.dir === stage.dir
          ? { ...entry, state: "cerrada", closedAt: context.state.closure!.closedAt.slice(0, 10) }
          : entry,
      ),
    };
    save(indexJsonPath(cwd, specsDir), finalIndex);
    writeFileAtomic(indexMdPath(cwd, specsDir), renderIndexMd(finalIndex, specsDir));
    options.afterStep?.(3);
    finishRender(cwd, configPath, config);
    return { stage: stage.dir, outcome: "entregada", reconciled: Boolean(lifecycle === null) };
  }
  if (!stage) {
    if (
      !options.convert &&
      !options.abandon &&
      !options.reason &&
      index?.stages.length &&
      config.harness?.masterPlan === false
    )
      return { stage: null, outcome: null, reconciled: false };
    if (
      !options.convert &&
      !options.abandon &&
      !options.reason &&
      config.harness?.masterPlan === true
    ) {
      finishRender(cwd, configPath, config);
      return { stage: null, outcome: null, reconciled: true };
    }
    throw new Error("no hay etapa activa; una etapa cerrada es de solo lectura");
  }
  const stagePath = join(masterDirPath(cwd, specsDir), stage.dir);
  const statePath = join(stagePath, "state.json");
  const state = json(statePath, MasterStateSchema.parse.bind(MasterStateSchema));
  const existing = state.outcome;
  const outcome =
    existing ?? (options.convert ? "convertida" : options.abandon ? "abandonada" : "entregada");
  if (existing && (options.reason || options.convert || options.abandon))
    throw new Error("cierre ya iniciado: reanude con 'navori master close' sin opciones");
  if (!existing) {
    const early = ["context", "transcribed", "mapped", "planned", "questioned"].includes(
      state.phase,
    );
    if (outcome === "entregada") {
      const status = readMasterStatus(cwd);
      const blocked = closeBlockers(state, status.parts);
      if (blocked.length > 0) throw new Error(blocked.join("\n"));
      if (!status.closable)
        throw new Error(`no se puede cerrar; blockers:\n${status.blockers.join("\n")}`);
    } else {
      if (!early) throw new Error(`en fase ${state.phase} use 'navori master close' para entregar`);
      if (!options.reason?.trim()) throw new Error("--reason no puede estar vacío");
      if (outcome === "convertida") specPath(cwd, specsDir, options.convert!);
    }
  }
  const closedAt = state.closedAt ?? new Date().toISOString().slice(0, 10);
  const updated: MasterState = existing
    ? state
    : MasterStateSchema.parse({
        ...state,
        outcome,
        closedAt,
        ...(outcome === "convertida"
          ? {
              conversion: {
                spec: specPath(cwd, specsDir, options.convert!),
                reason: options.reason!.trim(),
              },
            }
          : {}),
        ...(outcome === "abandonada"
          ? { abandonment: { reason: options.reason!.trim(), phase: state.phase } }
          : {}),
      });
  // Step 1: durable outcome/date. The remaining steps use these, not today's date.
  if (!existing) save(statePath, updated);
  options.afterStep?.(1);
  // Step 2: last derived status while the stage is still active.
  if (updated.phase !== "closed") writeMasterStatus(cwd);
  options.afterStep?.(2);
  const partsPath = join(stagePath, "parts.json");
  const parts = existsSync(partsPath)
    ? json(partsPath, PartsSchema.parse.bind(PartsSchema)).parts
    : [];
  const finalState: MasterState =
    updated.phase === "closed"
      ? updated
      : {
          ...updated,
          phase: "closed",
          history: [...updated.history, { phase: "closed", at: closedAt }],
        };
  // Step 3: hash the exact state bytes step 4 will persist.
  const closurePath = join(stagePath, "CLOSURE.md");
  if (!existsSync(closurePath)) {
    const status = updated.phase === "closed" ? null : readMasterStatus(cwd);
    const finalStateBytes = `${JSON.stringify(finalState, null, 2)}\n`;
    writeFileAtomic(
      closurePath,
      renderClosure(
        cwd,
        stagePath,
        stage.dir,
        stage.openedAt,
        finalState,
        parts,
        status,
        config.language,
        finalStateBytes,
      ),
    );
  }
  options.afterStep?.(3);
  // Step 4: stage becomes immutable.
  if (updated.phase !== "closed") save(statePath, finalState);
  options.afterStep?.(4);
  // Step 5: registry and its derived index move together.
  const finalIndex: MasterIndex = {
    ...(index as MasterIndex),
    stages: (index as MasterIndex).stages.map((entry) =>
      entry.dir === stage.dir
        ? {
            ...entry,
            state: outcome === "entregada" ? "cerrada" : outcome,
            closedAt,
            spec: finalState.conversion?.spec ?? null,
          }
        : entry,
    ),
  };
  save(indexJsonPath(cwd, specsDir), finalIndex);
  writeFileAtomic(indexMdPath(cwd, specsDir), renderIndexMd(finalIndex, specsDir));
  options.afterStep?.(5);
  // Step 6: config and managed render (idempotent after a failed render).
  finishRender(cwd, configPath, config);
  options.afterStep?.(6);
  return { stage: stage.dir, outcome, reconciled: false };
}
