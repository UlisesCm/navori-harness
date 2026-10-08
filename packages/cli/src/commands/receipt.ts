import { defineCommand } from "citty";
import {
  checkReceipt,
  emitReceiptOutcome,
  formatReceipt,
  signReceipt,
  type ReceiptOptions,
} from "../lib/diagnose/receipt.ts";
import { readConfig } from "../lib/config/config.ts";
import { resolve } from "node:path";
import { hasAuditTarget } from "../lib/audit/cli-event.ts";
import { contentIdentity } from "../lib/primitives/content-identity.ts";
import { resolveStateRoot } from "../lib/primitives/state-root.ts";
import { decideGateFromDisk } from "../lib/spec/gate.ts";
import type { GateDecision } from "../lib/spec/classify.ts";
import {
  decideWorkplanGateFromDisk,
  type WorkplanGateDecision,
} from "../lib/plan/gate-decision.ts";
import { beginReview, sealReview } from "../lib/handoff/review-evidence.ts";

export function resolveReceiptOptions(args: {
  feature: string;
  target?: string;
  dir?: string;
  cwd?: string;
  includeConsumed?: boolean;
}): ReceiptOptions {
  const root = resolveStateRoot({
    cwd: args.cwd ?? process.cwd(),
    feature: args.feature,
    dir: args.dir,
  });
  const cwd = root.cwd;
  const config = readConfig(resolve(cwd, "navori.config.json"));
  return {
    cwd,
    feature: args.feature,
    target: args.target ?? config.prTarget ?? config.branchBase,
    dir: root.dir,
    gate: config.qualityGate?.full ?? "",
    includeConsumed: args.includeConsumed,
  };
}
/** Scoped-sign flags: a spec milestone, or a workplan phase (spec 0045 D7). */
type SignScope =
  | { spec: string; milestone: string; gateRan: "scoped" | "full" }
  | { spec?: undefined; phase?: string; gateRan: "scoped" | "full" };

/**
 * Validates the scoped `sign` flags: `--spec --milestone --gate-ran` (spec),
 * or `--gate-ran [--phase]` without `--spec` (workplan). Returns `undefined`
 * when none was given (sign behaves as before), `"invalid"` after reporting an
 * error (exit 1).
 */
function signSpecFlags(
  action: "sign" | "check",
  args: { spec?: string; milestone?: string; gateRan?: string; phase?: string },
): SignScope | "invalid" | undefined {
  if (!args.spec && !args.milestone && !args.gateRan && !args.phase) return undefined;
  const problem =
    action !== "sign"
      ? "--spec, --milestone, --phase and --gate-ran apply to `receipt sign` only"
      : !args.gateRan || (args.spec && !args.milestone) || (!args.spec && args.milestone)
        ? "--gate-ran is required, and --spec and --milestone must be given together"
        : args.spec && args.phase
          ? "--phase applies to workplans, not to --spec"
          : args.gateRan !== "scoped" && args.gateRan !== "full"
            ? `--gate-ran must be "scoped" or "full", got "${args.gateRan}"`
            : undefined;
  if (problem || !args.gateRan) {
    process.stderr.write(
      `ERROR: ${problem}\nWHY:   the gate kind is recomputed from the spec and milestone (or the workplan), so all the flags of one form are needed\nFIX:   pass --spec <spec> --milestone M<n> --gate-ran <scoped|full>, or --gate-ran <scoped|full> [--phase <p>], or none of them\n`,
    );
    process.exitCode = 1;
    return "invalid";
  }
  const gateRan = args.gateRan as "scoped" | "full";
  return args.spec && args.milestone
    ? { spec: args.spec, milestone: args.milestone, gateRan }
    : { phase: args.phase, gateRan };
}

/** `receipt gate`: read-only `decideGate` for a milestone (spec 0044 D5). */
export function executeGate(args: {
  feature: string;
  spec?: string;
  milestone?: string;
  phase?: string;
  dir?: string;
  cwd?: string;
  json?: boolean;
}): void {
  let decision: GateDecision | WorkplanGateDecision;
  try {
    const root = resolveStateRoot({
      cwd: args.cwd ?? process.cwd(),
      feature: args.feature,
      dir: args.dir,
    });
    decision =
      args.spec && args.milestone
        ? decideGateFromDisk(root.cwd, args.spec, args.milestone)
        : decideWorkplanGateFromDisk(root, args.feature, args.phase);
  } catch {
    decision = { gateKind: "full", reason: "tasks-unreadable", unit: null, closingMilestone: null };
  }
  process.stdout.write(
    `${args.json ? JSON.stringify(decision) : `${decision.gateKind} (${decision.reason})`}\n`,
  );
}

