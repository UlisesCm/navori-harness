import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";
import { z } from "zod";
import { fingerprintTree } from "../plan/evidence.ts";
import {
  resolveStateRoot,
  stateArtifactPath,
  writeStateFileAtomic,
} from "../primitives/state-root.ts";
import {
  observeNativeProfiles,
  isOwnedNativeObservation,
  type NativeProfileObservation,
} from "./native-integration.ts";

/** Fixed comparative scenarios, independent of any caller prompt or command. */
export const EVALUATION_FIXTURES = [
  "bug-regression",
  "two-module-feature-and-review",
  "resume-after-state-change",
  "subagent-approval-route",
] as const;
const fixtures = z.enum(EVALUATION_FIXTURES);
const engine = z.enum(["claude", "codex"]);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const treeHash = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const controls: Readonly<Record<z.infer<typeof fixtures>, readonly string[]>> = {
  "bug-regression": ["regression-before-failed", "regression-after-passed", "fix-observed"],
  "two-module-feature-and-review": ["two-modules-changed", "independent-review-current"],
  "resume-after-state-change": ["evidence-changed", "old-state-rejected", "new-state-reverified"],
  "subagent-approval-route": [
    "native-child-origin",
    "parent-route",
    "human-exact-one-use-grant",
    "native-effect-completed",
  ],
};
const recordSchema = z.strictObject({
  id: z.uuid(),
  fixture: fixtures,
  engine,
  fixtureIdentity: hash,
  checkout: z.string().min(1),
  before: treeHash,
  after: treeHash,
  hostVersion: z.string().nullable(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  source: z.enum(["owned-native-startup", "unavailable"]),
  context: z.string().nullable(),
  inventory: hash.nullable(),
  phase: z.literal("observation-only"),
  status: z.enum(["pending", "failed"]),
  checkedAt: z.iso.datetime(),
  durationMs: z.number().nonnegative(),
  consumption: z.literal("unavailable"),
  attempts: z
    .array(
      z.strictObject({
        id: z.uuid(),
        status: z.enum(["pending", "failed"]),
        reason: z.string().min(1),
        retryOf: z.uuid().nullable(),
      }),
    )
    .min(1),
  mandatoryControls: z.array(
    z.strictObject({ id: z.string().min(1), state: z.literal("pending"), evidence: z.null() }),
  ),
  independentProducer: z.null(),
  independentReview: z.null(),
  approvalActionEffect: z.null(),
});

/** Non-authorizing diagnostics preserve failures and explicit source/consumption/control gaps. */
export type OutcomeObservation = z.infer<typeof recordSchema>;
const captured = new Map<
  string,
  { readonly digest: string; readonly observation?: NativeProfileObservation }
>();

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Capture actual bounded startup metadata only; unsupported live scenario execution stays explicit. */
export async function captureOutcomeObservation(
  cwd: string,
  fixture: string,
  selectedEngine: string,
): Promise<OutcomeObservation> {
  const input = z
    .strictObject({ fixture: fixtures, engine })
    .parse({ fixture, engine: selectedEngine });
  const root = resolveStateRoot({ cwd, feature: "codex-evaluation" });
  const before = fingerprintTree(root.cwd, undefined, { readOnly: true });
  if (!before.ok) throw new Error(before.reason);
  const started = performance.now();
  let observation: NativeProfileObservation | undefined;
  let hostVersion: string | null = null;
  let reason = "fixed-live-scenario-source-unavailable; observation is not task execution";
  try {
    if (input.engine === "codex") {
      observation = await observeNativeProfiles(root.cwd);
      if (!isOwnedNativeObservation(observation))
        throw new Error("native-observation-source-unverified");
      hostVersion = observation.catalog.version;
      reason =
        "startup-selection-only; all-role dispatch, controls and independent live outcome pending";
    } else {
      const result = spawnSync("claude", ["--version"], {
        cwd: root.cwd,
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 2048,
      });
      if (result.status === 0 && !result.error)
        hostVersion = /(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/.exec(result.stdout)?.[1] ?? null;
    }
  } catch {
    reason = "native-observation-unavailable; no substitution or scenario success inferred";
  }
  const after = fingerprintTree(root.cwd, undefined, { readOnly: true });
  if (!after.ok) throw new Error(after.reason);
  const record: OutcomeObservation = recordSchema.parse({
    id: randomUUID(),
    ...input,
    fixtureIdentity: digest({
      fixture: input.fixture,
      controls: controls[input.fixture],
      version: 1,
    }),
    checkout: root.cwd,
    before: before.tree,
    after: after.tree,
    hostVersion,
    model: observation?.principal.selectedModel ?? null,
    effort: observation?.principal.selectedEffort ?? null,
    source: observation ? "owned-native-startup" : "unavailable",
    context: observation?.context ?? null,
    inventory: observation?.inventory ?? null,
    phase: "observation-only",
    status: before.tree === after.tree ? "pending" : "failed",
    checkedAt: new Date().toISOString(),
    durationMs: performance.now() - started,
    consumption: "unavailable",
    attempts: [
      {
        id: randomUUID(),
        status: before.tree === after.tree ? "pending" : "failed",
        reason: before.tree === after.tree ? reason : "inputs-changed-during-observation",
        retryOf: null,
      },
    ],
    mandatoryControls: controls[input.fixture].map((id) => ({
      id,
      state: "pending",
      evidence: null,
    })),
    independentProducer: null,
    independentReview: null,
    approvalActionEffect: null,
  });
  Object.freeze(record);
  captured.set(record.id, { digest: digest(record), observation });
  writeStateFileAtomic(root, `outcome-${record.id}.json`, JSON.stringify(record));
  return record;
}

/** Fail closed on exact eight combinations and current native/control evidence; imports never authenticate source. */
export function validateOutcomeObservations(
  cwd: string,
  input: unknown,
): { ok: false; reasons: string[] } {
  const parsed = z.array(recordSchema).safeParse(input);
  if (!parsed.success)
    return { ok: false, reasons: ["malformed or caller-asserted outcome/source/control evidence"] };
  const root = resolveStateRoot({ cwd, feature: "codex-evaluation" });
  const current = fingerprintTree(root.cwd, undefined, { readOnly: true });
  const reasons: string[] = [];
  const keys = parsed.data.map((row) => `${row.engine}:${row.fixture}`);
  if (
    keys.length !== 8 ||
    new Set(keys).size !== 8 ||
    EVALUATION_FIXTURES.some((fixture) =>
      ["claude", "codex"].some((item) => !keys.includes(`${item}:${fixture}`)),
    )
  )
    reasons.push("eight exact fixed Claude/Codex scenario combinations required");
  for (const record of parsed.data) {
    const source = captured.get(record.id);
    if (
      !source ||
      source.digest !== digest(record) ||
      !source.observation ||
      !isOwnedNativeObservation(source.observation)
    )
      reasons.push(`${record.id}: current owned native source unavailable; saved JSON is metadata`);
    if (!current.ok || current.tree !== record.after || record.checkout !== root.cwd)
      reasons.push(`${record.id}: current inputs do not match`);
    if (
      record.fixtureIdentity !==
      digest({ fixture: record.fixture, controls: controls[record.fixture], version: 1 })
    )
      reasons.push(`${record.id}: fixed fixture identity mismatch`);
    if (
      !record.hostVersion ||
      !record.model ||
      !record.effort ||
      !record.context ||
      source?.observation?.pending.length
    )
      reasons.push(`${record.id}: required host/profile/inventory observation missing`);
    reasons.push(
      `${record.id}: live scenario execution, mandatory controls, independent producer/review and approval source-action-effect pending`,
    );
  }
  return { ok: false, reasons };
}

/** Read only checkout-contained evaluation metadata and revalidate current authority rather than blessing JSON. */
export function validateOutcomeFile(
  cwd: string,
  records: string,
): { ok: false; reasons: string[] } {
  try {
    if (isAbsolute(records)) throw new Error("records must be project-relative");
    const root = resolveStateRoot({ cwd, feature: "codex-evaluation", dir: dirname(records) });
    return validateOutcomeObservations(
      root.cwd,
      JSON.parse(readFileSync(stateArtifactPath(root, basename(records)), "utf8")) as unknown,
    );
  } catch {
    return {
      ok: false,
      reasons: ["current native-auth evaluation records unavailable or redirected"],
    };
  }
}
