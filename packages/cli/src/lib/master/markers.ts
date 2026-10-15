/**
 * Master-plan prose markers, by language (spec 0034, coordinator decision on
 * this lote's discrepancy #2): the literals `checks.ts` parses out of
 * architect-written Markdown — `Origen:`, `Ninguna`, `[SUPUESTO]`,
 * `[SIN VERIFICAR]`, the `DECISIONS.md` field labels, `Sin decisiones`,
 * `No aplica:`, `consultado`, `Fuente:`, and the `INTAKE.md` column names —
 * live in ONE map here, keyed by `AssetLanguage`, the same shape `lib/i18n.ts`
 * uses for the `init` wizard's strings (a literal `Record<Lang, Strings>`, so
 * a missing key is a TS error, not a silent fallback). `checks.ts` resolves
 * this map with `ctx.language`, the exact same value `templates.ts` already
 * uses to resolve which template file to read — the two must never disagree
 * on a repo's marker language.
 */
import type { AssetLanguage } from "../render/render-plan.ts";

export interface MasterMarkers {
  /** Ends every `MASTER.md`/`plan<n>.md` section: `Origen: plan1 §2`. */
  origen: string;
  /** The literal body of "Preguntas abiertas" when there are none (R32). */
  ninguna: string;
  /** Marks an unresolved business-rule assumption (R22). */
  supuesto: string;
  /** Marks an unresolved fact that caducates (R23). */
  sinVerificar: string;
  /** `DECISIONS.md` field labels (R29). */
  pregunta: string;
  elegida: string;
  descartadas: string;
  fecha: string;
  /** The whole-file literal when no decision was made yet. */
  sinDecisiones: string;
  /** Prefixes a section that does not apply, followed by its reason (R21). */
  noAplica: string;
  /** The word next to a citation's date (`consultado 2026-09-25` / `consulted 2026-09-25`, R23). */
  consultado: string;
  /** First line of every `context/md/*.md` file (R11). */
  fuente: string;
  /** `INTAKE.md`'s three column headers (R10, R11). */
  archivoColumn: string;
  metodoColumn: string;
  resultadoColumn: string;
  /** The word inside the header line's "· Método: markitdown 0.1.2" segment. */
  metodoLabel: string;
  /** A `DIGEST.md` counting section with nothing in it (masculine in Spanish,
   * distinct from `ninguna` — R32's "Preguntas abiertas" is feminine). Reused
   * by `templates.ts`'s `issue` template for empty `scope`/`outOfScope`/
   * `acceptance` lists — same grammatical gender, same word. */
  ningunoDigest: string;
  /** `CLOSURE.md`'s hash table heading (D10, R50) — `check --stage` reads its
   * hashes to detect a hand-edit of a closed stage. */
  integridad: string;
  /** `CODEBASE.md`'s required section headings, in order (R31). */
  codebaseHeaders: readonly string[];
  /** Labels `renderStatusMd` writes into `STATUS.md` (R31). */
  status: {
    stage: string;
    delivery: string;
    phase: string;
    activePart: string;
    closable: string;
    yes: string;
    no: string;
    none: string;
    pendingPublication: string;
    blockers: string;
    evidence: string;
    discrepancies: string;
    verified: string;
    unverified: string;
    /** `Parte | Estado | Tareas | Spec | Issue` columns. */
    columns: readonly [string, string, string, string, string];
  };
  /** Labels `renderMasterParts` writes into the `navori:master-parts` region (R31). */
  parts: {
    objective: string;
    scope: string;
    outOfScope: string;
    dependsOn: string;
    seedRequirements: string;
    state: string;
  };
  /** Labels `renderClosure` writes into `CLOSURE.md` (R31). */
  closure: {
    title: string;
    outcome: string;
    opened: string;
    closed: string;
    reason: string;
    phase: string;
    parts: string;
    criteria: string;
    decisions: string;
    /** `ID | Estado | Spec | Issue | Razón` columns. */
    partColumns: readonly [string, string, string, string, string];
    /** `ID | Método | Evidencia | Fecha` columns. */
    criterionColumns: readonly [string, string, string, string];
    unverified: string;
    approvedByUser: string;
  };
}

