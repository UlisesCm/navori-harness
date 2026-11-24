// Read-only: per hook/engine of the CURRENT impl, first/last begin, calls, failures. Counts only.
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
const root = resolve(process.argv[2] ?? ".");
const since = process.argv[3] ? Date.parse(process.argv[3]) : 0;
const { decodeJournal } = await import(join(root, "packages/cli/src/lib/rust-shadow/report.ts"));
const { diverged } = await import(join(root, "packages/cli/src/lib/rust-shadow/journal.schema.ts"));
const manifest = JSON.parse(readFileSync(join(root, "crates/ported.json"), "utf8"));
const fmt = (ms) => (Number.isFinite(ms) ? new Date(ms).toLocaleString("sv-SE", { timeZone: "America/Mexico_City" }) : "-");
for (const [hook, d] of Object.entries(manifest.hooks)) {
  const path = join(root, ".navori/state/rust-shadow", `${hook}.jsonl`);
  if (!existsSync(path)) { console.log(`${hook} no-journal`); continue; }
  const j = decodeJournal(readFileSync(path));
  if (!j) { console.log(`${hook} INVALID`); continue; }
  const ends = new Map(j.records.filter((r) => r.kind !== "begin").map((r) => [r.id, r]));
  const by = {};
  let oldImpl = 0;
  for (const b of j.records.filter((r) => r.kind === "begin" && r.hook === hook)) {
    if (b.implementation !== d.impl) { oldImpl++; continue; }
    if (b.timeMs < since) continue;
    const s = (by[b.engine] ??= { calls: 0, pending: 0, div: 0, nf: 0, sf: 0, unobs: 0, first: Infinity, last: -Infinity });
    s.first = Math.min(s.first, b.timeMs); s.last = Math.max(s.last, b.timeMs);
    const e = ends.get(b.id);
    if (!e) { s.pending++; continue; }
    s.calls++;
    if (diverged(e.comparison)) s.div++;
    if (e.comparison.nativeFailed) s.nf++;
    if (e.comparison.shellFailed) s.sf++;
    if (e.comparison.nativeUnobserved === true) s.unobs++;
  }
  const parts = Object.entries(by).map(([e, s]) => `${e}: calls=${s.calls} pend=${s.pending} div=${s.div} nativeFailed=${s.nf} shellFailed=${s.sf} unobs=${s.unobs} first=${fmt(s.first)} last=${fmt(s.last)}`);
  console.log(`${hook} impl=${d.impl.slice(7, 19)} oldImplRows=${oldImpl} | ${parts.join(" | ") || "0 new-impl rows"}`);
}
