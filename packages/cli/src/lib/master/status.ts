import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { readConfig } from "../config/config.ts";
import { writeFileAtomic } from "../primitives/atomic.ts";
import { checkPart } from "./check-part.ts";
import { DeliveryStateSchema } from "./delivery-schema.ts";
import { checkActiveDelivery } from "./delivery.ts";
import { deliveryDigest } from "./delivery-checks.ts";
import {
  MASTER_PHASES,
  MasterStateSchema,
  PartsSchema,
  type MasterIndex,
  type MasterPhase,
  type MasterState,
  type MasterUxChoice,
  type Part,
  type PartState,
} from "./schema.ts";
import { checkUxArtifacts, checkUxDecision } from "./ux.ts";
import {
  activeStage,
  assertLegacyStage,
  contextForArchitects,
  indexMdPath,
  lastClosedStage,
  masterDirPath,
  readMasterIndex,
  renderIndexMd,
} from "./stages.ts";

export interface EffectivePart {
  id: string;
  title: string;
  declared: PartState;
  effective: PartState;
  reason: string | null;
  tasksDone: number;
  tasksTotal: number;
  spec: string | null;
  issue: number | null;
  acceptance: {
    id: string;
    method: string;
    verified: boolean;
    commitsBehind: number | null;
    orphan: boolean;
  }[];
}

