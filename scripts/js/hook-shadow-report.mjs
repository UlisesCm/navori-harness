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
 *
 * The R81 close runs `--close-per-row --markdown [--batches <json>]`: each hook and engine is judged
 * at its own first row + the window (later rows do not count; a window still open is amber), and the
 * table adds failures, first/last row and that closing instant. `--now <ISO>` replaces the clock.
 *
 * A begin that never completed (a lost observation, e.g. an interrupted call) is neither a
 * divergence nor silent: it keeps a gating row AMBER, with its time, while the row is open. At the
 * row's close it turns green only when every lost observation has its cause in `--causes <json>`
 * (`{ "<hook>|<engine>|<ISO begin>": "<cause>" }`, mirrored from the engram note sombra-ventana),
 * they are under 0.5 % of the row's calls and no two fall within 10 minutes of each other;
 * otherwise red.
 */

const DAY_MS = 86_400_000;
const ENGINES = ["claude", "codex", "pi"];
/** A begin without completion older than this is a lost observation, not an in-flight call. */
const PENDING_GRACE_MS = 10 * 60_000;
/** Lost observations at or above this share of a row's calls turn it red at the close. */
const MAX_LOST_SHARE = 0.005;
/** Two lost observations closer than this form a group, which turns the row red at the close. */
const LOST_GROUP_MS = 10 * 60_000;
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
 *   perRowClose?: boolean,
 *   causes?: Record<string, string>,
 * }} input
 */
export function buildReport({
  hooks,
  journals,
  engines,
  approved,
  now,
  windowDays,
  perRowClose = false,
  causes = {},
}) {
  const windowMs = windowDays * DAY_MS;
  const rows = [];
  for (const [hook, descriptor] of Object.entries(hooks)) {
    const decoded = [journals[hook] ?? []].flat().map((bytes) => decodeJournal(bytes));
    const valid = decoded.every((part) => part !== null);
    const records = valid ? decoded.flatMap((part) => part.records) : null;
    // Journals written before the payload was dropped: informational, the file is safe to delete.
    const legacyPayloadRows = valid
      ? decoded.reduce((sum, part) => sum + part.legacyPayloadRows, 0)
      : 0;
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
        pendingMs: [],
        unobserved: 0,
        nativeFailed: 0,
        shellFailed: 0,
        firstMs: null,
        lastMs: null,
        closesMs: null,
        legacyPayloadRows,
        spanDays: 0,
        problems: [...problems],
        warnings: [],
      };
      // A fixed `now` closes the window: later rows belong to the next one.
      const current = [...begins.values()].filter(
        (begin) =>
          begin.engine === engine &&
          begin.implementation === descriptor.impl &&
          begin.timeMs <= now,
      );
      const first = Math.min(...current.map((begin) => begin.timeMs));
      // Per-row close (R81): each hook and engine is judged at its own first row + the window.
      let closeAt = now;
      if (perRowClose && first !== Infinity) {
        row.closesMs = first + windowMs;
        if (row.closesMs > now) {
          // Not closed yet is not a failure: amber for a gating hook (advisory ones only turn red
          // on a divergence, as in the clock-based window).
          if (descriptor.gating)
            row.warnings.push(`window open until ${new Date(row.closesMs).toISOString()}`);
        } else {
          closeAt = row.closesMs;
        }
      }
      for (const begin of current) {
        if (begin.timeMs > closeAt || begin.timeMs < closeAt - windowMs) continue;
        row.firstMs = Math.min(row.firstMs ?? Infinity, begin.timeMs);
        row.lastMs = Math.max(row.lastMs ?? -Infinity, begin.timeMs);
        const end = ends.get(begin.id);
        if (!end) {
          if (closeAt - begin.timeMs > PENDING_GRACE_MS) {
            row.pending++;
            row.pendingMs.push(begin.timeMs);
          }
          continue;
        }
        row.invocations++;
        if (end.comparison.nativeFailed) row.nativeFailed++;
        if (end.comparison.shellFailed) row.shellFailed++;
        if (diverged(end.comparison)) row.divergences++;
        else if (end.comparison.nativeUnobserved === true) row.unobserved++;
      }
      row.spanDays = first === Infinity ? 0 : (closeAt - first) / DAY_MS;
      if (row.divergences > 0) row.problems.push(`${row.divergences} divergence(s)`);
      if (descriptor.gating) {
        if (row.pending > 0) {
          const closed = perRowClose && row.closesMs !== null && row.closesMs <= now;
          const gaps = lostObservationGaps(hook, engine, row, causes);
          const at = row.pendingMs.map((ms) => new Date(ms).toISOString()).join(", ");
          const lost = `${row.pending} observation(s) never completed (${at})`;
          const detail = gaps.length ? `${lost}: ${gaps.join("; ")}` : lost;
          if (!closed) row.warnings.push(detail);
          else if (gaps.length) row.problems.push(detail);
        }
        if (row.invocations === 0) {
          if (!(approved[hook] ?? []).includes(engine))
            row.problems.push("no shadow traffic and no no-shadow-traffic approval (R82)");
        } else if (row.spanDays < windowDays && !(perRowClose && row.closesMs > now)) {
          row.problems.push(`window ${row.spanDays.toFixed(3)} d is shorter than ${windowDays} d`);
        }
      }
      row.status = row.problems.length ? "red" : row.warnings.length ? "amber" : "green";
      row.ok = row.status === "green";
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
        pendingMs: [],
        unobserved: 0,
        nativeFailed: 0,
        shellFailed: 0,
        firstMs: null,
        lastMs: null,
        closesMs: null,
        legacyPayloadRows,
        spanDays: 0,
        problems: ["no engine renders the native block for this hook"],
        warnings: [],
        status: "red",
        ok: false,
      });
  }
  return { ok: rows.every((row) => row.ok), status: worst(rows), windowDays, rows };
}

