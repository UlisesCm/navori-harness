import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { readHarnessCatalog } from "../lib/audit/harness.ts";
import { findMarkedSessions } from "../lib/audit/discovery.ts";
import { attachHookEvents, parseSession } from "../lib/audit/parse.ts";
import { detectSignals, type Lang } from "../lib/audit/signals.ts";
import { buildReport, renderJson, renderMarkdown } from "../lib/audit/report.ts";
import {
  rangeReportDir,
  repoAuditDir,
  sessionLogPath,
  sessionReportDir,
} from "../lib/audit/paths.ts";
import { NavoriError } from "../lib/errors.ts";
import { resolveLang } from "../lib/i18n.ts";
import { readGlobalConfig } from "../lib/global-config.ts";
import { readCliVersion } from "../lib/bundled-assets.ts";
import { brand, color, dim } from "../lib/style.ts";

/**
 * `audit` — post-hoc report over sessions explicitly marked with audit-mode.
 *
 * Reads Claude Code's transcripts (the only place token usage exists — no hook
 * payload carries tokens) and crosses them with the repo's declared harness,
 * which is the half no external tool can produce: the transcript records the
 * SIZE of an agent's initial context but never its content.
 *
 * Strictly read-only over `~/.claude/`; every write lands under the audit root.
 */

/** Language: repo config when present, else the global harness config. */
function reportLang(cwd: string): Lang {
  const configPath = join(cwd, "navori.config.json");
  if (existsSync(configPath)) {
    try {
      const cfg: unknown = JSON.parse(readFileSync(configPath, "utf-8"));
      if (typeof cfg === "object" && cfg !== null) {
        const lang = (cfg as { language?: unknown }).language;
        if (typeof lang === "string") return resolveLang(lang) as Lang;
      }
    } catch {
      // Malformed config must not break the audit: fall through to global.
    }
  }
  return resolveLang(readGlobalConfig()?.language) as Lang;
}

/**
 * Command boundary for the audit path builders.
 *
 * They reject a repo name or session id that would compose a path outside the
 * audit root; without this the rejection would surface as citty's raw stack —
 * exactly the shape the unvalidated id used to produce (a bare ENOENT for a
 * path that had already escaped). Same pattern as `readConfigOrExit` /
 * `intFlagOrExit`: clean message, exit 1, no trace.
 */
function auditPathOrExit(build: () => string, json: boolean): string {
  try {
    return build();
  } catch (err) {
    if (err instanceof NavoriError) {
      // `--json` already reports its failures as JSON (no-marked-sessions,
      // no-transcripts); a human string here would break that contract.
      if (json) console.log(JSON.stringify({ ok: false, error: err.code, message: err.message }));
      else p.cancel(err.message);
      process.exit(1);
    }
    throw err;
  }
}

/**
 * A mode-switching flag must carry its value or stop the command.
 *
 * citty gives a `type: "string"` flag declared without a value the EMPTY STRING,
 * never `undefined`, so `--stop` alone is indistinguishable from `--stop ""` and
 * a truthiness check reads both as "flag absent". For a flag that only carries
 * data that is harmless; for one that decides WHAT the command does it is a
 * silent no-op, and the command goes on to do something else entirely.
 *
 * Rejecting here rather than inside each branch is deliberate: the branch is the
 * code that never runs when the bug fires, so a guard placed there cannot catch
 * it.
 */
function emptyFlagOrExit(value: unknown, flag: string, json: boolean, isEs: boolean): void {
  if (value !== "") return;
  const message = isEs
    ? `La bandera ${flag} necesita un id de sesión: '${flag} <id>'. Sin id no se activa ni se sella nada, así que no genero ningún reporte.`
    : `The ${flag} flag needs a session id: '${flag} <id>'. With no id nothing is activated or sealed, so no report is produced.`;
  if (json) console.log(JSON.stringify({ ok: false, error: "missing-flag-value", flag }));
  else p.cancel(message);
  process.exit(2);
}

