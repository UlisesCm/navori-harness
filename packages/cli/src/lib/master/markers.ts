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
