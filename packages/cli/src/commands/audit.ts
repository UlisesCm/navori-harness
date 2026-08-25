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
import { resolveLang } from "../lib/i18n.ts";
import { readGlobalConfig } from "../lib/global-config.ts";
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

function readVersion(): string {
  return process.env.npm_package_version ?? "0.0.0";
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

    if (!args.json) p.intro(brand("audit"));

    // --start / --stop are the human-confirmed ends of the recording. The hook
    // never runs them: it only asks Claude to ask the user, and Claude runs
    // this once the user says yes.
    if (typeof args.start === "string" && args.start) {
      const logFile = sessionLogPath(repo, args.start);
      mkdirSync(repoAuditDir(repo), { recursive: true });
      if (existsSync(logFile)) {
        p.outro(isEs ? "audit-mode ya estaba activo" : "audit-mode was already active");
        return;
      }
      // O_APPEND from the very first line: the log is only ever appended to.
      appendFileSync(
        logFile,
        `${JSON.stringify({ ts: new Date().toISOString(), event: "start", cwd, repo, sessionId: args.start })}\n`,
        "utf-8",
      );
      p.outro(
        isEs
          ? `${color.green("audit-mode activo")} ${dim(logFile)}`
          : `${color.green("audit-mode active")} ${dim(logFile)}`,
      );
      return;
    }

    if (typeof args.stop === "string" && args.stop) {
      const logFile = sessionLogPath(repo, args.stop);
      if (!existsSync(logFile)) {
        p.cancel(isEs ? "Esa sesión no está marcada." : "That session is not marked.");
        process.exit(2);
      }
      appendFileSync(
        logFile,
        `${JSON.stringify({ ts: new Date().toISOString(), event: "stop" })}\n`,
        "utf-8",
      );
      args.session = args.stop;
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
      if (args.json) console.log(JSON.stringify({ ok: false, error: "no-marked-sessions", repo }));
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
      if (args.json) console.log(JSON.stringify({ ok: false, error: "no-transcripts", repo }));
      else p.cancel(msg);
      process.exit(2);
    }

    const report = buildReport(parsed, { repo, version: readVersion(), catalog });

    if (args.json) {
      process.stdout.write(renderJson(report));
      return;
    }

    const outDir = args.out ? resolve(args.out) : repoAuditDir(repo);
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
