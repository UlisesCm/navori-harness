/**
 * `navori handoff check <feature> [--for scribe] [--dir] [--cwd] [--json]`
 * (spec 0033 D3, R14-R17, R24) — the CLI entry point `checkHandoff` runs
 * behind. `--for scribe` runs the deeper identity check (R16); without it,
 * the orchestrator's shallower one (R14, R15) applies.
 */
import { defineCommand } from "citty";
import { resolve } from "node:path";
import { resolveStateRoot } from "../lib/primitives/state-root.ts";
import { checkHandoff, handoffExitCode, type HandoffConsumer } from "../lib/handoff/check.ts";
import { logReview } from "../lib/handoff/review-schema.ts";
import { readConfig } from "../lib/config/config.ts";
import { emitReviewOutcome } from "../lib/handoff/review-evidence.ts";
import { checkReviewHandoff } from "../lib/handoff/review-check.ts";
import { resolveReceiptOptions } from "./receipt.ts";
import { attestHandoff } from "../lib/handoff/actor-provenance.ts";
import { readFileSync } from "node:fs";
import {
  prepareParallel,
  beginParallel,
  completeParallel,
  finalizeParallel,
} from "../lib/handoff/parallel.ts";

function resolveConsumer(value: string | undefined): HandoffConsumer {
  return value === "scribe" || value === "publisher" ? value : "orchestrator";
}

const producerArgs = {
  feature: { type: "positional" as const, required: true, description: "Feature slug" },
  target: { type: "string" as const, description: "Review target branch" },
  dir: { type: "string" as const, description: "State directory" },
  json: { type: "boolean" as const, description: "Output JSON" },
};
const runArg = {
  run: { type: "string" as const, required: true, description: "Run ID from prior authorization" },
};

