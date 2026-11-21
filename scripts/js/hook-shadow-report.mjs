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
 * table adds failures, first/last row and that closing instant. `--now <ISO>` replaces the clock;
 * it is read by `Date.parse`, so a date without `Z` or `±HH:MM` is LOCAL time (pass the zone).
 * A begin exactly at a row's closing instant still counts: the window is inclusive at both ends.
 *
 * A begin that never completed (a lost observation, e.g. an interrupted call) is neither a
 * divergence nor silent: it keeps a gating row AMBER, with its time, while the row is open. At the
 * row's close it turns green only when every lost observation has its cause in `--causes <json>`
 * (`{ "<hook>|<engine>|<ISO begin>": "<cause>" }`, mirrored from the engram note sombra-ventana),
 * they are under 0.5 % of the row's calls and no two fall within 10 minutes of each other;
 * otherwise red. Without `--close-per-row` no row ever closes, so a lost observation stays amber
 * (exit 3) and never turns red by itself.
 *
 * `--sibling-cancel` (opt-in; without it nothing changes): Pi's hook bridge runs the hooks of one
 * call concurrently and kills the rest when one blocks, so a sibling cut before its completion
 * leaves a begin pending without hiding a verdict (the call was already blocked). A Pi begin that
 * never completed is then reported as cancelled by a sibling, not lost, when another hook's Pi
 * begin within 500 ms (the same call) did complete. Cancelled observations get their own count
 * and need no cause, and are listed with their instant (text and Markdown). The 0.5 % share and the
 * 10-minute grouping apply only to the losses that are not cancelled (a recorded cause does not
 * exempt one); cancelled ones still count as calls in the share's denominator. Known limits: a hook
 * killed by its own bridge timeout in a call whose siblings completed is classified the same way, and so is
 * an isolated loss that coincides with another Pi session's call.
 */

const DAY_MS = 86_400_000;
const ENGINES = ["claude", "codex", "pi"];
/** A begin without completion older than this is a lost observation, not an in-flight call. */
const PENDING_GRACE_MS = 10 * 60_000;
/** Lost observations at or above this share of a row's calls turn it red at the close. */
const MAX_LOST_SHARE = 0.005;
/** Two lost observations closer than this form a group, which turns the row red at the close. */
const LOST_GROUP_MS = 10 * 60_000;
/** Pi begins of different hooks this close together belong to one bridge call (`--sibling-cancel`). */
const SIBLING_WINDOW_MS = 500;
/** The only engine whose hook runner kills the siblings of a blocking hook. */
const SIBLING_CANCEL_ENGINE = "pi";
/** What a cancelled observation means: an inference from timing, never a recorded block. */
const CANCELLED_MEANING = "compatible with a sibling's block, inferred";
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
 * A hook whose `mode` is `active` is decided by the native without the shadow lane, so it writes
 * no journal: its rows get the status `active` (no R82, window or pending check) and do not count
 * for the report or batch verdict. A divergence still in its journal keeps it red.
 *
 * @param {{
 *   hooks: Record<string, { gating: boolean, impl: string, mode?: string }>,
 *   journals: Record<string, Uint8Array | Uint8Array[] | undefined>,
 *   engines: Record<string, string[]>,
 *   approved: Record<string, string[]>,
 *   now: number,
 *   windowDays: number,
 *   perRowClose?: boolean,
 *   causes?: Record<string, string>,
 *   siblingCancel?: boolean,
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
  siblingCancel = false,
}) {
  const windowMs = windowDays * DAY_MS;
  const rows = [];
  const decodedByHook = Object.fromEntries(
    Object.keys(hooks).map((hook) => [
      hook,
      [journals[hook] ?? []].flat().map((bytes) => decodeJournal(bytes)),
    ]),
  );
  const cancelledBySibling = siblingCancel ? siblingCancellations(decodedByHook) : () => false;
  for (const [hook, descriptor] of Object.entries(hooks)) {
    const decoded = decodedByHook[hook];
    const active = descriptor.mode === "active";
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
        mode: active ? "active" : "shadow",
        invocations: 0,
        divergences: 0,
        pending: 0,
        pendingMs: [],
        cancelled: 0,
        cancelledMs: [],
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
      // reduce, not Math.min(...spread): a busy row can exceed the engine's argument limit.
      const first = current.reduce((min, begin) => Math.min(min, begin.timeMs), Infinity);
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
          // Grace runs to `now`, not `closeAt`: a begin just before the close is lost by `now`.
          if (now - begin.timeMs > PENDING_GRACE_MS) {
            if (cancelledBySibling(begin)) {
              row.cancelled++;
              row.cancelledMs.push(begin.timeMs);
            } else {
              row.pending++;
              row.pendingMs.push(begin.timeMs);
            }
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
      if (active) {
        row.status = row.problems.length ? "red" : "active";
        row.ok = row.status === "active";
        rows.push(row);
        continue;
      }
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
        mode: active ? "active" : "shadow",
        invocations: 0,
        divergences: 0,
        pending: 0,
        pendingMs: [],
        cancelled: 0,
        cancelledMs: [],
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
  return {
    ok: rows.every((row) => row.ok),
    status: worst(rows),
    windowDays,
    siblingCancel,
    rows,
  };
}

/**
 * Whether a pending begin was cut by Pi's bridge after a sibling blocked: a Pi begin of another
 * hook within SIBLING_WINDOW_MS (the same call) that completed. Reads every hook's journal, since
 * the siblings live in other files; an invalid journal contributes nothing.
 */
function siblingCancellations(decodedByHook) {
  const piBegins = [];
  const completed = new Set();
  for (const decoded of Object.values(decodedByHook)) {
    for (const part of decoded) {
      for (const record of part?.records ?? []) {
        if (record.engine !== SIBLING_CANCEL_ENGINE) continue;
        if (record.kind === "begin") piBegins.push(record);
        else completed.add(record.id);
      }
    }
  }
  return (begin) =>
    begin.engine === SIBLING_CANCEL_ENGINE &&
    piBegins.some(
      (other) =>
        other.hook !== begin.hook &&
        Math.abs(other.timeMs - begin.timeMs) <= SIBLING_WINDOW_MS &&
        completed.has(other.id),
    );
}

/**
 * The worst status of some rows: red over amber over green. `active` rows (an active hook without
 * a problem) do not count; rows that are all `active` give `active`.
 */
function worst(rows) {
  if (rows.some((row) => row.status === "red")) return "red";
  if (rows.some((row) => row.status === "amber")) return "amber";
  return rows.length > 0 && rows.every((row) => row.status === "active") ? "active" : "green";
}

/** The conditions a row's lost observations still miss to count as green at its close. */
function lostObservationGaps(hook, engine, row, causes) {
  const gaps = [];
  const unexplained = row.pendingMs.filter(
    (ms) => !causes[`${hook}|${engine}|${new Date(ms).toISOString()}`],
  );
  if (unexplained.length) gaps.push(`${unexplained.length} without a recorded cause`);
  const calls = row.invocations + row.pending + row.cancelled;
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
  siblingCancel = false,
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
    siblingCancel,
  });
}

