import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { readHarnessCatalog } from "../lib/audit/harness.ts";
import { findMarkedSessions } from "../lib/audit/discovery.ts";
import { parseSession } from "../lib/audit/parse.ts";
import { detectSignals, type Lang } from "../lib/audit/signals.ts";
import { buildReport, renderJson, renderMarkdown } from "../lib/audit/report.ts";
import { repoAuditDir, sessionLogPath } from "../lib/audit/paths.ts";
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

    // --start / --stop are the human-confirmed ends of the recording. The hook
    // never runs them: it only asks Claude to ask the user, and Claude runs
    // this once the user says yes.
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

    const outDir = args.out ? resolve(args.out) : auditDir;
    mkdirSync(outDir, { recursive: true });
    const stem = `audit-${report.range.from}-${report.range.to}`.replace(/[^\w.-]/g, "-");
    const mdFile = join(outDir, `${stem}.md`);
    const jsonFile = join(outDir, `${stem}.json`);
    writeFileSync(mdFile, renderMarkdown(report, lang), "utf-8");
    writeFileSync(jsonFile, renderJson(report), "utf-8");

    const high = report.signals.filter((s) => s.severity === "high").length;
    const warn = report.signals.filter((s) => s.severity === "warn").length;
    p.note(
      [
        `${report.totals.sessions} ${isEs ? "sesiones" : "sessions"} · ${report.totals.agents} ${isEs ? "agentes" : "agents"}`,
        `${isEs ? "arranque" : "startup"}  ${Math.round(report.totals.startupTokens / 1000)}k tok`,
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
