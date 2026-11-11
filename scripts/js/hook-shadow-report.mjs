import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeJournal } from "../../packages/cli/src/lib/rust-shadow/report.ts";
import { diverged } from "../../packages/cli/src/lib/rust-shadow/journal.schema.ts";

/**
 * R81/R82 evidence: per hook and engine, shadow invocations and divergences inside a window.
 * Red on any divergence, and for a gating hook on a registered engine without traffic (unless its
 * `activate` line carries `no-shadow-traffic`, R82) or with a window shorter than requested.
 * Advisory hooks are reported but only a divergence turns them red.
 *
 * Each checkout writes its own journal under `.navori/state/rust-shadow/`, so the shadow traffic of
 * the migration worktrees is scattered: `--journals <dir>` (repeatable) adds the journals of other
 * checkouts. The manifest, history and registered engines always come from `--root`.
 */

const DAY_MS = 86_400_000;
const ENGINES = ["claude", "codex", "pi"];
/** A begin without completion older than this is a lost observation, not an in-flight call. */
const PENDING_GRACE_MS = 10 * 60_000;
const MANIFEST = "crates/ported.json";
const HISTORY = "crates/ported-history.jsonl";
/** Rendered hook of each engine; the native block marks it as registered for that engine. */
const RENDERED = {
  claude: (hook) => `.claude/hooks/${hook}.sh`,
  codex: (hook) => `.codex/hooks/${hook}.sh`,
  pi: (hook) => `.pi/navori/hooks/${hook}.sh`,
};

/** Engines whose rendered hook carries the native runtime block. */
export function registeredEngines(root, hook) {
  return ENGINES.filter((engine) => {
    const path = join(root, RENDERED[engine](hook));
    return existsSync(path) && readFileSync(path, "utf8").includes("navori:native-runtime start");
  });
}

/** Engines approved for activation without shadow traffic (R82), from `activate` lines. */
export function approvedWithoutTraffic(historyText, hook) {
  const lines = historyText.trim() === "" ? [] : historyText.trim().split("\n");
  return lines
    .map((line) => JSON.parse(line))
    .filter(
      (event) =>
        event.op === "activate" && event.id === hook && event.reason === "no-shadow-traffic",
    )
    .flatMap((event) => (Array.isArray(event.engines) ? event.engines : ENGINES));
}

/**
 * @param {{
 *   hooks: Record<string, { gating: boolean, impl: string }>,
 *   journals: Record<string, Uint8Array | Uint8Array[] | undefined>,
 *   engines: Record<string, string[]>,
 *   approved: Record<string, string[]>,
 *   now: number,
 *   windowDays: number,
 * }} input
 */
export function buildReport({ hooks, journals, engines, approved, now, windowDays }) {
  const windowMs = windowDays * DAY_MS;
  const rows = [];
  for (const [hook, descriptor] of Object.entries(hooks)) {
    const decoded = [journals[hook] ?? []].flat().map((bytes) => decodeJournal(bytes));
    const valid = decoded.every((part) => part !== null);
    const records = valid ? decoded.flatMap((part) => part.records) : null;
    // Journals written before the payload was dropped: informational, the file is safe to delete.
    const legacyPayloadRows = valid ? decoded.reduce((sum, part) => sum + part.legacyPayloadRows, 0) : 0;
    const problems = [];
    if (records === null) problems.push("journal is invalid or unavailable");
    const begins = new Map();
    const ends = new Map();
    for (const record of records ?? []) {
      if (record.hook !== hook) continue;
      (record.kind === "begin" ? begins : ends).set(record.id, record);
    }
    for (const engine of engines[hook] ?? []) {
      const row = {
        hook,
        engine,
        gating: descriptor.gating,
        invocations: 0,
        divergences: 0,
        pending: 0,
        unobserved: 0,
        legacyPayloadRows,
        spanDays: 0,
        problems: [...problems],
      };
      let first = Infinity;
      for (const begin of begins.values()) {
        if (begin.engine !== engine || begin.implementation !== descriptor.impl) continue;
        first = Math.min(first, begin.timeMs);
        if (begin.timeMs < now - windowMs) continue;
        const end = ends.get(begin.id);
        if (!end) {
          if (now - begin.timeMs > PENDING_GRACE_MS) row.pending++;
          continue;
        }
        row.invocations++;
        if (diverged(end.comparison)) row.divergences++;
        else if (end.comparison.nativeUnobserved === true) row.unobserved++;
      }
      row.spanDays = first === Infinity ? 0 : (now - first) / DAY_MS;
      if (row.divergences > 0) row.problems.push(`${row.divergences} divergence(s)`);
      if (descriptor.gating) {
        if (row.pending > 0) row.problems.push(`${row.pending} observation(s) never completed`);
        if (row.invocations === 0) {
          if (!(approved[hook] ?? []).includes(engine))
            row.problems.push("no shadow traffic and no no-shadow-traffic approval (R82)");
        } else if (row.spanDays < windowDays) {
          row.problems.push(
            `window ${row.spanDays.toFixed(1)} d is shorter than ${windowDays} d`,
          );
        }
      }
      row.ok = row.problems.length === 0;
      rows.push(row);
    }
    if ((engines[hook] ?? []).length === 0 && descriptor.gating)
      rows.push({
        hook,
        engine: "-",
        gating: true,
        invocations: 0,
        divergences: 0,
        pending: 0,
        unobserved: 0,
        legacyPayloadRows,
        spanDays: 0,
        problems: ["no engine renders the native block for this hook"],
        ok: false,
      });
  }
  return { ok: rows.every((row) => row.ok), windowDays, rows };
}