/** The cancelled count of a row with the instant of each one, so the close lists them. */
function cancelledCell(row) {
  if (row.cancelled === 0) return "0";
  return `${row.cancelled} (${row.cancelledMs.map((ms) => new Date(ms).toISOString()).join(", ")})`;
}

function format(report) {
  const lines = [`hook shadow report (window ${report.windowDays} d)`];
  if (report.siblingCancel) lines.push(`cancelled = ${CANCELLED_MEANING}`);
  for (const row of report.rows) {
    const status = { green: "ok ", amber: "AMB", red: "RED", active: "ACT" }[row.status];
    const notes = [...row.problems, ...row.warnings];
    lines.push(
      `${status} ${row.hook} [${row.engine}] ${row.gating ? "gating" : "advisory"} ` +
        `calls=${row.invocations} divergences=${row.divergences} pending=${row.pending} ` +
        (report.siblingCancel ? `cancelled=${cancelledCell(row)} ` : "") +
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
  // The Cancelled column exists only with `--sibling-cancel`, so the default table is unchanged.
  const cancelled = report.siblingCancel === true;
  const columns = [
    "Hook",
    "Engine",
    "Gating",
    "Calls",
    "Divergences",
    "nativeFailed",
    "shellFailed",
    "Pending",
    ...(cancelled ? [`Cancelled (${CANCELLED_MEANING})`] : []),
    "Unobserved",
    "First row",
    "Last row",
    "Closes at",
    "Verdict",
  ];
  const lines = [
    `R81, window ${report.windowDays} d: ${report.status}`,
    "",
    `| ${columns.join(" | ")} |`,
    `|${columns.map(() => "---").join("|")}|`,
  ];
  for (const row of report.rows) {
    lines.push(
      `| ${row.hook} | ${row.engine} | ${row.gating ? "yes" : "no"} | ${row.invocations} | ` +
        `${row.divergences} | ${row.nativeFailed} | ${row.shellFailed} | ${row.pending} | ` +
        (cancelled ? `${cancelledCell(row)} | ` : "") +
        `${row.unobserved} | ${iso(row.firstMs)} | ${iso(row.lastMs)} | ${iso(row.closesMs)} | ` +
        `${row.status === "green" || row.status === "active" ? row.status : `${row.status}: ${[...row.problems, ...row.warnings].join("; ")}`} |`,
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
          : status === "green" || status === "active"
            ? status
            : `${status}: ${named.join(", ")}`;
      lines.push(`| ${name} | ${hooks.join(", ")} | ${verdict} |`);
    }
  }
  return lines.join("\n");
}

/** `--help` text. */
const USAGE = `usage: node scripts/js/hook-shadow-report.mjs [options]
  --root <dir>        project root: manifest, history and registered engines (default: cwd)
  --journals <dir>    add the journals of another checkout (repeatable)
  --window <days>     window length in days (default 7)
  --now <ISO date>    evaluate as of this instant instead of the clock; without Z or ±HH:MM it is
                      LOCAL time (Date.parse), so pass the zone
  --close-per-row     judge each hook and engine at its own first row + the window (R81 close);
                      without it no row closes and a lost observation stays amber (exit 3)
  --causes <json>     { "<hook>|<engine>|<ISO begin>": "<cause>" } for lost observations
  --batches <json>    { "<batch>": ["<hook>", ...] } for the per-batch verdict (--markdown)
  --sibling-cancel    report a Pi begin that never completed as cancelled, not lost, when a
                      sibling of the same call completed: compatible with a sibling's block,
                      INFERRED (the journal keeps no verdicts), so check each one listed
  --json | --markdown output format (default: text)
exit: 0 green or every row active, 1 red, 2 error, 3 amber`;

/** Parse `--batches`: an object of batch name to a list of hook names, or an error. */
export function parseBatches(text) {
  const batches = JSON.parse(text);
  const valid =
    batches !== null &&
    typeof batches === "object" &&
    !Array.isArray(batches) &&
    Object.values(batches).every(
      (hooks) =>
        Array.isArray(hooks) && hooks.every((hook) => typeof hook === "string" && hook !== ""),
    );
  if (!valid)
    throw new Error(
      '--batches needs a JSON object of batch to hook names: { "<batch>": ["<hook>"] }',
    );
  return batches;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(USAGE);
    process.exit(0);
  }
  // A flag given without its value is an error, never a silent default.
  const value = (flag, fallback) => {
    const at = args.indexOf(flag);
    if (at === -1) return fallback;
    const next = args[at + 1];
    if (next === undefined || next.startsWith("--")) throw new Error(`${flag} needs a value`);
    return next;
  };
  try {
    const windowDays = Number(value("--window", "7"));
    if (!Number.isFinite(windowDays) || windowDays <= 0)
      throw new Error("--window needs a positive number of days");
    const root = resolve(value("--root", process.cwd()));
    const extra = args.flatMap((arg, at) => (arg === "--journals" ? [args[at + 1]] : []));
    if (extra.some((dir) => dir === undefined || !existsSync(dir)))
      throw new Error("--journals needs an existing directory");
    const journalRoots = [...new Set([root, ...extra.map((dir) => resolve(dir))])];
    // `--now <ISO date>` evaluates the window as of that instant (the R81 close), not the clock.
    const nowArg = value("--now", undefined);
    const now = nowArg === undefined ? Date.now() : Date.parse(nowArg);
    if (!Number.isFinite(now)) throw new Error("--now needs an ISO date");
    const batchesPath = value("--batches", undefined);
    const batches =
      batchesPath === undefined ? {} : parseBatches(readFileSync(batchesPath, "utf8"));
    const causesPath = value("--causes", undefined);
    const causes = causesPath === undefined ? {} : JSON.parse(readFileSync(causesPath, "utf8"));
    const report = collect(
      root,
      windowDays,
      now,
      journalRoots,
      args.includes("--close-per-row"),
      causes,
      args.includes("--sibling-cancel"),
    );
    console.log(
      args.includes("--json")
        ? JSON.stringify(report)
        : args.includes("--markdown")
          ? formatMarkdown(report, batches)
          : format(report),
    );
    // 0 green, 1 red, 3 amber (2 is an error).
    process.exitCode = { green: 0, active: 0, red: 1, amber: 3 }[report.status];
  } catch (error) {
    console.error(`hook-shadow-report: ${error.message}`);
    process.exitCode = 2;
  }
}
