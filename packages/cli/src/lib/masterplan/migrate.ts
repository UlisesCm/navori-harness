/**
 * `navori master migrate` (spec 0063): turns a v1 stage into the v2 `PLAN.md`
 * for one release. It keeps the slice numbers the v1 already has (branch or
 * mark `slice/s<NN>-`), never renumbers, never overwrites a plan and never
 * writes `navori/acceptance`: v1 acceptances are only suggested.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { runRender } from "../../commands/render.ts";
import { readConfig } from "../config/config.ts";
import { resolveLang, tc } from "../i18n.ts";
import { writeFileAtomic } from "../primitives/atomic.ts";
import { getCoreRoot } from "../render/bundled-assets.ts";
import { DeliveryPartsSchema, DeliveryStateSchema } from "../master/delivery-schema.ts";
import { PartsSchema } from "../master/schema.ts";
import { masterDirPath, readMasterIndex } from "../master/stages.ts";
import { FLAG_EDIT, RENDER_CMD, enableFlag, renderTemplate } from "./init.ts";
import { type CommandOutput, fail } from "./report.ts";
import { canonicalSliceId } from "./plan.ts";
import { git, gitRun, isSha, marksOf, planPath } from "./state.ts";

export interface MigrateOptions {
  /** Stage number; default the active one. */
  stage?: number;
  write?: boolean;
  root?: string;
  render?: (cwd: string) => { ok: boolean; reason?: string };
}

interface Row {
  /** `E<n>`, `P<n>` or the extra branch. */
  source: string;
  outcome: string;
  spec: string;
  num: number | null;
  /** Where `num` came from; empty when it is the next free number. */
  origin: string;
  /** Branch that must be renamed to carry the new number. */
  rename?: string;
}

const BRANCH_NUM = /^slice\/s0*([1-9]\d*)-/i;
const cell = (text: string): string => text.replace(/\s*\n\s*/g, " ").replaceAll("|", "/");

