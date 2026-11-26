import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Spec 0060 D42 / T18 — PATH stub of an external tool for the oracle. Both CLIs of a case that
 * declares `tools` run with a `<tool>` wrapper first on `PATH` that execs this file, so TS and
 * Rust see exactly the same answers and nothing reaches the network.
 *
 *   node stub-tool.mjs <tool> [args…]
 *
 * Answers from `$NAVORI_ORACLE_RECORDINGS/<tool>.json` (`{ schema: 1, tool, version, responses:
 * [{ args, status, stdout, stderr }] }`) by exact argv, and appends `{ tool, args }` to
 * `$NAVORI_ORACLE_CALLS` (JSON lines). An argv without a recording prints why and exits 127, the
 * same for both sides, so a missing recording shows up as a difference-free failure in both runs
 * rather than a call to the real tool.
 */

const [tool, ...args] = process.argv.slice(2);
const calls = process.env.NAVORI_ORACLE_CALLS;
if (calls) appendFileSync(calls, `${JSON.stringify({ tool, args })}\n`);
const path = join(process.env.NAVORI_ORACLE_RECORDINGS ?? "", `${tool}.json`);
const file = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { responses: [] };
const found = file.responses.find(
  (r) => r.args.length === args.length && r.args.every((arg, i) => arg === args[i]),
);
if (found === undefined) {
  process.stderr.write(`oracle stub: no recording for ${[tool, ...args].join(" ")}\n`);
  process.exitCode = 127;
} else {
  process.stdout.write(found.stdout);
  process.stderr.write(found.stderr ?? "");
  process.exitCode = found.status;
}