export const auditCommand = defineCommand({
  meta: {
    name: "audit",
    description: "Report how the harness actually ran: token attribution and adherence gaps",
  },
  args: {
    cwd: { type: "string", description: "Repo to audit (default: cwd)" },
    days: { type: "string", description: "Only sessions marked in the last N days" },
    since: { type: "string", description: "Only sessions from this date (YYYY-MM-DD)" },
    until: { type: "string", description: "Only sessions up to this date (YYYY-MM-DD)" },
    session: { type: "string", description: "One session by id, prefix, or 'latest'" },
    json: { type: "boolean", description: "Print the JSON report to stdout without writing files" },
    out: { type: "string", description: "Override the output directory" },
    start: { type: "string", description: "Mark a session id as audited (used by the hook flow)" },
    stop: { type: "string", description: "Seal a session's log and report on it" },
  },
  async run({ args }) {
    const cwd = resolve(args.cwd ?? process.cwd());
    const repo = basename(cwd);
    const lang = reportLang(cwd);
    const isEs = lang === "es";
    const json = args.json === true;

    if (!json) p.intro(brand("audit"));

    // Resolved once, before anything is written: every path this command
    // produces hangs off it, so an unusable repo name fails here rather than
    // three writes later.
    const auditDir = auditPathOrExit(() => repoAuditDir(repo), json);

    // --start / --stop are the ONLY way in and out of the recording (R3): the
    // hook no longer proposes either, because no heuristic over natural language
    // separates talking ABOUT audit-mode from invoking it.
    //
    // Both are mode switches, so an empty value is rejected before anything
    // runs. citty hands a valueless `type: "string"` flag the empty string, not
    // `undefined` — so the truthiness check these guards used to do let
    // `navori audit --stop` fall through to the range report and print a
    // summary that reads exactly like a successful seal (#538-adjacent, R2).
    emptyFlagOrExit(args.start, "--start", json, isEs);
    emptyFlagOrExit(args.stop, "--stop", json, isEs);

    const startId = args.start;
    if (typeof startId === "string" && startId) {
      const logFile = auditPathOrExit(() => sessionLogPath(repo, startId), json);
      mkdirSync(auditDir, { recursive: true });
      if (existsSync(logFile)) {
        p.outro(isEs ? "audit-mode ya estaba activo" : "audit-mode was already active");
        return;
      }
      // O_APPEND from the very first line: the log is only ever appended to.
      appendFileSync(
        logFile,
        `${JSON.stringify({ ts: new Date().toISOString(), event: "start", cwd, repo, sessionId: startId })}\n`,
        "utf-8",
      );
      p.outro(
        isEs
          ? `${color.green("audit-mode activo")} ${dim(logFile)}`
          : `${color.green("audit-mode active")} ${dim(logFile)}`,
      );
      return;
    }

    const stopId = args.stop;
    if (typeof stopId === "string" && stopId) {
      const logFile = auditPathOrExit(() => sessionLogPath(repo, stopId), json);
      if (!existsSync(logFile)) {
        p.cancel(isEs ? "Esa sesión no está marcada." : "That session is not marked.");
        process.exit(2);
      }
      appendFileSync(
        logFile,
        `${JSON.stringify({ ts: new Date().toISOString(), event: "stop" })}\n`,
        "utf-8",
      );
      args.session = stopId;
    }

    const days = args.days === undefined ? undefined : Number(args.days);
    const marked = findMarkedSessions(repo, {
      days: Number.isFinite(days) ? days : undefined,
      since: args.since,
      until: args.until,
      session: args.session,
    });

    if (marked.length === 0) {
      const msg = isEs
        ? `No hay sesiones marcadas con audit-mode para '${repo}'. Escribe "audit mode" en una sesión para empezar a registrar.`
        : `No sessions marked with audit-mode for '${repo}'. Type "audit mode" in a session to start recording.`;
      if (json) console.log(JSON.stringify({ ok: false, error: "no-marked-sessions", repo }));
      else p.cancel(msg);
      process.exit(2);
    }

    const catalog = readHarnessCatalog(cwd);
    const parsed = [];
    const missing: string[] = [];
    for (const m of marked) {
      if (!m.transcript) {
        missing.push(m.sessionId.slice(0, 8));
        continue;
      }
      const session = parseSession(m.transcript);
      // The harness's own record of what its hooks did. It comes from the
      // session log, not the transcript, because a hook that runs and lets the
      // action through is invisible to the transcript by construction.
      attachHookEvents(session, m.logFile);
      session.signals = detectSignals(session, catalog, lang);
      parsed.push(session);
    }

    if (parsed.length === 0) {
      const msg = isEs
        ? `Se encontraron ${marked.length} sesiones marcadas pero ningún transcript localizable.`
        : `Found ${marked.length} marked sessions but no locatable transcript.`;
      if (json) console.log(JSON.stringify({ ok: false, error: "no-transcripts", repo }));
      else p.cancel(msg);
      process.exit(2);
    }

    const report = buildReport(parsed, { repo, version: readCliVersion(), catalog });

    if (json) {
      process.stdout.write(renderJson(report));
      return;
    }

    // One directory per audited unit (R15/R16). A single session gets
    // `sessions/<day>-<id8>/`; a report spanning several gets
    // `ranges/<from>--<to>/`. The old layout named every file by RANGE, so two
    // runs over different ranges left overlapping pairs nothing reconciled.
    //
    // `--out` still wins verbatim: it is an escape hatch for scripting, and
    // imposing the layout on an explicit destination would defeat it.
    const single = parsed.length === 1 ? parsed[0] : undefined;
    const outDir = args.out
      ? resolve(args.out)
      : auditPathOrExit(
          () =>
            single
              ? sessionReportDir(repo, single.startedAt.slice(0, 10), single.sessionId)
              : rangeReportDir(repo, report.range.from, report.range.to),
          json,
        );
    mkdirSync(outDir, { recursive: true });
    const mdFile = join(outDir, "report.md");
    const jsonFile = join(outDir, "report.json");
    writeFileSync(mdFile, renderMarkdown(report, lang), "utf-8");
    writeFileSync(jsonFile, renderJson(report), "utf-8");

    // A snapshot of the event log beside its report, so the session folder holds
    // everything about that session. It is a COPY, deliberately: the hooks write
    // `session-<id>.log` at the repo root — they run long before anyone knows
    // which day the session started, and pointing them at a dated directory
    // would make every hook depend on a name only the report can compute. The
    // original stays the append-only source of truth.
    if (single && !args.out) {
      const source = marked.find((m) => m.sessionId === single.sessionId)?.logFile;
      if (source && existsSync(source)) {
        try {
          copyFileSync(source, join(outDir, "session.log"));
        } catch {
          // A snapshot that cannot be written is not worth failing the report
          // for: the log it copies is still intact where the hooks wrote it.
        }
      }
    }
    // The range report is an index too: without it, "which sessions does this
    // aggregate cover?" is answerable only by reading the JSON.
    if (!single && !args.out) {
      writeFileSync(
        join(outDir, "sessions.txt"),
        `${parsed
          .map(
            (sess) =>
              `${sess.startedAt.slice(0, 10)}-${sess.sessionId.slice(0, 8)}\t${sess.initialPrompt.slice(0, 90)}`,
          )
          .join("\n")}\n`,
        "utf-8",
      );
    }

    const high = report.signals.filter((s) => s.severity === "high").length;
    const warn = report.signals.filter((s) => s.severity === "warn").length;
    // The summary used to lead with `startupTokens`, the SMALLEST of the three
    // numbers in the report: a run showing "346k" in the terminal had 2.3M
    // billable and 137.5M of cache_read in its body. Billable leads now, and
    // startup stays as the share it actually is.
    const billable =
      report.totals.tokens.input +
      report.totals.tokens.output +
      report.totals.tokens.cacheCreation +
      report.totals.tokens.thinking;
    const k = (n: number): string =>
      n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`;
    p.note(
      [
        `${report.totals.sessions} ${isEs ? "sesiones" : "sessions"} · ${report.totals.agents} ${isEs ? "agentes" : "agents"}`,
        `${isEs ? "facturable" : "billable"}  ${k(billable)} tok`,
        `${isEs ? "arranque" : "startup"}  ${k(report.totals.startupTokens)} tok`,
        `cache_read  ${k(report.totals.tokens.cacheRead)} tok`,
        `${isEs ? "hallazgos" : "findings"}  ${high} ${isEs ? "alto" : "high"} · ${warn} ${isEs ? "medio" : "warn"}`,
        missing.length > 0
          ? `${isEs ? "sin transcript" : "no transcript"}  ${missing.join(", ")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
      `${repo} · ${report.range.from} → ${report.range.to}`,
    );
    p.outro(`${color.green(isEs ? "Reporte" : "Report")} ${dim(mdFile)}`);
  },
});