function emitProducer(
  result: { status: string; message?: string },
  json: boolean,
  ok: string,
): void {
  process.stdout.write(`${json ? JSON.stringify(result) : (result.message ?? result.status)}\n`);
  process.exitCode = result.status === ok ? 0 : 1;
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
      description: "Consumer running the check: orchestrator (default), scribe or publisher",
    },
    "produced-by": {
      type: "string" as const,
      description:
        "Validate the handoff a role produced instead of one a consumer needs: reviewer (review_<feature>.md/.json + sealed evidence)",
    },
    since: {
      type: "string" as const,
      description:
        "With --produced-by reviewer: ISO UTC time the review must have begun at or after",
    },
    target: { type: "string" as const, description: "Current review target branch" },
    dir: {
      type: "string" as const,
      description: "Progress directory",
    },
    cwd: {
      type: "string" as const,
      description: "Checkout to validate (scribe: the one it will edit)",
    },
    json: { type: "boolean" as const, description: "Output as JSON" },
    parallel: {
      type: "boolean" as const,
      description: "Validate prior parallel authority for the scribe",
    },
  },
  run({ args }) {
    const root = resolveStateRoot({
      cwd: args.cwd ?? process.cwd(),
      feature: args.feature,
      dir: args.dir,
    });
    const cwd = root.cwd;
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
    const result =
      args["produced-by"] === "reviewer"
        ? checkReviewHandoff({
            cwd,
            dir: root.dir,
            feature: args.feature,
            evidenceOptions: resolveReceiptOptions({
              feature: args.feature,
              cwd,
              dir: root.dir,
              target: args.target,
            }),
            ...(args.since ? { since: args.since } : {}),
          })
        : checkHandoff({
            cwd,
            dir: root.dir,
            feature: args.feature,
            consumer: resolveConsumer(args.for),
            legacyMarkdown,
            parallel: args.parallel,
            evidenceOptions: resolveReceiptOptions({
              feature: args.feature,
              cwd,
              dir: root.dir,
              target: args.target,
            }),
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

const logReviewSubCommand = defineCommand({
  meta: {
    name: "log-review",
    description:
      "Validate review_<feature>.json and append findings with score >= 50 to findings.jsonl (deduped)",
  },
  args: {
    feature: { type: "positional" as const, required: true, description: "Feature slug" },
    dir: { type: "string" as const, description: "Progress directory" },
    cwd: { type: "string" as const, description: "Checkout to operate on" },
    json: { type: "boolean" as const, description: "Output as JSON" },
  },
  run({ args }) {
    const result = logReview({
      cwd: args.cwd ?? process.cwd(),
      feature: args.feature,
      dir: args.dir,
      observe: (info) =>
        emitReviewOutcome(() => {
          const { cwd, feature, dir, target, gate } = resolveReceiptOptions({
            feature: args.feature,
            dir: args.dir,
            cwd: args.cwd,
          });
          return { cwd, feature, dir, target, gate };
        }, info),
    });
    const text =
      result.status === "error"
        ? result.message
        : `${result.status === "duplicate" ? "DUPLICATE" : "OK"}: ${result.appended} finding(s) appended`;
    process.stdout.write(`${args.json ? JSON.stringify(result) : text}\n`);
    process.exitCode = result.status === "error" ? 1 : 0;
  },
});

export const handoffCommand = defineCommand({
  meta: { name: "handoff", description: "Validate the implementer's handoff before dispatch" },
  subCommands: {
    "prepare-parallel": defineCommand({
      meta: {
        name: "prepare-parallel",
        description: "Bind immutable approved level-3 parallel scope",
      },
      args: {
        ...producerArgs,
        request: {
          type: "string" as const,
          required: true,
          description: "Prior parallel request JSON file",
        },
        target: { type: "string" as const, required: true, description: "Review target branch" },
        supersede: { type: "string" as const, description: "Explicit previous parallel run ID" },
      },
      async run({ args }) {
        const options = resolveReceiptOptions(args);
        let result;
        try {
          result = await prepareParallel({
            ...options,
            supersede: args.supersede,
            request: JSON.parse(readFileSync(resolve(options.cwd, args.request), "utf8")),
          });
        } catch (error) {
          result = {
            status: "error",
            message: error instanceof Error ? error.message : "parallel request unavailable",
          };
        }
        emitProducer(result, args.json, "prepared");
      },
    }),
    "begin-parallel": defineCommand({
      meta: {
        name: "begin-parallel",
        description: "Start the native producer's immutable parallel work interval",
      },
      args: {
        ...producerArgs,
        ...runArg,
      },
      run({ args }) {
        const result = beginParallel({ ...resolveReceiptOptions(args), runId: args.run });
        emitProducer(result, args.json, "ok");
      },
    }),
    "complete-parallel": defineCommand({
      meta: {
        name: "complete-parallel",
        description: "Seal the native producer's own parallel paths",
      },
      args: {
        ...producerArgs,
        ...runArg,
        status: { type: "string" as const, required: true, description: "DONE or BLOCKED" },
        reason: {
          type: "string" as const,
          description: "Required blocker description when status is BLOCKED",
        },
      },
      run({ args }) {
        const result = completeParallel({
          ...resolveReceiptOptions(args),
          runId: args.run,
          status: args.status,
          reason: args.reason,
        });
        emitProducer(result, args.json, "completed");
      },
    }),
    "finalize-parallel": defineCommand({
      meta: {
        name: "finalize-parallel",
        description: "Join both producers after serial render and shared checks",
      },
      args: {
        ...producerArgs,
        target: { type: "string" as const, required: true, description: "Review target branch" },
      },
      run({ args }) {
        const result = finalizeParallel(resolveReceiptOptions(args));
        emitProducer(result, args.json, "finalized");
      },
    }),
    attest: defineCommand({
      meta: {
        name: "attest",
        description: "Attest delivery ownership from the native producer context",
      },
      args: {
        feature: { type: "positional" as const, required: true, description: "Feature slug" },
        target: { type: "string" as const, description: "Review target branch" },
        dir: { type: "string" as const, description: "State directory" },
        json: { type: "boolean" as const, description: "Output JSON" },
      },
      run({ args }) {
        const options = resolveReceiptOptions({
          feature: args.feature,
          target: args.target,
          dir: args.dir,
        });
        const result = attestHandoff(options);
        process.stdout.write(
          `${args.json ? JSON.stringify(result) : (result.message ?? result.status)}\n`,
        );
        process.exitCode = result.status === "attested" ? 0 : 1;
      },
    }),
    check: checkSubCommand,
    "log-review": logReviewSubCommand,
  },
});