/** Runs `receipt sign|check`: prints the result, sets the exit code, then records the audit outcome. */
export function executeReceipt(
  action: "sign" | "check",
  args: {
    feature: string;
    target?: string;
    dir?: string;
    cwd?: string;
    json?: boolean;
    includeConsumed?: boolean;
    spec?: string;
    milestone?: string;
    gateRan?: string;
    phase?: string;
  },
): void {
  const spec = signSpecFlags(action, args);
  if (spec === "invalid") return;
  const resolved = resolveReceiptOptions(args);
  // Without an exact audit context there is no observer: zero identity compute, zero write.
  const withSpec: ReceiptOptions = spec
    ? {
        ...resolved,
        gateRan: spec.gateRan,
        gateDecision:
          spec.spec === undefined
            ? decideWorkplanGateFromDisk(
                resolveStateRoot({ cwd: resolved.cwd, feature: args.feature, dir: args.dir }),
                args.feature,
                spec.phase,
              )
            : decideGateFromDisk(resolved.cwd, spec.spec, spec.milestone),
      }
    : resolved;
  const options: ReceiptOptions = hasAuditTarget(withSpec.cwd)
    ? {
        ...withSpec,
        observer: { sample: () => contentIdentity(withSpec.cwd, { target: withSpec.target }) },
      }
    : withSpec;
  const receipt = action === "sign" ? signReceipt(options) : checkReceipt(options);
  process.stdout.write(
    `${args.json ? JSON.stringify(receipt.result) : formatReceipt(receipt.result)}\n`,
  );
  if (receipt.exitCode !== 0) process.exitCode = receipt.exitCode;
  if (options.observer) emitReceiptOutcome(options, action, receipt.result);
}

/** `review begin|seal`: producer evidence for `review_<feature>.json` (spec 0042 D5). */
function executeReview(
  action: "begin" | "seal",
  args: {
    feature: string;
    nonce?: string;
    target?: string;
    dir?: string;
    cwd?: string;
    json?: boolean;
  },
): void {
  let result;
  try {
    const { cwd, feature, dir, target, gate } = resolveReceiptOptions(args);
    const options = { cwd, feature, dir, target, gate };
    result =
      action === "begin"
        ? beginReview(options)
        : sealReview({ ...options, nonce: args.nonce ?? "" });
  } catch (error) {
    result = {
      status: "error" as const,
      message: `ERROR: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const text =
    result.status === "error"
      ? result.message
      : result.status === "begun"
        ? `OK: begin nonce=${result.nonce}`
        : result.status === "validated"
          ? `OK: sealed (${result.status})`
          : "CHANGED-DURING-REVIEW: the content changed after begin; restart the review from begin and do not report this verdict as the final diff's";
  process.stdout.write(`${args.json ? JSON.stringify(result) : text}\n`);
  if (result.status === "error") process.exitCode = 1;
  else if (result.status === "changed-during-review") process.exitCode = 2;
}
const reviewArgs = {
  feature: { type: "positional" as const, required: true, description: "Feature slug" },
  target: { type: "string" as const },
  dir: { type: "string" as const },
  cwd: { type: "string" as const },
  json: { type: "boolean" as const },
};
const shared = {
  feature: { type: "string" as const, required: true },
  target: { type: "string" as const },
  dir: { type: "string" as const },
  cwd: { type: "string" as const },
  json: { type: "boolean" as const },
};
export const receiptCommand = defineCommand({
  meta: { name: "receipt", description: "Sign or check the reviewed content receipt" },
  subCommands: {
    sign: defineCommand({
      meta: { name: "sign", description: "Write a receipt for the current publish set" },
      args: {
        ...shared,
        spec: { type: "string" as const, description: "Spec directory (with --milestone)" },
        milestone: { type: "string" as const, description: "Milestone id, e.g. M3" },
        phase: { type: "string" as const, description: "Workplan phase (name or 1-based index)" },
        "gate-ran": {
          type: "string" as const,
          description: "Gate the cycle ran: scoped or full",
        },
      },
      run: ({ args }) => executeReceipt("sign", { ...args, gateRan: args["gate-ran"] }),
    }),
    gate: defineCommand({
      meta: {
        name: "gate",
        description:
          "Decide whether a milestone's or workplan phase's review cycle needs the scoped or the full gate",
      },
      args: {
        ...shared,
        spec: { type: "string" as const, description: "Spec directory (with --milestone)" },
        milestone: { type: "string" as const, description: "Milestone id" },
        phase: { type: "string" as const, description: "Workplan phase (name or 1-based index)" },
      },
      run: ({ args }) => executeGate(args),
    }),
    review: defineCommand({
      meta: {
        name: "review",
        description:
          "Producer evidence for review_<feature>.json: begin before the diff, seal after",
      },
      subCommands: {
        begin: defineCommand({
          meta: { name: "begin", description: "Stamp the content identity; prints the nonce" },
          args: reviewArgs,
          run: ({ args }) => executeReview("begin", args),
        }),
        seal: defineCommand({
          meta: { name: "seal", description: "Seal the written sidecar with its evidence" },
          args: {
            ...reviewArgs,
            nonce: {
              type: "string" as const,
              required: true,
              description: "Nonce printed by begin",
            },
          },
          run: ({ args }) => executeReview("seal", args),
        }),
      },
    }),
    check: defineCommand({
      meta: { name: "check", description: "Check the current publish set against a receipt" },
      args: {
        ...shared,
        "include-consumed": {
          type: "boolean" as const,
          description: "Fall back to receipt.consumed.txt when receipt.txt is absent",
        },
      },
      run: ({ args }) =>
        executeReceipt("check", { ...args, includeConsumed: args["include-consumed"] }),
    }),
  },
});
