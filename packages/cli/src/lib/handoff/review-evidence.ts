/**
 * Producer evidence for `review_<feature>.json` (spec 0042 D5/R16): `begin`
 * captures a `navori-content/v1` identity in a nonce-keyed stamp, `seal`
 * checks the content did not change during the review and embeds the evidence
 * in the sidecar, and `log-review` verifies it and emits ONE metadata-only
 * `review-outcome` audit event.
 *
 * What it attests, and what it does not. It detects: omitted evidence, a hash
 * written by hand (no stamp for the nonce), a verdict/findings edit after the
 * seal, content changing during the review (begin != seal) or between the seal
 * and `log-review`. It does NOT detect an agent with a shell that forges stamp,
 * evidence and seal (plain sha256, same user), nor whether the reviewer read the
 * diff before `begin`: the stamp proves "the content was X at `startedAt`", not
 * read order. Missing or unverifiable evidence is `uncorrelated`, never an
 * approval.
 *
 * Contracts (all v1): stamp `review_<feature>.<nonce>.begin.json`, evidence
 * `ReviewEvidenceSchema`, `seal = sha256(canonical({feature, verdict, findings})
 * + "\0" + canonical(evidence without seal))`. An unconfigured gate (`""`) emits
 * no `gate` field, so it can never be correlated as a passing gate (D5).
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { appendCliEvent, hasAuditTarget, outcomeFeatureKey } from "../audit/cli-event.ts";
import type { ReviewCorrelation, ReviewOutcome, ReviewOutcomeVerdict } from "../audit/model.ts";
import { evidenceIdentity } from "../diagnose/receipt.ts";
import { CONTENT_ALG, contentIdentity } from "../primitives/content-identity.ts";
import { isUnderProgressDir } from "../primitives/progress-dirs.ts";
import {
  resolveStateRoot,
  stateArtifactPath,
  writeStateFileAtomic,
  type StateRoot,
} from "../primitives/state-root.ts";
import {
  FINDING_SCORE_THRESHOLD,
  ReviewSidecarSchema,
  type ReviewSidecar,
} from "./review-schema.ts";

const hex64 = z.string().regex(/^[a-f0-9]{64}$/);
const gitSha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const isoUtc = z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const nonceSchema = z.string().regex(UUID);

const IdentityShape = {
  fingerprint: hex64,
  base: gitSha.nullable(),
  head: gitSha,
  gate: hex64.optional(),
  inputs: hex64,
  startedAt: isoUtc,
};

/** The CLI-owned begin stamp. */
const ReviewStampSchema = z.strictObject({
  v: z.literal(1),
  alg: z.literal(CONTENT_ALG),
  nonce: nonceSchema,
  feature: z.string().min(1),
  ...IdentityShape,
});
type ReviewStamp = z.infer<typeof ReviewStampSchema>;

/** Evidence embedded in `review_<feature>.json` by `seal`. */
export const ReviewEvidenceSchema = z.strictObject({
  v: z.literal(1),
  alg: z.literal(CONTENT_ALG),
  state: z.enum(["validated", "changed-during-review"]),
  nonce: nonceSchema,
  sealedFingerprint: hex64.optional(),
  sealedAt: isoUtc,
  seal: hex64,
  ...IdentityShape,
});
export type ReviewEvidence = z.infer<typeof ReviewEvidenceSchema>;

/** Resolved inputs shared by begin, seal and log-review (see `resolveReceiptOptions`). */
export interface EvidenceOptions {
  cwd: string;
  feature: string;
  dir?: string;
  target: string;
  /** `qualityGate.full`; `""` means no gate configured. */
  gate: string;
}

export type BeginResult =
  | { status: "begun"; nonce: string; indexDiverges: boolean }
  | { status: "error"; message: string };
export type SealResult =
  | { status: "validated" | "changed-during-review"; nonce: string }
  | { status: "error"; message: string };

function fail(error: string, why: string, fix: string): { status: "error"; message: string } {
  return { status: "error", message: `ERROR: ${error}\nWHY: ${why}\nFIX: ${fix}` };
}

const sha256 = (input: string): string => createHash("sha256").update(input).digest("hex");

