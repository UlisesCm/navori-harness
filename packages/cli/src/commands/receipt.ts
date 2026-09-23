import { defineCommand } from "citty";
import { checkReceipt, formatReceipt, signReceipt, type ReceiptOptions } from "../lib/diagnose/receipt.ts";
import { readConfig } from "../lib/config.ts";
import { resolve } from "node:path";

export function resolveReceiptOptions(args: {
  feature: string;
  target?: string;
  dir?: string;
  cwd?: string;
}): ReceiptOptions {
  const cwd = resolve(args.cwd ?? process.cwd());
  const config = readConfig(resolve(cwd, "navori.config.json"));
  return {
    cwd,
    feature: args.feature,
    target: args.target ?? config.prTarget ?? config.branchBase,
    dir: args.dir ?? ".claude/progress",
  };
}
function execute(
  action: "sign" | "check",
  args: { feature: string; target?: string; dir?: string; cwd?: string; json?: boolean },
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
    check: defineCommand({
      meta: { name: "check", description: "Check the current publish set against a receipt" },
      args: shared,
      run: ({ args }) => execute("check", args),
    }),
  },
});
