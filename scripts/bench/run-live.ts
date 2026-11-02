import { liveMain } from "../../packages/cli/src/lib/bench/live.ts";

liveMain(process.argv.slice(2)).catch((error: unknown): void => {
  process.stderr.write(`live benchmark: ${error instanceof Error ? error.message : "unavailable"}\n`);
  process.exitCode = 1;
});