/** Deterministic JSON: sorted keys, `undefined` dropped. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sealDigest(sidecar: ReviewSidecar, evidence: Omit<ReviewEvidence, "seal">): string {
  const body = { feature: sidecar.feature, verdict: sidecar.verdict, findings: sidecar.findings };
  return sha256(`${canonical(body)}\0${canonical(evidence)}`);
}

const stampName = (feature: string, nonce: string): string =>
  `review_${feature}.${nonce}.begin.json`;

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function readStamp(root: StateRoot, feature: string, nonce: string): ReviewStamp | null {
  const path = stateArtifactPath(root, stampName(feature, nonce));
  if (!existsSync(path)) return null;
  const parsed = ReviewStampSchema.safeParse(readJson(path));
  return parsed.success && parsed.data.nonce === nonce && parsed.data.feature === feature
    ? parsed.data
    : null;
}

type Identity = Pick<ReviewStamp, "fingerprint" | "base" | "head" | "gate" | "inputs"> & {
  indexDiverges: boolean;
};

/** Current content + gate/inputs identity; `undefined` when it cannot be computed completely. */
function currentIdentity(root: StateRoot, options: EvidenceOptions): Identity | undefined {
  try {
    const content = contentIdentity(root.cwd, { target: options.target });
    if (!content.ok) return undefined;
    const evidence = evidenceIdentity(root.cwd, options.gate);
    return {
      fingerprint: content.fingerprint,
      base: content.base,
      head: content.head,
      ...(options.gate === "" ? {} : { gate: evidence.gate }),
      inputs: evidence.inputs,
      indexDiverges: content.indexDiverges,
    };
  } catch {
    return undefined;
  }
}

type IdentityFields = Pick<ReviewStamp, "fingerprint" | "base" | "gate" | "inputs">;
const sameIdentity = (a: IdentityFields, b: IdentityFields): boolean =>
  a.fingerprint === b.fingerprint &&
  a.base === b.base &&
  a.gate === b.gate &&
  a.inputs === b.inputs;

/** `begin`: stamps the identity of the content BEFORE the reviewer examines the diff. */
export function beginReview(options: EvidenceOptions): BeginResult {
  try {
    const root = resolveStateRoot(options);
    if (!isUnderProgressDir(`${root.dir}/`)) {
      return fail(
        `unsupported-state-dir: ${root.dir}`,
        "a stamp outside the excluded state directories would change the identity it records",
        "omit --dir or point it under .navori/state/",
      );
    }
    const startedAt = new Date().toISOString();
    const identity = currentIdentity(root, options);
    if (identity === undefined) {
      return fail(
        "the content identity could not be computed",
        "git failed, the tree is merging, or it exceeds the size/time budget",
        "continue the review without evidence; it will stay uncorrelated",
      );
    }
    const nonce = randomUUID();
    const stamp: ReviewStamp = {
      v: 1,
      alg: CONTENT_ALG,
      nonce,
      feature: options.feature,
      fingerprint: identity.fingerprint,
      base: identity.base,
      head: identity.head,
      ...(identity.gate === undefined ? {} : { gate: identity.gate }),
      inputs: identity.inputs,
      startedAt,
    };
    // TODO(hygiene): stamps accumulate one per begin; prune when a state dir passes ~100 stamps.
    writeStateFileAtomic(root, stampName(options.feature, nonce), `${JSON.stringify(stamp)}\n`);
    return { status: "begun", nonce, indexDiverges: identity.indexDiverges };
  } catch (error) {
    return fail(
      error instanceof Error ? error.message : String(error),
      "the feature slug or state directory is not a safe path inside this checkout",
      "use a lowercase feature slug and a --dir inside the checkout",
    );
  }
}

/**
 * `seal`: embeds the evidence in the sidecar. Refuses (writing nothing) a
 * missing stamp, an invalid or foreign sidecar, a sidecar that already carries
 * evidence, and one older than its stamp (a stale APPROVED from a prior round).
 * A change since `begin` is sealed as `changed-during-review` (exit 2), never
 * relabeled with the final fingerprint.
 */
