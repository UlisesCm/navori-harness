/**
 * Reviewer findings sidecar (`review_<feature>.json`) and its append-only log
 * (spec 0039 R21, carry-over of 0038 D10). `logReview` validates the sidecar,
 * then appends one JSONL line per finding with score >= 50 to
 * `findings.jsonl` in the state directory. The log is never rewritten, so it
 * accumulates across features; a re-run of the same sidecar is deduped by the
 * sha256 of its raw bytes.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import {
  ensureStateDirectory,
  resolveStateRoot,
  stateArtifactPath,
  type StateRoot,
} from "../primitives/state-root.ts";

/** Findings below this score are noise and are not logged (R21). */
export const FINDING_SCORE_THRESHOLD = 50;
export const FINDINGS_LOG_NAME = "findings.jsonl";

export const FindingSchema = z.object({
  category: z.string().min(1),
  severity: z.enum(["critical", "high", "medium", "low"]),
  score: z.number().int().min(0).max(100),
  file: z.string().min(1),
  line: z.number().int().positive().optional(),
  summary: z.string().min(1).optional(),
});

export const ReviewSidecarSchema = z.object({
  feature: z.string().min(1),
  verdict: z.string().min(1),
  findings: z.array(FindingSchema),
});

export type ReviewSidecar = z.infer<typeof ReviewSidecarSchema>;

export type LogReviewResult =
  | { status: "appended"; hash: string; appended: number }
  | { status: "duplicate"; hash: string; appended: 0 }
  | { status: "error"; message: string };

/** Repo ERROR / WHY / FIX rejection text. */
function reject(error: string, why: string, fix: string): LogReviewResult {
  return { status: "error", message: `ERROR: ${error}\nWHY: ${why}\nFIX: ${fix}` };
}

export interface LogReviewOptions {
  cwd: string;
  feature: string;
  dir?: string;
}

/** Validates `review_<feature>.json` and appends its findings with score >= 50, deduped by sidecar hash. */
export function logReview(options: LogReviewOptions): LogReviewResult {
  const name = `review_${options.feature}.json`;
  let root: StateRoot;
  let sidecarPath: string;
  try {
    root = resolveStateRoot(options);
    sidecarPath = stateArtifactPath(root, name);
  } catch (error) {
    return reject(
      error instanceof Error ? error.message : String(error),
      "the feature slug or state directory is not a safe path inside this checkout",
      "use a lowercase feature slug and a --dir inside the checkout",
    );
  }
  if (!existsSync(sidecarPath)) {
    return reject(
      `${name} not found in ${root.dir}`,
      "the reviewer must write the sidecar before logging it",
      `write ${name} next to review_${options.feature}.md and re-run`,
    );
  }
  const raw = readFileSync(sidecarPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return reject(
      `${name} is not valid JSON`,
      "the log only accepts structured records",
      "fix the JSON syntax",
    );
  }
  const result = ReviewSidecarSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return reject(
      `${name} failed validation: ${detail}`,
      "each finding needs category, severity, score (0-100) and file",
      "correct the listed fields and re-run",
    );
  }
  if (result.data.feature !== options.feature) {
    return reject(
      `${name} declares feature "${result.data.feature}", expected "${options.feature}"`,
      "a mismatched sidecar would log findings under the wrong feature",
      "set the sidecar's feature to the slug passed on the command line",
    );
  }
  const hash = createHash("sha256").update(raw).digest("hex");
  ensureStateDirectory(root);
  const logPath = stateArtifactPath(root, FINDINGS_LOG_NAME);
  const existing = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
  if (existing.split("\n").some((line) => line.includes(`"sidecarHash":"${hash}"`))) {
    return { status: "duplicate", hash, appended: 0 };
  }
  const kept = result.data.findings.filter((f) => f.score >= FINDING_SCORE_THRESHOLD);
  const at = new Date().toISOString();
  const lines = kept.map((f) =>
    JSON.stringify({
      sidecarHash: hash,
      feature: result.data.feature,
      verdict: result.data.verdict,
      at,
      ...f,
    }),
  );
  if (lines.length > 0) {
    const prefix = existing === "" || existing.endsWith("\n") ? "" : "\n";
    appendFileSync(logPath, `${prefix}${lines.join("\n")}\n`);
  }
  return { status: "appended", hash, appended: lines.length };
}
