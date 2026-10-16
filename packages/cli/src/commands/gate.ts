/**
 * `navori gate <fast|full>` — run the project's quality gate with the full
 * output in a log file and only a compact verdict on stdout.
 */
import { defineCommand } from "citty";
import { resolve } from "node:path";
import { readConfig } from "../lib/config/config.ts";
import { probeGreen, type ProbeMode } from "../lib/gate/cache.ts";
import { runGate, type GateKind } from "../lib/gate/run.ts";
import { resolveStateRoot } from "../lib/primitives/state-root.ts";

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
    description: "Run qualityGate.<fast|full>; full output goes to a log, stdout gets a verdict",
  },
  args: {
    kind: { type: "positional", required: true, description: "fast | full | probe" },
    force: { type: "boolean", description: "Run even when a cached green matches" },
    index: { type: "boolean", description: "probe: key on the index (git pre-commit)" },
    clean: { type: "boolean", description: "probe: index, working tree and record must agree" },
    cwd: { type: "string", description: "Project root", default: process.cwd() },
  },
  async run({ args }) {
    const kind = String(args.kind);
    if (kind === "probe") {
      const mode: ProbeMode = args.clean ? "clean" : args.index ? "index" : "working";
      process.exitCode = probe(String(args.cwd), mode);
      return;
    }
    if (kind !== "fast" && kind !== "full") {
      process.stderr.write(`navori gate: unknown kind "${kind}" (expected fast | full | probe)\n`);
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