export function sealReview(options: EvidenceOptions & { nonce: string }): SealResult {
  try {
    if (!UUID.test(options.nonce)) {
      return fail("--nonce is not a valid nonce", "begin prints the nonce to pass", "re-run begin");
    }
    const root = resolveStateRoot(options);
    const stamp = readStamp(root, options.feature, options.nonce);
    if (stamp === null) {
      return fail(
        `no begin stamp for nonce ${options.nonce}`,
        "the evidence must be produced by this CLI before the review",
        "run `navori receipt review begin <feature>` and pass its nonce",
      );
    }
    const sidecarPath = stateArtifactPath(root, `review_${options.feature}.json`);
    const raw = existsSync(sidecarPath) ? readJson(sidecarPath) : undefined;
    const parsed = ReviewSidecarSchema.safeParse(raw);
    if (!parsed.success || parsed.data.feature !== options.feature) {
      return fail(
        `review_${options.feature}.json is missing, invalid or for another feature`,
        "only a valid sidecar of this feature can be sealed",
        "write the sidecar, then seal",
      );
    }
    if (parsed.data.evidence !== undefined) {
      return fail(
        "the sidecar already carries evidence",
        "sealing a sealed sidecar could relabel an earlier verdict as this round's",
        "rewrite the sidecar for this round (without evidence) and seal again",
      );
    }
    const stampPath = stateArtifactPath(root, stampName(options.feature, options.nonce));
    // Strict `<`: an mtime tie is accepted on purpose, so coarse-mtime filesystems do not flake.
    if (statSync(sidecarPath).mtimeMs < statSync(stampPath).mtimeMs) {
      return fail(
        "the sidecar is older than the begin stamp",
        "it was not written in this round",
        "rewrite review_<feature>.json after begin, then seal",
      );
    }
    const current = currentIdentity(root, options);
    if (current === undefined) {
      return fail(
        "the content identity could not be computed",
        "git failed or the tree exceeds the size/time budget",
        "continue without evidence; the review stays uncorrelated",
      );
    }
    const same = sameIdentity(stamp, current);
    const body: Omit<ReviewEvidence, "seal"> = {
      v: 1,
      alg: CONTENT_ALG,
      state: same ? "validated" : "changed-during-review",
      nonce: stamp.nonce,
      fingerprint: stamp.fingerprint,
      ...(current.fingerprint === stamp.fingerprint
        ? {}
        : { sealedFingerprint: current.fingerprint }),
      base: stamp.base,
      head: stamp.head,
      ...(stamp.gate === undefined ? {} : { gate: stamp.gate }),
      inputs: stamp.inputs,
      startedAt: stamp.startedAt,
      sealedAt: new Date().toISOString(),
    };
    const evidence: ReviewEvidence = { ...body, seal: sealDigest(parsed.data, body) };
    const document = { ...(raw as Record<string, unknown>), evidence };
    writeStateFileAtomic(
      root,
      `review_${options.feature}.json`,
      `${JSON.stringify(document, null, 2)}\n`,
    );
    return { status: body.state, nonce: stamp.nonce };
  } catch (error) {
    return fail(
      error instanceof Error ? error.message : String(error),
      "the feature slug or state directory is not a safe path inside this checkout",
      "use a lowercase feature slug and a --dir inside the checkout",
    );
  }
}

export type SealedCheck =
  | { status: "missing" | "invalid" | "unknown-algorithm" }
  | { status: "sealed" | "changed-during-review"; evidence: ReviewEvidence };

/**
 * Verifies the sidecar's evidence WITHOUT recomputing the content identity:
 * shape, algorithm, the nonce's stamp and the seal over verdict + findings.
 * Never creates or repairs anything.
 */
export function checkSealedEvidence(root: StateRoot, sidecar: ReviewSidecar): SealedCheck {
  const raw = sidecar.evidence;
  if (raw === undefined) return { status: "missing" };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { status: "invalid" };
  const declared = raw as Record<string, unknown>;
  if (
    typeof declared.v === "number" &&
    typeof declared.alg === "string" &&
    (declared.v !== 1 || declared.alg !== CONTENT_ALG)
  )
    return { status: "unknown-algorithm" };
  const parsed = ReviewEvidenceSchema.safeParse(raw);
  if (!parsed.success) return { status: "invalid" };
  const evidence = parsed.data;
  const stamp = readStamp(root, sidecar.feature, evidence.nonce);
  if (
    stamp === null ||
    !sameIdentity(stamp, evidence) ||
    stamp.head !== evidence.head ||
    stamp.startedAt !== evidence.startedAt
  )
    return { status: "invalid" };
  const { seal, ...body } = evidence;
  if (sealDigest(sidecar, body) !== seal) return { status: "invalid" };
  return { status: evidence.state === "validated" ? "sealed" : "changed-during-review", evidence };
}

