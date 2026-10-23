/**
 * `navori gate <fast|full>` — run the project's quality gate with the full
 * output in a log file and only a compact verdict on stdout.
 */
import { defineCommand } from "citty";
import { resolve } from "node:path";
import { readConfig } from "../lib/config/config.ts";
import { probeGreen, type ProbeMode } from "../lib/gate/cache.ts";
import { runForeignGate, runGate, type GateKind } from "../lib/gate/run.ts";
import { resolveStateRoot } from "../lib/primitives/state-root.ts";
import { runReviewGate } from "../lib/handoff/review-evidence.ts";

/**
 * Repository-local git variables a hook inherits; only `GIT_INDEX_FILE` survives a probe
 * (the hook makes it absolute), so a probe never reads another repository's state.
 */
const PROBE_SCRUBBED = /^GIT_(?!INDEX_FILE$)/;

/** `gate probe`: exit 0 on a cached green for these bytes, 1 otherwise. Never runs the chain. */
function probe(cwd: string, mode: ProbeMode): number {
  for (const name of Object.keys(process.env)) {
    if (PROBE_SCRUBBED.test(name)) delete process.env[name];
  }
  try {
    const root = resolveStateRoot({ cwd, feature: "gate", dir: ".navori/state/gate" });
    const { fast, full } = readConfig(resolve(root.cwd, "navori.config.json")).qualityGate ?? {};
    return probeGreen(root, mode, { fast, full }) ? 0 : 1;
  } catch {
    return 1;
  }
}

export const gateCommand = defineCommand({
  meta: {
    name: "gate",
    description:
      "Run qualityGate.<fast|full>, or `foreign` for a registered destination repo (hooks only); full output goes to a log, stdout gets a verdict",
  },
  args: {
    kind: { type: "positional", required: true, description: "fast | full | probe | foreign" },
    force: { type: "boolean", description: "Run even when a cached green matches" },
    index: { type: "boolean", description: "probe: key on the index (git pre-commit)" },
    clean: { type: "boolean", description: "probe: index, working tree and record must agree" },
    cwd: { type: "string", description: "Project root", default: process.cwd() },
    "review-feature": { type: "string", description: "full: correlate this run to a review begin" },
    "review-nonce": { type: "string", description: "full: nonce returned by receipt review begin" },
    target: {
      type: "string",
      description: "Review target branch (required with --review-feature)",
    },
    dir: { type: "string", description: "Review state directory (with --review-feature)" },
  },
  async run({ args }) {
    const kind = String(args.kind);
    const review =
      args["review-feature"] !== undefined ||
      args["review-nonce"] !== undefined ||
      args.target !== undefined ||
      args.dir !== undefined;
    if (review) {
      if (
        kind !== "full" ||
        !args["review-feature"] ||
        !args["review-nonce"] ||
        !args.target ||
        args.index ||
        args.clean
      ) {
        process.stderr.write(
          "navori gate: review correlation requires full --review-feature <feature> --review-nonce <nonce> --target <branch>\n",
        );
        process.exitCode = 2;
        return;
      }
      try {
        const cwd = resolveStateRoot({
          cwd: String(args.cwd),
          feature: args["review-feature"],
          dir: args.dir,
        }).cwd;
        const { full = "" } = readConfig(resolve(cwd, "navori.config.json")).qualityGate ?? {};
        const result = await runReviewGate({
          cwd,
          feature: args["review-feature"],
          nonce: args["review-nonce"],
          target: args.target,
          dir: args.dir,
          gate: full,
        });
        if (result.stdout) process.stdout.write(`${result.stdout}\n`);
        if (result.stderr) process.stderr.write(`${result.stderr}\n`);
        process.exitCode = result.exitCode;
      } catch (error) {
        process.stderr.write(
          `navori gate: ${error instanceof Error ? error.message : "review gate failed"}\n`,
        );
        process.exitCode = 2;
      }
      return;
    }
    if (kind === "probe") {
      const mode: ProbeMode = args.clean ? "clean" : args.index ? "index" : "working";
      process.exitCode = probe(String(args.cwd), mode);
      return;
    }
    if (kind === "foreign") {
      // A positional kind, not a flag: citty ignores unknown flags, so an older CLI
      // would run a plain gate; an unknown kind refuses instead (#1097).
      const result = await runForeignGate({ cwd: String(args.cwd) });
      if (result.stdout) process.stdout.write(`${result.stdout}\n`);
      if (result.stderr) process.stderr.write(`${result.stderr}\n`);
      process.exitCode = result.exitCode;
      return;
    }
    if (kind !== "fast" && kind !== "full") {
      process.stderr.write(
        `navori gate: unknown kind "${kind}" (expected fast | full | probe | foreign)\n`,
      );
      process.exitCode = 2;
      return;
    }
    const result = await runGate({
      cwd: String(args.cwd),
      kind: kind as GateKind,
      force: args.force === true,
    });
    if (result.stdout) process.stdout.write(`${result.stdout}\n`);
    if (result.stderr) process.stderr.write(`${result.stderr}\n`);
    process.exitCode = result.exitCode;
  },
});
