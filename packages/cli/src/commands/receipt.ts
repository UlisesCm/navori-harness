import { defineCommand } from "citty";
import {
  checkReceipt,
  formatReceipt,
  signReceipt,
  type ReceiptOptions,
} from "../lib/diagnose/receipt.ts";
import { readConfig } from "../lib/config/config.ts";
import { resolve } from "node:path";
import { resolveStateRoot } from "../lib/primitives/state-root.ts";
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
function execute(
  action: "sign" | "check",
  args: {
    feature: string;
    target?: string;
    dir?: string;
    cwd?: string;
    json?: boolean;
    includeConsumed?: boolean;
  },
): void {
  const receipt =
    action === "sign"
      ? signReceipt(resolveReceiptOptions(args))
      : checkReceipt(resolveReceiptOptions(args));
  process.stdout.write(
    `${args.json ? JSON.stringify(receipt.result) : formatReceipt(receipt.result)}\n`,
  );
  if (receipt.exitCode !== 0) process.exitCode = receipt.exitCode;
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
      args: shared,
      run: ({ args }) => execute("sign", args),
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
      run: ({ args }) => execute("check", { ...args, includeConsumed: args["include-consumed"] }),
    }),
  },
});
