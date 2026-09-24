/**
 * `navori handoff check <feature> [--for scribe] [--dir] [--cwd] [--json]`
 * (spec 0033 D3, R14-R17, R24) — the CLI entry point `checkHandoff` runs
 * behind. `--for scribe` runs the deeper identity check (R16); without it,
 * the orchestrator's shallower one (R14, R15) applies.
 */
import { defineCommand } from "citty";
import { resolve } from "node:path";
import { checkHandoff, handoffExitCode, type HandoffConsumer } from "../lib/handoff/check.ts";
import { readConfig } from "../lib/config/config.ts";

function resolveConsumer(value: string | undefined): HandoffConsumer {
  return value === "scribe" ? "scribe" : "orchestrator";
}

const checkSubCommand = defineCommand({
  meta: {
    name: "check",
    description:
      "Validate impl_<feature>.json (or .md under scribeOwnsMarkdown:false) before dispatch",
  },
  args: {
    feature: { type: "positional" as const, required: true, description: "Feature slug" },
    for: {
      type: "string" as const,
      description: "Consumer running the check: orchestrator (default) or scribe",
    },
    dir: {
      type: "string" as const,
      description: "Progress directory",
      default: ".claude/progress",
    },
    cwd: {
      type: "string" as const,
      description: "Checkout to validate (scribe: the one it will edit)",
    },
    json: { type: "boolean" as const, description: "Output as JSON" },
  },
  run({ args }) {
    const cwd = resolve(args.cwd ?? process.cwd());
    // `harness.scribeOwnsMarkdown` defaults to `false` (schema.ts), which is
    // the legacy `.md`-only contract (R24) — the fallback below mirrors that
    // default rather than inventing a different one for a missing/unreadable
    // config.
    let legacyMarkdown = true;
    try {
      legacyMarkdown = !(
        readConfig(resolve(cwd, "navori.config.json")).harness?.scribeOwnsMarkdown ?? false
      );
    } catch {
      legacyMarkdown = true;
    }
    const result = checkHandoff({
      cwd,
      dir: args.dir,
      feature: args.feature,
      consumer: resolveConsumer(args.for),
      legacyMarkdown,
    });
    process.stdout.write(`${args.json ? JSON.stringify(result) : formatResult(result)}\n`);
    process.exitCode = handoffExitCode(result);
  },
});

function formatResult(result: ReturnType<typeof checkHandoff>): string {
  if (result.status === "ok" && result.warnings.length === 0) return "OK";
  const lines = [
    ...result.failures.map((f) => `FAIL[${f.check}]: ${f.detail}`),
    ...result.warnings.map((w) => `WARN[${w.check}]: ${w.detail}`),
  ];
  return lines.join("\n") || "OK";
}

export const handoffCommand = defineCommand({
  meta: { name: "handoff", description: "Validate the implementer's handoff before dispatch" },
  subCommands: {
    check: checkSubCommand,
  },
});
