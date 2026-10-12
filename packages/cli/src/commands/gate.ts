/**
 * `navori gate <fast|full>` — run the project's quality gate with the full
 * output in a log file and only a compact verdict on stdout.
 */
import { defineCommand } from "citty";
import { runGate, type GateKind } from "../lib/gate/run.ts";

export const gateCommand = defineCommand({
  meta: {
    name: "gate",
    description: "Run qualityGate.<fast|full>; full output goes to a log, stdout gets a verdict",
  },
  args: {
    kind: { type: "positional", required: true, description: "fast | full" },
    cwd: { type: "string", description: "Project root", default: process.cwd() },
  },
  async run({ args }) {
    const kind = String(args.kind);
    if (kind !== "fast" && kind !== "full") {
      process.stderr.write(`navori gate: unknown kind "${kind}" (expected fast | full)\n`);
      process.exitCode = 2;
      return;
    }
    const result = await runGate({ cwd: String(args.cwd), kind: kind as GateKind });
    if (result.stdout) process.stdout.write(`${result.stdout}\n`);
    if (result.stderr) process.stderr.write(`${result.stderr}\n`);
    process.exitCode = result.exitCode;
  },
});