/** Unmerged remote `slice/sNN-` branches that no delivery owns: other deliveries (B3). */
function extraBranches(cwd: string, target: string, owned: Set<string>, warnings: string[]): Row[] {
  const list = git(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin/slice"]);
  if (list === null) return [];
  if (git(cwd, ["rev-parse", "--verify", "--quiet", `origin/${target}^{commit}`]) === null) {
    warnings.push(`sin origin/${target}: no busco ramas slice/ sin integrar`);
    return [];
  }
  return (
    list
      .split("\n")
      .map((ref) => ref.replace(/^origin\//, ""))
      .filter((name) => BRANCH_NUM.test(name) && !owned.has(name))
      .filter(
        (name) =>
          !gitRun(cwd, ["merge-base", "--is-ancestor", `origin/${name}`, `origin/${target}`]).ok,
      )
      // Work already marked with its own number is that slice in progress, not another delivery.
      .filter((name) => {
        const own = canonicalSliceId(`S${BRANCH_NUM.exec(name)?.[1]}`);
        const log =
          git(cwd, [
            "log",
            "--format=%B%x1e",
            "--end-of-options",
            `origin/${target}..origin/${name}`,
          ]) ?? "";
        return !log.split("\x1e").some((message) => marksOf(message.trimStart()).includes(own));
      })
      .map((name) => ({
        source: name,
        outcome: `Actor → resultado de ${name}`,
        spec: "",
        num: null,
        origin: "",
        rename: name,
      }))
  );
}

export function runPlanMigrate(cwd: string, options: MigrateOptions = {}): CommandOutput {
  const configPath = resolve(cwd, "navori.config.json");
  let config: ReturnType<typeof readConfig>;
  try {
    config = readConfig(configPath);
  } catch {
    return fail(tc(resolveLang(undefined)).master.initNoConfig(configPath));
  }
  const tr = tc(resolveLang(config.language)).master;
  const specsDir = config.sdd?.specsDir ?? "specs";
  const warnings: string[] = [];
  let rows: Row[] = [];
  let target = config.branchBase ?? "main";
  let slug = "plan";
  const suggestions: string[] = [];
  try {
    const stages = readMasterIndex(cwd, specsDir)?.stages ?? [];
    const stage = options.stage
      ? stages.find((s) => s.number === options.stage)
      : stages.find((s) => s.state === "activa");
    if (!stage) return fail("no hay etapa v1 activa que migrar (usa --stage <n>)");
    if (stage.state === "cerrada") return fail(`${stage.dir} está cerrada: no se migra`);
    slug = stage.slug;
    const stagePath = join(masterDirPath(cwd, specsDir), stage.dir);
    const read = (file: string): unknown => JSON.parse(readFileSync(join(stagePath, file), "utf8"));
    if (stage.workflow === "deliveries") {
      const doc = DeliveryPartsSchema.parse(read("parts.json"));
      target = doc.deliveries[0]?.git.integrationTarget ?? target;
      rows = doc.deliveries.map((d) => {
        const specs = doc.parts.filter((p) => p.deliveryId === d.id && p.spec).map((p) => p.spec);
        if (specs.length > 1) warnings.push(`${d.id}: ${specs.length} specs; uso la primera`);
        const n = BRANCH_NUM.exec(d.git.branch)?.[1];
        if (/^slice\/s0+-/i.test(d.git.branch))
          warnings.push(
            `${d.id}: ${d.git.branch} sería S0, que no existe; toma el siguiente libre`,
          );
        return {
          source: d.id,
          outcome: d.outcome,
          spec: specs[0] ?? "",
          num: n ? Number(n) : null,
          origin: n ? `rama ${d.git.branch}` : "",
        };
      });
      const owned = new Set(doc.deliveries.map((d) => d.git.branch));
      rows.push(...extraBranches(cwd, target, owned, warnings));
      const stateFile = join(stagePath, "state.json");
      const state = existsSync(stateFile)
        ? DeliveryStateSchema.safeParse(read("state.json"))
        : null;
      for (const d of state?.success ? (state.data.decisions ?? []) : []) {
        const row = rows.find((r) => r.source === d.deliveryId);
        if (d.decision === "accepted" && row) suggestions.push(row.source);
      }
    } else {
      for (const p of PartsSchema.parse(read("parts.json")).parts) {
        if (p.state === "descartada" || p.state === "diferida") {
          warnings.push(`${p.id}: ${p.state}, no se migra`);
          continue;
        }
        const run = p.acceptance.map((a) => a.evidence).find((e) => e?.kind === "run");
        const sha = run?.kind === "run" ? run.commit : "";
        if (sha && !isSha(sha))
          warnings.push(`${p.id}: el commit "${sha}" no es un SHA; lo ignoro`);
        const message = isSha(sha)
          ? git(cwd, ["log", "-1", "--format=%B", "--end-of-options", sha])
          : null;
        const marks = marksOf(message ?? "");
        if (marks.length > 1)
          warnings.push(
            `${p.id}: el commit ${sha.slice(0, 7)} trae varias marcas (${marks.join(", ")}); uso ${marks[0]}`,
          );
        const n = Number(marks[0]?.slice(1));
        rows.push({
          source: p.id,
          outcome: p.objective,
          spec: p.spec ?? "",
          num: n > 0 ? n : null,
          origin: n > 0 ? `marca del commit ${sha.slice(0, 7)}` : "",
        });
      }
    }
  } catch (cause) {
    if (cause instanceof Error) return fail(`no pude leer la etapa v1: ${cause.message}`);
    throw cause;
  }
  if (rows.length === 0) return fail("la etapa no tiene entregas ni partes que migrar");

  const used = new Set<number>();
  for (const r of rows) {
    if (r.num === null) continue;
    if (used.has(r.num)) {
      const twin = rows.find((o) => o !== r && o.num === r.num)?.source;
      return fail(
        `S${r.num} duplicado: ${twin} y ${r.source} caen en el mismo ID; corrige la rama o la marca`,
      );
    }
    used.add(r.num);
  }
  let next = Math.max(0, ...used);
  for (const r of rows) {
    if (r.num !== null) continue;
    r.num = ++next;
    if (r.rename) {
      const to = r.rename.replace(BRANCH_NUM, `slice/s${String(r.num).padStart(2, "0")}-`);
      r.origin = `siguiente libre; la rama ${r.rename} se renombra a ${to}`;
      warnings.push(
        `${r.rename} es otra entrega sin integrar: ahora es S${r.num}; renombra la rama a ${to} antes del PR (migrate no renombra ni empuja)`,
      );
    } else r.origin = "siguiente libre";
  }
  const noActor = rows.filter((r) => !r.outcome.includes("→")).map((r) => `S${r.num}`);
  if (noActor.length)
    warnings.push(`${noActor.join(", ")}: sin "actor → resultado"; edítalo en PLAN.md`);
  warnings.push("revisa Entorno y Rama de aceptación de PLAN.md (valores de la plantilla)");

  const file = planPath(cwd);
  const lang = resolveLang(config.language);
  const table = rows
    .map((r) => `| S${r.num} | ${cell(r.outcome)} | ${cell(r.spec)} | |\n`)
    .join("");
  const text = renderTemplate(options.root ?? getCoreRoot(), lang, slug, target).replace(
    /(\|---\|---\|---\|---\|\n)/,
    `$1${table}`,
  );
  const mapping = rows.map((r) => `${r.source} → S${r.num} (${r.origin})`);
  const hints = suggestions.map((id) => {
    const n = rows.find((r) => r.source === id)?.num;
    return `navori master accept S${n} --approved-by user   # aceptada en la v1 (${id})`;
  });
  const stderr = warnings.map((w) => `aviso: ${w}\n`).join("");
  const tail = hints.length ? `\nAceptaciones de la v1 (hazlas tú):\n${hints.join("\n")}\n` : "";
  const rel = file.slice(cwd.length + 1);
  if (!options.write)
    return { stdout: `${text}\nMapeo:\n${mapping.join("\n")}\n${tail}`, stderr, code: 0 };
  if (existsSync(file)) return fail(`${rel} ya existe: no se sobreescribe`);

  mkdirSync(dirname(file), { recursive: true });
  writeFileAtomic(file, text);
  try {
    if (enableFlag(configPath) === "non-canonical")
      return fail(tr.initFlagEdit(rel, configPath, FLAG_EDIT, RENDER_CMD));
  } catch {
    return fail(tr.initNoConfig(configPath));
  }
  const rendered = (options.render ?? runRender)(cwd);
  if (!rendered.ok) return fail(tr.initRenderFailed(rendered.reason ?? "unknown error"));
  return {
    stdout: `${tr.initCreated(rel)}\nMapeo:\n${mapping.join("\n")}\n${tail}`,
    stderr,
    code: 0,
  };
}
