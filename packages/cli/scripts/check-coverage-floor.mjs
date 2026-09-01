import { readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * #504 — the per-file floor the aggregate gate cannot express.
 *
 * `vitest.config.ts` gates the AVERAGE over `src/lib/**` (lines 65, statements
 * 60, functions 65, branches 57). An average cannot see a single module at 0%:
 * `lib/migrate.ts` — the code that DELETES the user's harness — sat at 0% inside
 * that same include and never moved the number, because 105 uncovered lines
 * dilute into ~3,300 statements. Vitest cannot express both shapes at once
 * (`thresholds.perFile` is a single global flag: turning it on would apply 65%
 * to every file, which the tree does not meet), so the floor lives here.
 *
 * The floor is deliberately the weakest useful bar: EVERY guarded file must have
 * at least one covered line. It answers "is anything exercising this module at
 * all", not "is it well tested" — that stays with the aggregate.
 *
 * TODO(coverage): the floor guards `src/lib/**` only. Under `src/commands/**` a
 * 0% reading does not mean untested: the e2e specs spawn `dist/index.js`, and
 * in-process v8 coverage cannot see a child process (13 command modules read 0%
 * while having e2e coverage). Extending the floor there requires collecting
 * NODE_V8_COVERAGE from the spawned CLI and merging it — worth doing the day a
 * command module ships genuinely untested, not before.
 *
 * Usage: node scripts/check-coverage-floor.mjs   (after `vitest run --coverage`)
 */

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SUMMARY = resolve(PKG_ROOT, "coverage", "coverage-summary.json");
/** Where a 0% reading really means "nothing exercises this". */
const GUARDED_PREFIX = "src/lib/";

/**
 * Files allowed to sit at 0%, each with the reason it earns. An entry is a
 * DECISION, not a hiding place: the check fails when one becomes stale, so the
 * list cannot quietly outlive its reason.
 */
const KNOWN_ZERO = new Map([
  [
    "src/lib/args.ts",
    "reached only from src/commands/**, which the e2e specs exercise in the spawned dist/index.js (invisible to in-process v8)",
  ],
  // The audit feature's reporting half is no longer untested: `report.ts` left
  // this list in spec 0013 (the per-agent card needed specs of its own) and
  // `harness.ts` in #561 — its parse feeds the report's only `high` signal, and
  // writing the specs turned up two silent defects in it.
]);

function die(lines) {
  for (const line of lines) console.error(line);
  process.exit(1);
}

let summary;
try {
  summary = JSON.parse(readFileSync(SUMMARY, "utf-8"));
} catch (err) {
  // A floor that cannot read its input is NOT a floor that passed.
  die([
    `⊘ coverage floor could not run: ${SUMMARY} is unreadable (${err.message})`,
    `  run it after \`vitest run --coverage\`, with 'json-summary' among the reporters`,
  ]);
}

const guarded = [];
for (const [key, value] of Object.entries(summary)) {
  if (key === "total") continue;
  const rel = relative(PKG_ROOT, key).split(sep).join("/");
  if (rel.startsWith(GUARDED_PREFIX)) guarded.push([rel, value]);
}

if (guarded.length === 0) {
  die([
    `⊘ coverage floor could not run: no file under ${GUARDED_PREFIX} in the report`,
    `  did coverage.include stop matching it?`,
  ]);
}

const uncovered = guarded
  .filter(([, v]) => v.lines.pct === 0)
  .map(([rel]) => rel)
  .sort();
const offenders = uncovered.filter((rel) => !KNOWN_ZERO.has(rel));
const stale = [...KNOWN_ZERO.keys()].filter((rel) => !uncovered.includes(rel)).sort();

if (offenders.length > 0) {
  die([
    `✗ coverage floor: ${offenders.length} module(s) under ${GUARDED_PREFIX} at 0% lines`,
    ...offenders.map((rel) => `    ${rel}`),
    ``,
    `  Nothing executes them, so no test can be protecting them — and the`,
    `  aggregate gate cannot say so: one module dilutes into the average.`,
    `  Add a test, or record the exception in KNOWN_ZERO (${relative(PKG_ROOT, fileURLToPath(import.meta.url))})`,
    `  with the reason it earns.`,
  ]);
}

if (stale.length > 0) {
  die([
    `✗ coverage floor: ${stale.length} stale KNOWN_ZERO entry(ies) — no longer at 0%`,
    ...stale.map((rel) => `    ${rel} (${KNOWN_ZERO.get(rel)})`),
    ``,
    `  Good news, and the list has to record it: delete those entries.`,
  ]);
}

console.log(
  `✓ coverage floor: ${guarded.length} module(s) under ${GUARDED_PREFIX} exercised (${KNOWN_ZERO.size} documented exception(s))`,
);
