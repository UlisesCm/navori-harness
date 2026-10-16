/**
 * `navori gate <fast|full>` — run the project's quality gate with the full
 * output in a log file and only a compact verdict on stdout.
 */
import { defineCommand } from "citty";
import { runForeignGate, runGate, type GateKind } from "../lib/gate/run.ts";

export const gateCommand = defineCommand({
  meta: {
    name: "gate",
    description:
      "Run qualityGate.<fast|full>, or `foreign` for a registered destination repo (hooks only); full output goes to a log, stdout gets a verdict",
  },
  args: {
    kind: { type: "positional", required: true, description: "fast | full | foreign" },
    cwd: { type: "string", description: "Project root", default: process.cwd() },
  },
  async run({ args }) {
    const kind = String(args.kind);
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
        `navori gate: unknown kind "${kind}" (expected fast | full | foreign)\n`,
      );
      process.exitCode = 2;
      return;
    }
    const result = await runGate({ cwd: String(args.cwd), kind: kind as GateKind });
    if (result.stdout) process.stdout.write(`${result.stdout}\n`);
    if (result.stderr) process.stderr.write(`${result.stderr}\n`);
    process.exitCode = result.exitCode;
  },
});