/** The worst status of some rows: red over amber over green. */
function worst(rows) {
  if (rows.some((row) => row.status === "red")) return "red";
  return rows.some((row) => row.status === "amber") ? "amber" : "green";
}

/** The conditions a row's lost observations still miss to count as green at its close. */
function lostObservationGaps(hook, engine, row, causes) {
  const gaps = [];
  const unexplained = row.pendingMs.filter(
    (ms) => !causes[`${hook}|${engine}|${new Date(ms).toISOString()}`],
  );
  if (unexplained.length) gaps.push(`${unexplained.length} without a recorded cause`);
  const calls = row.invocations + row.pending;
  if (row.pending / calls >= MAX_LOST_SHARE)
    gaps.push(`${((100 * row.pending) / calls).toFixed(2)} % of calls (limit 0.5 %)`);
  const sorted = [...row.pendingMs].sort((a, b) => a - b);
  if (sorted.some((ms, at) => at > 0 && ms - sorted[at - 1] < LOST_GROUP_MS))
    gaps.push("grouped (two within 10 min)");
  return gaps;
}

/** Collects the inputs of `buildReport` from a project root and the checkouts holding journals. */
export function collect(
  root,
  windowDays,
  now = Date.now(),
  journalRoots = [root],
  perRowClose = false,
  causes = {},
) {
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
  return buildReport({
    hooks: manifest.hooks,
    journals,
    engines,
    approved,
    now,
    windowDays,
    perRowClose,
    causes,
  });
}

function format(report) {
  const lines = [`hook shadow report (window ${report.windowDays} d)`];
  for (const row of report.rows) {
    const status = { green: "ok ", amber: "AMB", red: "RED" }[row.status];
    const notes = [...row.problems, ...row.warnings];
    lines.push(
      `${status} ${row.hook} [${row.engine}] ${row.gating ? "gating" : "advisory"} ` +
        `calls=${row.invocations} divergences=${row.divergences} pending=${row.pending} ` +
        `unobserved=${row.unobserved} span=${row.spanDays.toFixed(1)}d` +
        (row.legacyPayloadRows > 0
          ? ` legacyPayloadRows=${row.legacyPayloadRows} (delete this journal)`
          : "") +
        (notes.length ? ` — ${notes.join("; ")}` : ""),
    );
  }
  return lines.join("\n");
}

/**
 * Markdown table for the R81 close: one row per hook and engine, then one verdict per activation
 * batch (`{ "<batch>": ["<hook>", ...] }`), green only when every row of its hooks is green.
 */
export function formatMarkdown(report, batches = {}) {
  const iso = (ms) => (ms === null ? "-" : new Date(ms).toISOString());
  const lines = [
    `R81, window ${report.windowDays} d: ${report.status}`,
    "",
    "| Hook | Engine | Gating | Calls | Divergences | nativeFailed | shellFailed | Pending | Unobserved | First row | Last row | Closes at | Verdict |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const row of report.rows) {
    lines.push(
      `| ${row.hook} | ${row.engine} | ${row.gating ? "yes" : "no"} | ${row.invocations} | ` +
        `${row.divergences} | ${row.nativeFailed} | ${row.shellFailed} | ${row.pending} | ` +
        `${row.unobserved} | ${iso(row.firstMs)} | ${iso(row.lastMs)} | ${iso(row.closesMs)} | ` +
        `${row.status === "green" ? "green" : `${row.status}: ${[...row.problems, ...row.warnings].join("; ")}`} |`,
    );
  }
  const names = Object.keys(batches);
  if (names.length > 0) {
    lines.push("", "| Batch | Hooks | Verdict |", "|---|---|---|");
    for (const name of names) {
      const hooks = batches[name];
      const rows = report.rows.filter((row) => hooks.includes(row.hook));
      const missing = hooks.filter((hook) => !rows.some((row) => row.hook === hook));
      const status = worst(rows);
      const named = [
        ...new Set(
          rows.filter((row) => row.status === status).map((row) => `${row.hook} [${row.engine}]`),
        ),
      ];
      const verdict =
        missing.length > 0
          ? `red: no rows for ${missing.join(", ")} (unknown hook or no engine registered)`
          : status === "green"
            ? "green"
            : `${status}: ${named.join(", ")}`;
      lines.push(`| ${name} | ${hooks.join(", ")} | ${verdict} |`);
    }
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
    // `--now <ISO date>` evaluates the window as of that instant (the R81 close), not the clock.
    const nowArg = args.includes("--now") ? (value("--now", undefined) ?? "") : undefined;
    const now = nowArg === undefined ? Date.now() : Date.parse(nowArg);
    if (!Number.isFinite(now)) throw new Error("--now needs an ISO date");
    const batchesPath = value("--batches", undefined);
    const batches = batchesPath === undefined ? {} : JSON.parse(readFileSync(batchesPath, "utf8"));
    const causesPath = value("--causes", undefined);
    const causes = causesPath === undefined ? {} : JSON.parse(readFileSync(causesPath, "utf8"));
    const report = collect(
      root,
      windowDays,
      now,
      journalRoots,
      args.includes("--close-per-row"),
      causes,
    );
    console.log(
      args.includes("--json")
        ? JSON.stringify(report)
        : args.includes("--markdown")
          ? formatMarkdown(report, batches)
          : format(report),
    );
    // 0 green, 1 red, 3 amber (2 is an error).
    process.exitCode = { green: 0, red: 1, amber: 3 }[report.status];
  } catch (error) {
    console.error(`hook-shadow-report: ${error.message}`);
    process.exitCode = 2;
  }
}
