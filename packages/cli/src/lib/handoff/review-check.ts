/**
 * `navori handoff check <feature> --produced-by reviewer` (spec 0048 D7, R7):
 * validates what a reviewer child left behind — a non-empty
 * `review_<feature>.md` carrying a verdict, a valid `review_<feature>.json`
 * sidecar for the feature, sealed producer evidence (`checkSealedEvidence`)
 * and, with `since`, a `beginReview` stamp taken at or after that instant so
 * an `APPROVED` from an earlier round cannot pass. Same result shape and exit
 * codes as `checkHandoff`; never throws.
 */
import { existsSync, readFileSync } from "node:fs";
import { FEATURE_SLUG, resolveStateRoot, stateArtifactPath } from "../primitives/state-root.ts";
import type { HandoffCheckResult } from "./check.ts";
import { checkSealedEvidence } from "./review-evidence.ts";
import { ReviewSidecarSchema } from "./review-schema.ts";

export interface ReviewHandoffOptions {
  cwd: string;
  dir: string;
  feature: string;
  /** ISO UTC instant (the dispatch time); the review must have begun at or after it. */
  since?: string;
}

const VERDICT = /\b(?:APPROVED|CHANGES_REQUESTED)\b/;

/** Validates the reviewer's canonical handoff; see the module header. */
export function checkReviewHandoff(options: ReviewHandoffOptions): HandoffCheckResult {
  const result: HandoffCheckResult = {
    formatVersion: 1,
    feature: options.feature,
    consumer: "reviewer",
    status: "ok",
    failures: [],
    warnings: [],
    worktree: null,
    branch: null,
  };
  const finish = (): HandoffCheckResult => {
    result.status = result.failures.length === 0 ? "ok" : "findings";
    return result;
  };
  try {
    if (!FEATURE_SLUG.test(options.feature)) {
      result.failures.push({
        check: "feature",
        detail: `"${options.feature}" is not a valid feature slug`,
      });
      return finish();
    }
    const since = options.since === undefined ? undefined : Date.parse(options.since);
    if (since !== undefined && Number.isNaN(since)) {
      result.failures.push({ check: "fresh", detail: `--since "${options.since}" is not a date` });
      return finish();
    }
    const root = resolveStateRoot({ cwd: options.cwd, feature: options.feature, dir: options.dir });
    const mdPath = stateArtifactPath(root, `review_${options.feature}.md`);
    if (!existsSync(mdPath)) {
      result.failures.push({ check: "exists", detail: `${mdPath} not found` });
    } else if (!VERDICT.test(readFileSync(mdPath, "utf8"))) {
      result.failures.push({
        check: "verdict",
        detail: `${mdPath} is empty or has no APPROVED|CHANGES_REQUESTED verdict`,
      });
    }
    const jsonPath = stateArtifactPath(root, `review_${options.feature}.json`);
    if (!existsSync(jsonPath)) {
      result.failures.push({ check: "exists", detail: `${jsonPath} not found` });
      return finish();
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(jsonPath, "utf8"));
    } catch {
      result.failures.push({ check: "parse", detail: `${jsonPath} does not parse as JSON` });
      return finish();
    }
    const parsed = ReviewSidecarSchema.safeParse(raw);
    if (!parsed.success) {
      result.failures.push({
        check: "parse",
        detail: parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; "),
      });
      return finish();
    }
    if (parsed.data.feature !== options.feature) {
      result.failures.push({
        check: "feature",
        detail: `${jsonPath} belongs to feature "${parsed.data.feature}", not "${options.feature}"`,
      });
    }
    const sealed = checkSealedEvidence(root, parsed.data);
    if (sealed.status !== "sealed") {
      result.failures.push({
        check: "evidence",
        detail: `${jsonPath} has no sealed producer evidence (${sealed.status})`,
      });
    } else if (since !== undefined && Date.parse(sealed.evidence.startedAt) < since) {
      result.failures.push({
        check: "fresh",
        detail: `the review began at ${sealed.evidence.startedAt}, before this dispatch (${options.since}); it is a stale round`,
      });
    }
    return finish();
  } catch (cause: unknown) {
    result.status = "error";
    result.failures.push({
      check: "exists",
      detail: cause instanceof Error ? cause.message : "review handoff check failed",
    });
    return result;
  }
}