export interface ReviewCorrelationResult {
  correlation: ReviewCorrelation;
  evidence?: ReviewEvidence;
}

/** Full correlation: `checkSealedEvidence` plus the current identity (needs `options`). */
export function correlateReview(
  root: StateRoot,
  sidecar: ReviewSidecar,
  options: EvidenceOptions | undefined,
): ReviewCorrelationResult {
  const checked = checkSealedEvidence(root, sidecar);
  if (!("evidence" in checked)) return { correlation: checked.status };
  if (checked.status === "changed-during-review") {
    return { correlation: "changed-during-review", evidence: checked.evidence };
  }
  const current = options === undefined ? undefined : currentIdentity(root, options);
  if (current === undefined) return { correlation: "unavailable", evidence: checked.evidence };
  return sameIdentity(current, checked.evidence)
    ? { correlation: "correlated", evidence: checked.evidence }
    : { correlation: "changed-after-review", evidence: checked.evidence };
}

/** Publisher-side nudge (`handoff check --for publisher`): why this review is not sealed, or `null`. */
export function reviewEvidenceWarning(root: StateRoot, feature: string): string | null {
  const path = stateArtifactPath(root, `review_${feature}.json`);
  if (!existsSync(path)) return `review_${feature}.json not found; the review is uncorrelated`;
  const parsed = ReviewSidecarSchema.safeParse(readJson(path));
  if (!parsed.success) return `review_${feature}.json is not a valid sidecar`;
  const checked = checkSealedEvidence(root, parsed.data);
  return checked.status === "sealed"
    ? null
    : `review_${feature}.json has no valid evidence (${checked.status}); the review is uncorrelated`;
}

function outcomeVerdict(verdict: string): ReviewOutcomeVerdict {
  const normalized = verdict
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  return normalized === "approved" || normalized === "changes-requested" ? normalized : "unknown";
}

/**
 * Emits ONE `review-outcome` event for a logged sidecar (even with zero
 * findings). Without an exact audit context nothing is computed or written.
 * `getContext` is lazy so a session without audit pays no config read. The
 * feature is stored only as `sha256(repo + "\0" + feature)`. Callers must
 * treat any throw as non-fatal: observation never changes a command's result.
 */
export function emitReviewOutcome(
  getContext: () => EvidenceOptions,
  info: { root: StateRoot; sidecar: ReviewSidecar; hash: string },
): void {
  const { root, sidecar } = info;
  if (!hasAuditTarget(root.cwd)) return;
  let options: EvidenceOptions | undefined;
  try {
    options = getContext();
  } catch {
    options = undefined;
  }
  const { correlation, evidence } = correlateReview(root, sidecar, options);
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const finding of sidecar.findings) {
    if (finding.score >= FINDING_SCORE_THRESHOLD) counts[finding.severity] += 1;
  }
  const correlated = correlation === "correlated" && evidence !== undefined;
  const payload: Omit<ReviewOutcome, "name" | "verdict"> = {
    schemaVersion: 1,
    featureKey: outcomeFeatureKey(root.cwd, sidecar.feature),
    sidecar: info.hash,
    ...counts,
    correlation,
    ...(evidence === undefined
      ? {}
      : {
          nonce: evidence.nonce,
          startedAtMs: Date.parse(evidence.startedAt),
          sealedAtMs: Date.parse(evidence.sealedAt),
        }),
    ...(correlated
      ? {
          alg: evidence.alg,
          fp: evidence.fingerprint,
          ...(evidence.base === null ? {} : { base: evidence.base }),
          head: evidence.head,
          ...(evidence.gate === undefined ? {} : { gate: evidence.gate }),
          inputs: evidence.inputs,
        }
      : {}),
  };
  appendCliEvent(
    root.cwd,
    { name: "review-outcome", verdict: outcomeVerdict(sidecar.verdict) },
    payload,
  );
}