export interface MasterStatus {
  workflow?: "deliveries";
  stage: { number: number; slug: string; dir: string } | null;
  phase: MasterPhase | "execution" | "review" | null;
  nextPhase: MasterPhase | null;
  mode: string | null;
  /** Only present once the UX decision is recorded (`navori master ux`). */
  ux?: MasterUxChoice;
  activePart: string | null;
  parts: EffectivePart[];
  discrepancies: string[];
  allDone: boolean;
  closable: boolean;
  blockers: string[];
  lastClosed: { number: number; slug: string; state: string; closedAt: string | null } | null;
  architectContext?: ReturnType<typeof contextForArchitects>;
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function safeSpec(cwd: string, specsDir: string, relative: string): string | null {
  const root = resolve(cwd, specsDir);
  const path = resolve(cwd, relative);
  if (path !== root && !path.startsWith(`${root}${sep}`)) return null;
  if (!existsSync(path)) return null;
  // A symlink must not turn a read of tasks.md into a read outside the repo.
  const real = requireRealPath(path);
  const realRoot = requireRealPath(root);
  return real && realRoot && (real === realRoot || real.startsWith(`${realRoot}${sep}`))
    ? path
    : null;
}

function requireRealPath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function taskCounts(spec: string | null): { done: number; total: number } {
  const path = spec && join(spec, "tasks.md");
  if (!path || !existsSync(path)) return { done: 0, total: 0 };
  const real = requireRealPath(path);
  if (!real || !real.startsWith(`${realpathSync(spec)}${sep}`)) return { done: 0, total: 0 };
  const text = readFileSync(path, "utf8");
  const tasks = [...text.matchAll(/^\s*- \[([ xX])\] /gm)];
  return { done: tasks.filter((m) => m[1] !== " ").length, total: tasks.length };
}

function evidenceAge(cwd: string, commit: string): { behind: number | null; orphan: boolean } {
  const ancestor = git(cwd, ["merge-base", "--is-ancestor", commit, "HEAD"]);
  // git() returns empty string for a successful --is-ancestor and null otherwise.
  if (ancestor === null) return { behind: null, orphan: true };
  const count = git(cwd, ["rev-list", "--count", `${commit}..HEAD`]);
  return { behind: count === null ? null : Number(count), orphan: false };
}

const DELIVERABLE_PHASES: readonly MasterPhase[] = ["mastered", "ux", "executing"];

/**
 * Reasons a stage cannot be delivered regardless of per-part detail: wrong
 * phase, no parts at all, or a part that is neither done nor dispositioned.
 * Shared by `runMasterClose` and `readMasterStatus` so `closable` never offers
 * a close the command then rejects (R53).
 */
export function closeBlockers(
  state: Pick<MasterState, "phase">,
  parts: readonly Pick<EffectivePart, "id" | "effective">[],
): string[] {
  if (!DELIVERABLE_PHASES.includes(state.phase))
    return [`no se puede entregar en fase ${state.phase}`];
  if (parts.length === 0) return ["no se puede entregar sin partes"];
  return parts
    .filter((p) => !["hecho", "descartada", "diferida"].includes(p.effective))
    .map((p) => `${p.id}: ${p.effective}`);
}

/** Derive effective progress from JSON and linked task checkboxes; no writes. */
export function readMasterStatus(cwd: string): MasterStatus {
  const config = readConfig(join(cwd, "navori.config.json"));
  const specsDir = config.sdd?.specsDir ?? "specs";
  const index = readMasterIndex(cwd, specsDir);
  const closed = index ? lastClosedStage(index) : null;
  const lastClosed = closed
    ? { number: closed.number, slug: closed.slug, state: closed.state, closedAt: closed.closedAt }
    : null;
  // First use is a normal case (R52): no index.json means an empty status, not an error.
  const stage = index ? activeStage(index) : null;
  const empty: MasterStatus = {
    stage: null,
    phase: null,
    nextPhase: null,
    mode: null,
    activePart: null,
    parts: [],
    discrepancies: [],
    allDone: false,
    closable: false,
    blockers: [],
    lastClosed,
  };
  if (!stage) return empty;
  const stagePath = join(masterDirPath(cwd, specsDir), stage.dir);
  if (stage.workflow === "deliveries") {
    const state = DeliveryStateSchema.parse(
      JSON.parse(readFileSync(join(stagePath, "state.json"), "utf8")) as unknown,
    );
    const preparation = existsSync(join(stagePath, "parts.json")) ? checkActiveDelivery(cwd) : null;
    if (preparation && !preparation.parts)
      throw new Error(`${stage.dir}: invalid parts.json: ${preparation.blockers.join("; ")}`);
    const blockers = preparation?.blockers ?? ["parts.json is not prepared"];
    if (
      preparation?.parts &&
      preparation.sourceDigest &&
      preparation.designDigest &&
      preparation.masterDigest
    ) {
      const identity = deliveryDigest([
        preparation.parts.digest,
        preparation.sourceDigest,
        preparation.designDigest,
        preparation.masterDigest,
      ]);
      if (state.baseline?.identity !== identity) blockers.push("baseline is missing or stale");
      if (!state.authorization) blockers.push("queue authorization is pending");
    }
    return {
      ...empty,
      workflow: "deliveries",
      stage: { number: stage.number, slug: stage.slug, dir: stage.dir },
      phase: state.phase,
      mode: state.mode,
      blockers,
    };
  }
  assertLegacyStage(stage);
  const state = MasterStateSchema.parse(
    JSON.parse(readFileSync(join(stagePath, "state.json"), "utf8")) as unknown,
  );
  const partsPath = join(stagePath, "parts.json");
  const parts = existsSync(partsPath)
    ? PartsSchema.parse(JSON.parse(readFileSync(partsPath, "utf8")) as unknown).parts
    : [];
  const discrepancies: string[] = [];
  const blockers: string[] = [];
  // Delivery must not skip the UX decision (a stage closed from `mastered`/`ux`
  // never ran the ux -> executing gate); legacy `executing` stages with no
  // decision only get the presence-consistency check.
  const uxCtx = {
    cwd,
    specsDir,
    language: config.language,
    stagePath,
    stage: { dir: stage.dir },
    state,
  };
  if (state.phase === "mastered" || state.phase === "ux") blockers.push(...checkUxDecision(uxCtx));
  if (state.phase === "mastered" || state.phase === "ux" || state.phase === "executing")
    blockers.push(...checkUxArtifacts(uxCtx));
  const mapped = parts.map((part): EffectivePart => {
    const spec = part.spec ? safeSpec(cwd, specsDir, part.spec) : null;
    const { done, total } = taskCounts(spec);
    const acceptance = part.acceptance.map((criterion) => {
      const age =
        criterion.evidence?.kind === "run"
          ? evidenceAge(cwd, criterion.evidence.commit)
          : { behind: null, orphan: false };
      return {
        id: criterion.id,
        method: criterion.method,
        verified: criterion.evidence !== null,
        commitsBehind: age.behind,
        orphan: age.orphan,
      };
    });
    const missing = acceptance
      .filter((a) => !a.verified)
      .map((a) => `${part.id}.${a.id}: sin evidencia`);
    let effective: PartState = part.state;
    if (part.state !== "descartada" && part.state !== "diferida") {
      if (part.spec)
        effective = !spec
          ? "pendiente"
          : total > 0 && done === total && missing.length === 0
            ? "hecho"
            : done > 0 || (total > 0 && missing.length > 0)
              ? "parcial"
              : "pendiente";
      else if (part.state === "hecho" && missing.length > 0) effective = "parcial";
    }
    if (effective !== part.state)
      discrepancies.push(`${part.id}: declarado ${part.state}, efectivo ${effective}`);
    if (part.spec && !spec) blockers.push(`${part.id}: spec no encontrada: ${part.spec}`);
    if (effective !== "hecho" && effective !== "descartada" && effective !== "diferida")
      blockers.push(`${part.id}: ${effective}`);
    if (effective === "parcial") blockers.push(...missing);
    if (effective === "hecho" && part.spec) {
      const failures = checkPart(cwd, part.id).filter((f) => !f.startsWith("warning:"));
      blockers.push(...failures.map((f) => `${part.id}: ${f}`));
    }
    return {
      id: part.id,
      title: part.title,
      declared: part.state,
      effective,
      reason: part.reason,
      tasksDone: done,
      tasksTotal: total,
      spec: part.spec,
      issue: part.issue,
      acceptance,
    };
  });
  const active =
    mapped.find((p) => p.effective === "parcial") ??
    mapped.find(
      (p) =>
        p.effective === "pendiente" &&
        (parts
          .find((part) => part.id === p.id)
          ?.dependsOn.every((id) => mapped.find((d) => d.id === id)?.effective === "hecho") ??
          false),
    );
  const phaseIndex = MASTER_PHASES.indexOf(state.phase);
  return {
    stage: { number: stage.number, slug: stage.slug, dir: stage.dir },
    phase: state.phase,
    nextPhase:
      state.phase === "executing" || state.phase === "closed"
        ? null
        : (MASTER_PHASES[phaseIndex + 1] ?? null),
    mode: state.mode,
    ...(state.ux ? { ux: state.ux } : {}),
    activePart: active?.id ?? null,
    parts: mapped,
    discrepancies,
    allDone: mapped.length > 0 && mapped.every((p) => p.effective === "hecho"),
    closable:
      mapped.length > 0 && blockers.length === 0 && closeBlockers(state, mapped).length === 0,
    blockers,
    lastClosed,
    ...(stage.number >= 2 ? { architectContext: contextForArchitects(index as MasterIndex) } : {}),
  };
}

/** Render derived STATUS.md without wall-clock data. */
export function renderStatusMd(status: MasterStatus): string {
  if (status.workflow === "deliveries")
    return [
      `# Estado de entrega ${status.stage?.dir ?? "ninguna"}`,
      "",
      "Workflow: deliveries",
      `Fase: ${status.phase ?? "context"}`,
      `Preparación: ${status.blockers.length === 0 ? "lista" : "pendiente"}`,
      "Cerrable: no",
      "",
      "## Bloqueos",
      "",
      ...status.blockers.map((blocker) => `- ${blocker}`),
      "",
    ].join("\n");
  const lines = [
    `# Estado de etapa ${status.stage?.dir ?? "ninguna"}`,
    "",
    `Fase: ${status.phase ?? "ninguna"}`,
    ...(status.ux ? [`UX: ${status.ux}`] : []),
    `Parte activa: ${status.activePart ?? "ninguna"}`,
    `Cerrable: ${status.closable ? "sí" : "no"}`,
    "",
    "| Parte | Estado | Tareas | Spec | Issue |",
    "|---|---|---|---|---|",
  ];
  for (const part of status.parts)
    lines.push(
      `| ${part.id} | ${part.effective} | ${part.tasksDone}/${part.tasksTotal} | ${part.spec ?? "—"} | ${part.issue ?? "—"} |`,
    );
  lines.push("", "## Evidencia", "");
  for (const part of status.parts)
    for (const criterion of part.acceptance)
      lines.push(
        `- ${part.id}.${criterion.id} (${criterion.method}): ${criterion.verified ? "verificado" : "sin evidencia"}${criterion.commitsBehind === null ? "" : ` · commitsBehind=${criterion.commitsBehind}`}${criterion.orphan ? " · orphan" : ""}`,
      );
  lines.push(
    "",
    "## Discrepancias",
    "",
    ...(status.discrepancies.length ? status.discrepancies.map((d) => `- ${d}`) : ["Ninguna"]),
    "",
    "## Bloqueos",
    "",
    ...(status.blockers.length ? status.blockers.map((b) => `- ${b}`) : ["Ninguno"]),
    "",
  );
  return lines.join("\n");
}

export function renderMasterParts(parts: readonly Part[], mode: string | null): string {
  const body = parts
    .flatMap((part) => [
      `### ${part.id} — ${part.title}`,
      "",
      `Objetivo: ${part.objective}`,
      `Alcance: ${part.scope.join("; ") || "—"}`,
      `Fuera de alcance: ${part.outOfScope.join("; ") || "—"}`,
      `Dependencias: ${part.dependsOn.join(", ") || "—"}`,
      `Requisitos semilla: ${part.seedRequirements.join(", ") || "—"}`,
      ...(mode === "en-curso" ? [`Estado: ${part.state}`] : []),
      ...part.acceptance.map(
        (a) =>
          `- ${part.id}.${a.id} (${a.method}): ${a.description} — ${a.method === "test" ? `${a.test.file}#${a.test.case}` : a.method === "comando" ? a.command.run : a.manual.check}`,
      ),
      "",
    ])
    .join("\n");
  const hash = createHash("sha256").update(body).digest("hex").slice(0, 8);
  return `<!-- navori:master-parts hash="${hash}" -->\n${body}<!-- /navori:master-parts -->`;
}

export function masterPartsRegion(content: string): string | null {
  const start = content.indexOf('<!-- navori:master-parts hash="');
  if (start < 0) return null;
  const headerEnd = content.indexOf(" -->", start);
  if (headerEnd < 0) return null;
  const closing = "<!-- /navori:master-parts -->";
  const end = content.indexOf(closing, headerEnd + 4);
  return end < 0 ? null : content.slice(start, end + closing.length);
}

function assertWritableInRepo(cwd: string, path: string): void {
  const root = realpathSync(cwd);
  const parent = realpathSync(resolve(path, ".."));
  if (!parent.startsWith(`${root}${sep}`))
    throw new Error(`refusing to write outside repository: ${path}`);
  if (existsSync(path) && !realpathSync(path).startsWith(`${root}${sep}`))
    throw new Error(`refusing symlink write outside repository: ${path}`);
}

/** Regenerate only derived files of the active stage after all inputs validate. */
export function writeMasterStatus(cwd: string): MasterStatus {
  const status = readMasterStatus(cwd);
  const config = readConfig(join(cwd, "navori.config.json"));
  const specsDir = config.sdd?.specsDir ?? "specs";
  const index = readMasterIndex(cwd, specsDir);
  if (!index) throw new Error("no index.json: run 'navori master init <slug>' first");
  if (status.stage) {
    const stagePath = join(masterDirPath(cwd, specsDir), status.stage.dir);
    if (status.workflow === "deliveries") {
      const statusPath = join(stagePath, "STATUS.md");
      assertWritableInRepo(cwd, statusPath);
      assertWritableInRepo(cwd, indexMdPath(cwd, specsDir));
      writeFileAtomic(statusPath, renderStatusMd(status));
      writeFileAtomic(indexMdPath(cwd, specsDir), renderIndexMd(index, specsDir));
      return status;
    }
    const partsPath = join(stagePath, "parts.json");
    const masterPath = join(stagePath, "MASTER.md");
    const parts = existsSync(partsPath)
      ? PartsSchema.parse(JSON.parse(readFileSync(partsPath, "utf8")) as unknown).parts
      : [];
    let replacement: string | null = null;
    if (existsSync(masterPath)) {
      const content = readFileSync(masterPath, "utf8");
      const region = renderMasterParts(parts, status.mode);
      const existing = masterPartsRegion(content);
      if (existing) replacement = content.replace(existing, region);
      else {
        const heading = /^## (?:Entrega en partes|Delivery in parts)\s*$/m.exec(content);
        if (heading?.index !== undefined) {
          const start = heading.index + heading[0].length;
          const next = /^## /gm;
          next.lastIndex = start;
          const end = next.exec(content)?.index ?? content.length;
          replacement = `${content.slice(0, start)}\n\n${region}\n\n${content.slice(end).trimStart()}`;
        }
      }
    }
    const statusPath = join(stagePath, "STATUS.md");
    assertWritableInRepo(cwd, statusPath);
    if (replacement !== null) assertWritableInRepo(cwd, masterPath);
    assertWritableInRepo(cwd, indexMdPath(cwd, specsDir));
    writeFileAtomic(statusPath, renderStatusMd(status));
    if (replacement !== null) writeFileAtomic(masterPath, replacement);
  } else assertWritableInRepo(cwd, indexMdPath(cwd, specsDir));
  writeFileAtomic(indexMdPath(cwd, specsDir), renderIndexMd(index, specsDir));
  return status;
}

export function statusLine(status: MasterStatus, specsDir: string): string {
  if (!status.stage) return "Plan maestro — sin etapa activa.";
  if (status.workflow === "deliveries")
    return `Plan maestro — entrega ${status.stage.dir}: ${status.blockers.length ? "preparación pendiente" : "preparación lista"}; ${specsDir}/_master/${status.stage.dir}/STATUS.md.`;
  const part = status.parts.find((p) => p.id === status.activePart);
  const clean = [...(part?.title ?? "")]
    .map((char) => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? " " : char))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  const shortTitle = [...clean].slice(0, 60).join("").replace(/"/g, "'");
  return `Plan maestro — etapa ${status.stage.dir}: ${part ? `parte activa ${part.id} "${shortTitle}"` : "sin parte activa"} · ${part?.tasksDone ?? 0}/${part?.tasksTotal ?? 0} tareas · ${specsDir}/_master/${status.stage.dir}/STATUS.md. En tu primera respuesta de la sesión, ofrece continuar con el plan maestro en una sola línea, sin interrumpir lo que el usuario pidió.`;
}
