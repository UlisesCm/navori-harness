// R17 table: per hook × engine × scenario, native vs shell wall p95, relative and absolute criteria.
// Usage: node r17-criteria.mjs <dir with hooks-shell.json and hooks-rust.json>
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const shell = JSON.parse(readFileSync(join(dir, "hooks-shell.json"), "utf8"));
const rust = JSON.parse(readFileSync(join(dir, "hooks-rust.json"), "utf8"));
const key = (m) => `${m.hook}|${m.engine}|${m.event}|${m.scenario}`;
const byKey = new Map(shell.measurements.map((m) => [key(m), m]));
// Ulises, 19 nov 19:00: every batch hook is held to 12 ms absolute p95 and native/shell <= 1.0.
const BUDGET = 12;
const RATIO = 1.0;
const rows = [];
for (const r of rust.measurements) {
  const s = byKey.get(key(r));
  rows.push({
    hook: r.hook.replace(/\.sh$/, ""),
    engine: r.engine,
    scenario: r.scenario,
    shellP95: s?.wallMsP95,
    rustP95: r.wallMsP95,
    rustP50: r.wallMsMedian,
    ratio: s ? r.wallMsP95 / s.wallMsP95 : undefined,
    exits: [...new Set(r.exitCodes)].join(","),
  });
}
rows.sort((a, b) => a.hook.localeCompare(b.hook) || a.engine.localeCompare(b.engine) || a.scenario.localeCompare(b.scenario));
const f = (n) => (n === undefined ? "-" : n.toFixed(1));
console.log(`shell comparable=${shell.comparable} load=${shell.loadavgBefore?.[0]} | rust comparable=${rust.comparable} load=${rust.loadavgBefore?.[0]}`);
console.log("| hook | motor | escenario | shell p95 | nativo p95 | nativo/shell | relativo (≤1,0) | absoluto (≤12 ms) |");
console.log("|---|---|---|---|---|---|---|---|");
let rel = 0;
let abs = 0;
let missing = 0;
for (const row of rows) {
  const relOk = row.ratio !== undefined && row.ratio <= RATIO;
  const absOk = row.rustP95 <= BUDGET;
  if (row.ratio === undefined) missing += 1;
  else if (!relOk) rel += 1;
  if (!absOk) abs += 1;
  console.log(
    `| ${row.hook} | ${row.engine} | ${row.scenario} | ${f(row.shellP95)} | ${f(row.rustP95)} | ${row.ratio === undefined ? "-" : row.ratio.toFixed(2)} | ${row.ratio === undefined ? "sin shell" : relOk ? "sí" : "NO"} | ${absOk ? "sí" : "NO"} |`,
  );
}
console.log(`\nmediciones=${rows.length} fallan relativo=${rel} fallan absoluto=${abs} sin par shell=${missing}`);