/** Collects the inputs of `buildReport` from a project root and the checkouts holding journals. */
export function collect(root, windowDays, now = Date.now(), journalRoots = [root]) {
  const manifest = JSON.parse(readFileSync(join(root, MANIFEST), "utf8"));
  const historyPath = join(root, HISTORY);
  const history = existsSync(historyPath) ? readFileSync(historyPath, "utf8") : "";
  const journals = {};
  const engines = {};
  const approved = {};
  for (const hook of Object.keys(manifest.hooks)) {
    journals[hook] = journalRoots
      .map((dir) => join(dir, ".navori/state/rust-shadow", `${hook}.jsonl`))
      .filter((path) => existsSync(path))
      .map((path) => readFileSync(path));
    engines[hook] = registeredEngines(root, hook);
    approved[hook] = approvedWithoutTraffic(history, hook);
  }
  return buildReport({ hooks: manifest.hooks, journals, engines, approved, now, windowDays });
}

function format(report) {
  const lines = [`hook shadow report (window ${report.windowDays} d)`];
  for (const row of report.rows) {
    const status = row.ok ? "ok " : "RED";
    lines.push(
      `${status} ${row.hook} [${row.engine}] ${row.gating ? "gating" : "advisory"} ` +
        `calls=${row.invocations} divergences=${row.divergences} pending=${row.pending} ` +
        `unobserved=${row.unobserved} span=${row.spanDays.toFixed(1)}d` +
        (row.legacyPayloadRows > 0
          ? ` legacyPayloadRows=${row.legacyPayloadRows} (delete this journal)`
          : "") +
        (row.problems.length ? ` — ${row.problems.join("; ")}` : ""),
    );
  }
  return lines.join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (flag, fallback) => {
    const at = args.indexOf(flag);
    return at === -1 ? fallback : args[at + 1];
  };
  const windowDays = Number(value("--window", "7"));
  if (!Number.isFinite(windowDays) || windowDays <= 0) {
    console.error("hook-shadow-report: --window needs a positive number of days");
    process.exit(2);
  }
  try {
    const root = resolve(value("--root", process.cwd()));
    const extra = args.flatMap((arg, at) => (arg === "--journals" ? [args[at + 1]] : []));
    if (extra.some((dir) => dir === undefined || !existsSync(dir)))
      throw new Error("--journals needs an existing directory");
    const journalRoots = [...new Set([root, ...extra.map((dir) => resolve(dir))])];
    const report = collect(root, windowDays, Date.now(), journalRoots);
    console.log(args.includes("--json") ? JSON.stringify(report) : format(report));
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    console.error(`hook-shadow-report: ${error.message}`);
    process.exitCode = 2;
  }
}