const MASTER_MARKERS: Readonly<Record<AssetLanguage, MasterMarkers>> = {
  es: {
    origen: "Origen:",
    ninguna: "Ninguna",
    supuesto: "[SUPUESTO]",
    sinVerificar: "[SIN VERIFICAR]",
    pregunta: "Pregunta:",
    elegida: "Elegida:",
    descartadas: "Descartadas:",
    fecha: "Fecha:",
    sinDecisiones: "Sin decisiones",
    noAplica: "No aplica:",
    consultado: "consultado",
    fuente: "Fuente:",
    archivoColumn: "Archivo",
    metodoColumn: "Método",
    resultadoColumn: "Resultado",
    metodoLabel: "Método",
    ningunoDigest: "Ninguno",
    integridad: "Integridad",
    codebaseHeaders: ["Stack", "Estructura", "Convenciones", "Specs"],
    status: {
      stage: "Estado de etapa",
      delivery: "Estado de entrega",
      phase: "Fase",
      activePart: "Parte activa",
      closable: "Cerrable",
      yes: "sí",
      no: "no",
      none: "ninguna",
      pendingPublication: "Publicación pendiente",
      blockers: "Bloqueos",
      evidence: "Evidencia",
      discrepancies: "Discrepancias",
      verified: "verificado",
      unverified: "sin evidencia",
      columns: ["Parte", "Estado", "Tareas", "Spec", "Issue"],
    },
    parts: {
      objective: "Objetivo",
      scope: "Alcance",
      outOfScope: "Fuera de alcance",
      dependsOn: "Dependencias",
      seedRequirements: "Requisitos semilla",
      state: "Estado",
    },
    closure: {
      title: "Cierre",
      outcome: "Resultado",
      opened: "Apertura",
      closed: "Cierre",
      reason: "Razón",
      phase: "Fase",
      parts: "Partes",
      criteria: "Criterios",
      decisions: "Decisiones",
      partColumns: ["ID", "Estado", "Spec", "Issue", "Razón"],
      criterionColumns: ["ID", "Método", "Evidencia", "Fecha"],
      unverified: "no verificado",
      approvedByUser: "aprobado por el usuario",
    },
  },
  en: {
    origen: "Source:",
    ninguna: "None",
    supuesto: "[ASSUMED]",
    sinVerificar: "[UNVERIFIED]",
    pregunta: "Question:",
    elegida: "Chosen:",
    descartadas: "Discarded:",
    fecha: "Date:",
    sinDecisiones: "No decisions",
    noAplica: "Not applicable:",
    consultado: "consulted",
    fuente: "Source:",
    archivoColumn: "File",
    metodoColumn: "Method",
    resultadoColumn: "Result",
    metodoLabel: "Method",
    ningunoDigest: "None",
    integridad: "Integrity",
    codebaseHeaders: ["Stack", "Structure", "Conventions", "Specs"],
    status: {
      stage: "Stage status",
      delivery: "Delivery status",
      phase: "Phase",
      activePart: "Active part",
      closable: "Closable",
      yes: "yes",
      no: "no",
      none: "none",
      pendingPublication: "Pending publication",
      blockers: "Blockers",
      evidence: "Evidence",
      discrepancies: "Discrepancies",
      verified: "verified",
      unverified: "no evidence",
      columns: ["Part", "State", "Tasks", "Spec", "Issue"],
    },
    parts: {
      objective: "Objective",
      scope: "Scope",
      outOfScope: "Out of scope",
      dependsOn: "Dependencies",
      seedRequirements: "Seed requirements",
      state: "State",
    },
    closure: {
      title: "Closure",
      outcome: "Outcome",
      opened: "Opened",
      closed: "Closed",
      reason: "Reason",
      phase: "Phase",
      parts: "Parts",
      criteria: "Criteria",
      decisions: "Decisions",
      partColumns: ["ID", "State", "Spec", "Issue", "Reason"],
      criterionColumns: ["ID", "Method", "Evidence", "Date"],
      unverified: "not verified",
      approvedByUser: "approved by the user",
    },
  },
};

/** Resolves the marker set for `language`, the same value `templates.ts`
 * resolves template files with — `checks.ts` must always call this with
 * `ctx.language`, never a literal. */
export function masterMarkers(language: AssetLanguage): MasterMarkers {
  return MASTER_MARKERS[language];
}

/** Escapes a literal for safe embedding inside a `RegExp` — markers like
 * `[SUPUESTO]`/`[ASSUMED]` contain regex metacharacters. */
export function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
