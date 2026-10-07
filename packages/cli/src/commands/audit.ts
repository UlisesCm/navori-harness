import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { existsSync, lstatSync, readFileSync, type Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { readHarnessCatalog, renderedHarnessVersion } from "../lib/audit/harness.ts";
import {
  type MarkedSession,
  coverageMetrics,
  findMarkedSessions,
  listAuditedRepos,
  repoCoverage,
  resolveTranscript,
  requestedRange,
  createAuditDiscoveryContext,
} from "../lib/audit/discovery.ts";
import { attachHookEvents, parseCodexSession, parseSession } from "../lib/audit/parse.ts";
import { listMarkers } from "../lib/diagnose/health.ts";
import {
  type Lang,
  detectSignals,
  mineClaudeMetrics,
  flattenMinedMetrics,
} from "../lib/audit/signals.ts";
import type { HarnessCatalog } from "../lib/audit/harness.ts";
import {
  buildSnapshot,
  compareSnapshots,
  copySnapshotTo,
  gitRootCommit,
  readSnapshot,
  renderComparison,
  writeSnapshot,
} from "../lib/audit/snapshot.ts";
import {
  buildReport,
  projectedAgentCount,
  renderJson,
  renderMarkdown,
  weightedTokens,
  publishReport,
} from "../lib/audit/report.ts";
import {
  ALL_REPOS_DIR,
  auditsRoot,
  projectRootFromCwd,
  rangeReportDir,
  repoAuditDir,
  repoFromCwd,
  sessionLogPath,
  sessionReportDir,
  snapshotPath,
  ensurePrivateAuditDirectory,
  createPrivateAuditFile,
  appendPrivateAuditFile,
  removePrivateAuditFile,
  readPrivateAuditFile,
  replacePrivateAuditFile,
  type PrivateAuditResult,
} from "../lib/audit/paths.ts";
import { startReceiver, type OtelReceiver } from "../lib/audit/collect.ts";
import {
  captureCodexChild,
  recordAuditMetadata,
  absorbAuditMetadataSpool,
  readAuditHeaderFromFd,
  matchesAuditHeaderIdentity,
} from "../lib/audit/cli-event.ts";
import { NavoriError } from "../lib/primitives/errors.ts";
import { resolveLang } from "../lib/i18n.ts";
import { readGlobalConfig } from "../lib/config/global-config.ts";
import { readCliVersion } from "../lib/render/bundled-assets.ts";
import { brand, color, dim } from "../lib/primitives/style.ts";

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

/** `audit.mode` of the repo's config, `unknown` when it cannot be read: R43 requires it equal across windows. */
function auditModeOf(cwd: string): "opt-in" | "always" | "unknown" {
  try {
    const cfg: unknown = JSON.parse(readFileSync(join(cwd, "navori.config.json"), "utf-8"));
    const audit = (cfg as { audit?: { mode?: unknown } } | null)?.audit;
    // The schema defaults a declared config without `audit` to opt-in.
    const mode = audit?.mode ?? "opt-in";
    return mode === "always" ? "always" : mode === "opt-in" ? "opt-in" : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Declared agents whose file carries a navori managed marker (R47) — the same
 * witness of provenance `readHarnessCatalog` uses for skills, since a name proves
 * nothing. Read here, not in the pure report module.
 */
function managedAgentNames(cwd: string, agents: Array<{ name: string }>): string[] {
  return agents
    .filter((a) => listMarkers(join(cwd, ".claude", "agents", `${a.name}.md`)).length > 0)
    .map((a) => a.name)
    .sort();
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
function auditPathOrExit<T = string>(build: () => T, json: boolean): T {
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
    ? `${flag} necesita un id de sesión: '${flag} <id>'. Sin id no activo/sello ni genero reporte.`
    : `${flag} needs a session id: '${flag} <id>'. No id means no start/seal/report.`;
  if (json) console.log(JSON.stringify({ ok: false, error: "missing-flag-value", flag }));
  else p.cancel(message);
  process.exit(2);
}

/**
 * Which marked session `--stop` should seal, when no log is named exactly.
 *
 * The report tells the reader to seal with `navori audit --stop <id8>` — the
 * truncated id it prints in its own header — and that advice could never work
 * while `--stop` composed the log name from the literal value: the file carries
 * the FULL uuid, so an 8-char prefix named nothing and the command exited 2
 * every single time (finding A1). `--session` had accepted prefixes since it
 * shipped; resolution goes through the same `findMarkedSessions` so the two
 * flags cannot drift apart on what an id means.
 *
 * A prefix matching several sessions is an ERROR, never a pick: `stop` is an
 * append to an append-only log, so sealing the wrong session is a write nobody
 * can take back. Both failure paths exit 2 — this function never returns
 * normally unless the match was unique.
 */
/** Refuse unsafe history without repairing it or exposing its contents. */
function privateResultOrExit<T>(result: PrivateAuditResult<T>, json: boolean): T {
  if (result.ok) return result.value;
  if (json)
    process.stdout.write(
      JSON.stringify({ ok: false, error: "unsafe-audit-target", reason: result.reason }) + "\n",
    );
  else p.cancel("unsafe-audit-target: " + result.reason);
  return process.exit(2);
}

/** Validate the marker on the descriptor that will receive the lifecycle append. */
function lifecycleAppend(
  path: string,
  id: string,
  repo: string,
  cwd: string,
  host: "claude" | "codex" | undefined,
  line: string,
): PrivateAuditResult<number> {
  return appendPrivateAuditFile(path, (fd: number): string => {
    const header = readAuditHeaderFromFd(fd);
    const declared = header?.host === undefined ? "claude" : header.host;
    const selected = host ?? declared;
    if (
      !header ||
      (selected !== "claude" && selected !== "codex") ||
      !matchesAuditHeaderIdentity(header, selected, id, repo, cwd)
    )
      throw new Error("identity-conflict");
    return line;
  });
}

function resolveStopTarget(
  repo: string,
  stopId: string,
  json: boolean,
  isEs: boolean,
): { logFile: string; sessionId: string } {
  const matches = findMarkedSessions(repo, { session: stopId });
  const [only] = matches;
  if (only && matches.length === 1) return { logFile: only.logFile, sessionId: only.sessionId };

  if (matches.length === 0) {
    if (json) {
      console.log(JSON.stringify({ ok: false, error: "session-not-marked", session: stopId }));
    } else {
      p.cancel(isEs ? "Esa sesión no está marcada." : "That session is not marked.");
    }
    process.exit(2);
  }

  const ids = matches.map((m) => m.sessionId);
  if (json) {
    console.log(
      JSON.stringify({
        ok: false,
        error: "ambiguous-session-prefix",
        prefix: stopId,
        matches: ids,
      }),
    );
  } else {
    p.cancel(
      isEs
        ? `Prefijo '${stopId}' ambiguo: ${ids.length} sesiones (${ids.join(", ")}). No sello; usa un prefijo único.`
        : `Prefix '${stopId}' ambiguous: ${ids.length} sessions (${ids.join(", ")}). Nothing sealed; use a unique prefix.`,
    );
  }
  process.exit(2);
}

/**
 * One catalog for a range that spans repos: the current repo's, widened with
 * the agents and skills every other audited repo declares, so an agent that
 * ran in another repo is not reported as undeclared. Managed skills are
 * dropped — "managed and unused" only has a meaning inside one repo.
 */
function mergeCatalogs(base: HarnessCatalog, others: HarnessCatalog[]): HarnessCatalog {
  const agents = new Map(base.agents.map((a) => [a.name, a]));
  const skills = new Set(base.skills);
  for (const c of others) {
    for (const a of c.agents) if (!agents.has(a.name)) agents.set(a.name, a);
    for (const sk of c.skills) skills.add(sk);
  }
  return { ...base, agents: [...agents.values()], skills: [...skills], managedSkills: [] };
}

/** Read one bounded UTF-8 document; nothing is persisted before EOF. */
async function readMetadataInput(): Promise<unknown> {
  const bytes = Buffer.alloc(2049);
  let length = 0;
  while (length < bytes.length) {
    const chunk: unknown = process.stdin.read(
      Math.min(bytes.length - length, process.stdin.readableLength || bytes.length - length),
    );
    if (chunk === null && process.stdin.readableEnded) {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
      return JSON.parse(text) as unknown;
    }
    if (chunk === null) {
      await new Promise<void>((resolveRead, rejectRead) => {
        const cleanup = (): void => {
          process.stdin.off("readable", ready);
          process.stdin.off("end", ready);
          process.stdin.off("error", failed);
        };
        const ready = (): void => {
          cleanup();
          resolveRead();
        };
        const failed = (error: Error): void => {
          cleanup();
          rejectRead(error);
        };
        process.stdin.once("readable", ready);
        process.stdin.once("end", ready);
        process.stdin.once("error", failed);
      });
    } else if (Buffer.isBuffer(chunk)) {
      chunk.copy(bytes, length);
      length += chunk.length;
    } else throw new Error("metadata-input-type");
  }
  throw new Error("metadata-input-limit");
}

/** Exclusive, silent noninteractive bridge to the existing private writer. */
async function recordMetadataAction(args: Readonly<Record<string, unknown>>): Promise<void> {
  process.exitCode = 2;
  const conflicts = [
    "consume-arm",
    "capture-child",
    "rollout",
    "start",
    "stop",
    "arm",
    "disarm",
    "collect",
    "session",
    "days",
    "since",
    "until",
    "out",
    "all-repos",
    "snapshot",
    "copy-to",
    "compare",
    "json",
    "include-human-content",
  ];
  const host = args.host;
  const rootSessionId = args["root-session"];
  const repo = args.repo;
  const auditRoot = args.root;
  if (
    args["record-metadata"] !== true ||
    conflicts.some((key) => args[key] !== undefined) ||
    (host !== "claude" && host !== "codex") ||
    typeof rootSessionId !== "string" ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(rootSessionId) ||
    typeof repo !== "string" ||
    !/^[A-Za-z0-9_.-]{1,256}$/.test(repo) ||
    repo === "." ||
    repo === ".." ||
    typeof auditRoot !== "string" ||
    !isAbsolute(auditRoot)
  )
    return;
  try {
    const result = recordAuditMetadata({
      host,
      rootSessionId,
      repo,
      auditRoot,
      event: await readMetadataInput(),
    });
    if (["recorded", "spooled", "skipped"].includes(result.status)) process.exitCode = 0;
  } catch {
    // Invalid input/read failures stay silent and cannot select another action.
  }
}

/** Read complete private arm payload and capture its stable observable generation. */
function readArm(file: string, cwd: string, root: string): Stats | null {
  const identity = lstatSync(file);
  const read = readPrivateAuditFile(file, { ownedRoot: resolve(root), maxBytes: 2048 });
  if (!read.ok) return null;
  const text = new TextDecoder("utf-8", { fatal: true }).decode(read.value);
  if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) return null;
  const arm: unknown = JSON.parse(text);
  if (!arm || typeof arm !== "object" || Array.isArray(arm)) return null;
  const payload = arm as Record<string, unknown>;
  if (
    Object.keys(payload).length !== 2 ||
    typeof payload.ts !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(payload.ts) ||
    !Number.isFinite(Date.parse(payload.ts)) ||
    typeof payload.cwd !== "string" ||
    !isAbsolute(payload.cwd) ||
    resolve(projectRootFromCwd(payload.cwd)) !== resolve(projectRootFromCwd(cwd))
  )
    return null;
  const current = lstatSync(file);
  if (
    current.dev !== identity.dev ||
    current.ino !== identity.ino ||
    current.size !== identity.size
  )
    return null;
  return identity;
}

/** Serialize cooperating consumers with an exclusive private claim, fresh generation
 * validation and own-token cleanup before start. Crashes conservatively retain claims;
 * trusted-local-writer and ABA limits remain those of the existing private helpers. */
function consumeArm(args: Readonly<Record<string, unknown>>): boolean {
  const { start, host, cwd, root } = args;
  if (
    args["consume-arm"] !== true ||
    typeof start !== "string" ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(start) ||
    (host !== "claude" && host !== "codex") ||
    typeof cwd !== "string" ||
    !isAbsolute(cwd) ||
    Buffer.byteLength(cwd) > 2048 ||
    typeof root !== "string" ||
    !isAbsolute(root) ||
    resolve(root) !== auditsRoot() ||
    Object.keys(args).some(
      (key) =>
        key !== "_" &&
        !["consume-arm", "start", "host", "cwd", "root"].includes(key) &&
        args[key] !== undefined,
    )
  )
    return false;
  try {
    const file = join(repoAuditDir(repoFromCwd(cwd)), ".armed");
    const original = readArm(file, cwd, root);
    if (!original) return false;
    const claim = `${file}.claim`;
    const token = `${randomUUID()}\n`;
    const options = { ownedRoot: resolve(root) };
    if (!createPrivateAuditFile(claim, token, options).ok) return false;
    let claimed: Stats | undefined;
    let consumed = false;
    let released = false;
    try {
      claimed = lstatSync(claim);
      const current = readArm(file, cwd, root);
      if (
        current &&
        current.dev === original.dev &&
        current.ino === original.ino &&
        current.size === original.size
      )
        consumed = removePrivateAuditFile(file, { ...options, expectedIdentity: original }).ok;
    } finally {
      try {
        const content = readPrivateAuditFile(claim, { ...options, maxBytes: 2048 });
        released =
          claimed !== undefined &&
          content.ok &&
          content.value.equals(Buffer.from(token)) &&
          removePrivateAuditFile(claim, { ...options, expectedIdentity: claimed }).ok;
      } catch {
        /* Failed cleanup never authorizes start or another claim's removal. */
      }
    }
    return consumed && released;
  } catch {
    return false;
  }
}

/** Audit reports and exclusive internal metadata transport actions. */
export const auditCommand = defineCommand({
  meta: {
    name: "audit",
    description: "Report harness tokens and adherence gaps",
  },
  args: {
    "consume-arm": {
      type: "boolean",
      description: "Consume private arm; requires start/host/cwd/root",
    },
    "include-human-content": {
      type: "boolean",
      description: "Human content in private reports, this call only",
    },
    "record-metadata": {
      type: "boolean",
      description: "Bounded internal metadata from stdin",
    },
    repo: { type: "string", description: "Exact metadata repo" },
    root: { type: "string", description: "Absolute private audit root" },
    cwd: { type: "string", description: "Repo to audit (default: cwd)" },
    days: { type: "string", description: "Last N days of marked sessions" },
    since: { type: "string", description: "From YYYY-MM-DD" },
    until: { type: "string", description: "Through YYYY-MM-DD" },
    session: { type: "string", description: "Session id, prefix, or 'latest'" },
    json: { type: "boolean", description: "JSON stdout; no files" },
    out: { type: "string", description: "Output directory" },
    start: { type: "string", description: "Start auditing this session id" },
    "capture-child": {
      type: "string",
      description: "Exact Codex child; opted-in root log",
    },
    "root-session": {
      type: "string",
      description: "Exact child/metadata root session; no inference",
    },
    rollout: { type: "string", description: "Exact --capture-child rollout source" },
    host: {
      type: "string",
      description: "claude/codex; metadata/consumption requires it; start: claude",
    },
    stop: {
      type: "string",
      description: "Seal/report id, unique prefix, or 'latest'",
    },
    arm: {
      type: "boolean",
      description: "Arm once for next repo message/session; hook consumes/starts",
    },
    disarm: {
      type: "boolean",
      description: "Cancel pending arm; no start",
    },
    "all-repos": {
      type: "boolean",
      description: "All-repo range report with per-repo coverage",
    },
    snapshot: {
      type: "string",
      description: "Named versioned range snapshot in audit root",
    },
    "copy-to": {
      type: "string",
      description: "Copy --snapshot here, relative to git root; no overwrite",
    },
    compare: {
      type: "string",
      description: "Compare snapshot metrics to range",
    },
    collect: {
      type: "boolean",
      description: "Receive OTel until interrupted; show address/output/export env",
    },
  },
  async run({ args }) {
    const consuming = args["consume-arm"] !== undefined;
    if (consuming && !consumeArm(args)) {
      process.exitCode = 2;
      return;
    }
    if (
      !consuming &&
      (args["record-metadata"] !== undefined || args.repo !== undefined || args.root !== undefined)
    ) {
      await recordMetadataAction(args);
      return;
    }
    const cwd = resolve(args.cwd ?? process.cwd());
    const lang = reportLang(cwd);
    const isEs = lang === "es";
    const json = args.json === true;
    if (
      [args.start, args.stop, args.out].some(
        (value) => value !== undefined && typeof value !== "string",
      ) ||
      [args.arm, args.disarm].some((value) => value !== undefined && typeof value !== "boolean")
    )
      process.exit(2);
    if (
      args["include-human-content"] !== undefined &&
      (typeof args["include-human-content"] !== "boolean" ||
        (args["include-human-content"] === true &&
          ["collect", "capture-child", "root-session", "rollout"].some(
            (key) => args[key] !== undefined,
          )))
    ) {
      process.exit(2);
    }

    // Registration is a separate metadata-only action, before any collector or report writer.
    if ([args["capture-child"], args["root-session"], args.rollout].some((v) => v !== undefined)) {
      const thread = args["capture-child"];
      const root = args["root-session"];
      const rollout = args.rollout;
      const incompatible = [
        args.start,
        args.stop,
        args.arm,
        args.disarm,
        args.collect,
        args.session,
        args.days,
        args.since,
        args.until,
        args.out,
        args.host,
        args["include-human-content"],
        args["all-repos"],
        args.snapshot,
        args["copy-to"],
        args.compare,
      ].some((value) => value !== undefined && value !== false);
      if (!thread?.trim() || !root?.trim() || !rollout?.trim() || incompatible) {
        if (json) console.log(JSON.stringify({ ok: false, error: "capture-flags-conflict" }));
        else
          p.cancel(
            "--capture-child requires --root-session and --rollout, without other audit actions.",
          );
        process.exit(2);
      }
      const captured = captureCodexChild(cwd, root, thread, rollout);
      if (json) console.log(JSON.stringify(captured));
      else if (captured.ok) p.log.success(captured.reason);
      else p.cancel(captured.reason);
      if (!captured.ok) process.exit(2);
      return;
    }

    if (!json) p.intro(brand("audit"));

    // --collect is checked BEFORE the repo is resolved from cwd, and before
    // anything below it. The receiver is global — one process serving every
    // repo, routing each event by session id (`collect.ts`) — so it never
    // needs `repo`, and under launchd the cwd is `/`: `repoFromCwd("/")`
    // returns "" (an empty basename), which `repoAuditDir` rejects as
    // `invalid-repo-name`. That used to run first and made every launchd
    // start crash-loop before the receiver ever opened its port.
    if (args.collect === true) {
      let receiver: OtelReceiver;
      try {
        receiver = await startReceiver({});
      } catch (err) {
        // R5: the address was taken. Exit naming it, with nothing written —
        // the usual cause is a previous --collect still alive, and truncating
        // its output would destroy the session it is recording.
        if (err instanceof NavoriError) {
          p.cancel(err.message);
          process.exit(1);
        }
        throw err;
      }

      // R1: the address AND the store. The store is not decoration — events
      // are appended to the log of the session each one names, in whichever
      // repo that session belongs to, so what the operator has to see is the
      // root the scan covers, not this repo's directory.
      p.log.success(
        isEs
          ? `escuchando en ${color.cyan(receiver.url)}`
          : `listening on ${color.cyan(receiver.url)}`,
      );
      p.log.message(
        (isEs
          ? "los eventos se agregan al log de cada sesión marcada bajo "
          : "events are appended to each marked session's log under ") + dim(auditsRoot()),
      );
      p.note(
        [
          "export CLAUDE_CODE_ENABLE_TELEMETRY=1",
          "export OTEL_LOGS_EXPORTER=otlp",
          "export OTEL_METRICS_EXPORTER=none",
          "export OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json",
          `export OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=${receiver.url}`,
          "export OTEL_LOGS_EXPORT_INTERVAL=1000",
        ].join("\n"),
        isEs
          ? "exporta esto en la terminal donde abres claude (el receptor solo habla http/json)"
          : "export this in the terminal where you open claude (the receiver only speaks http/json)",
      );
      p.log.message(isEs ? "Ctrl-C para cortar" : "Ctrl-C to stop");

      let stop: () => void = (): void => {};
      try {
        await new Promise<void>((done) => {
          stop = (): void => done();
          process.once("SIGINT", stop);
          process.once("SIGTERM", stop);
        });
      } finally {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
        await receiver.close();
      }

      const stats = receiver.stats();
      p.outro(
        isEs
          ? `${stats.written} eventos de ${stats.sessions} sesión(es), ${stats.discarded} descartados`
          : `${stats.written} events from ${stats.sessions} session(s), ${stats.discarded} discarded`,
      );
      return;
    }

    const allRepos = args["all-repos"] === true;
    const snapshotName = args.snapshot;
    const copyTo = args["copy-to"];
    const comparePath = args.compare;
    const human = args["include-human-content"];
    const flagError = (code: string, es: string, en: string): never => {
      if (json) console.log(JSON.stringify({ ok: false, error: code }));
      else p.cancel(isEs ? es : en);
      return process.exit(2);
    };
    if (human !== undefined && typeof human !== "boolean")
      flagError("invalid-human-content", "Bandera inválida.", "Invalid flag.");
    if (
      human === true &&
      (json ||
        snapshotName !== undefined ||
        copyTo !== undefined ||
        comparePath !== undefined ||
        args.start !== undefined ||
        args.stop !== undefined ||
        args.arm !== undefined ||
        args.disarm !== undefined ||
        args.collect !== undefined)
    )
      flagError(
        "human-content-conflict",
        "El contenido humano requiere archivos privados de reporte.",
        "Human content requires private report files.",
      );
    for (const [flag, value] of [
      ["--snapshot", snapshotName],
      ["--copy-to", copyTo],
      ["--compare", comparePath],
    ] as const) {
      if (value === "") {
        flagError(
          "missing-flag-value",
          `La bandera ${flag} necesita un valor.`,
          `The ${flag} flag needs a value.`,
        );
      }
    }
    if (copyTo && !snapshotName) {
      flagError(
        "copy-to-needs-snapshot",
        "--copy-to requiere --snapshot <nombre>.",
        "--copy-to requires --snapshot <name>.",
      );
    }
    if (json && snapshotName) {
      flagError(
        "json-with-snapshot",
        "--json no escribe archivos; incompatible con --snapshot.",
        "--json writes no files; incompatible with --snapshot.",
      );
    }
    if (
      allRepos &&
      (args.session ||
        args.start !== undefined ||
        args.stop !== undefined ||
        args.arm === true ||
        args.disarm === true)
    ) {
      flagError(
        "all-repos-conflict",
        "--all-repos: rango únicamente; incompatible con --session/--start/--stop/--arm/--disarm.",
        "--all-repos: range only; incompatible with --session/--start/--stop/--arm/--disarm.",
      );
    }
    // Read before anything is generated: a bad path should cost nothing.
    const baseSnapshot = comparePath
      ? auditPathOrExit(() => readSnapshot(resolve(cwd, comparePath)), json)
      : undefined;

    const repo = repoFromCwd(cwd);
    // Resolved once, before anything is written: every path this command
    // produces hangs off it, so an unusable repo name fails here rather than
    // three writes later.
    const auditDir = auditPathOrExit(() => repoAuditDir(repo), json);

    // --arm / --disarm (#597): activation WITHOUT passing through the model's
    // attention. "Do it in audit mode" inside a task prompt loses to the task —
    // measured in the field: the agent loaded resolve-ticket and started the
    // pipeline, and the user had to interrupt to get `--start` run. Arming is
    // explicit and happens OUTSIDE the session (a terminal command before
    // opening it), so it does not resurrect the natural-language detection R3
    // removed. The SessionStart hook consumes the flag and calls --start with
    // the id only IT knows; consumption-first means the flag arms exactly ONE
    // session, never "every session from now on".
    if (args.arm === true) {
      const armedFile = join(auditDir, ".armed");
      privateResultOrExit(ensurePrivateAuditDirectory(auditDir), json);
      if (existsSync(armedFile)) {
        privateResultOrExit(readPrivateAuditFile(armedFile, { maxBytes: 2048 }), json);
        p.outro(
          isEs
            ? "ya estaba armado: una vez, próximo mensaje/sesión; --disarm cancela"
            : "already armed: once, next message/session; --disarm cancels",
        );
        return;
      }
      privateResultOrExit(
        createPrivateAuditFile(
          armedFile,
          `${JSON.stringify({ ts: new Date().toISOString(), cwd })}\n`,
        ),
        json,
      );
      p.outro(
        isEs
          ? `${color.green("armado")}: audit-mode una sesión, próximo mensaje/apertura; navori audit --disarm cancela`
          : `${color.green("armed")}: audit-mode one session, next message/opening; navori audit --disarm cancels`,
      );
      return;
    }
    if (args.disarm === true) {
      const armedFile = join(auditDir, ".armed");
      const removed = removePrivateAuditFile(armedFile);
      if (removed.ok) {
        p.outro(isEs ? "desarmado" : "disarmed");
      } else {
        if (removed.reason !== "missing") privateResultOrExit(removed, json);
        p.outro(isEs ? "no había nada armado" : "nothing was armed");
      }
      return;
    }

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
      // The host is declared by the caller (a hook knows which engine it runs
      // in), never inferred from the environment: a wrong guess would file a
      // Claude session as Codex and drop its transcript metrics (R71).
      const hostArg = args.host;
      if (hostArg !== undefined && hostArg !== "claude" && hostArg !== "codex") {
        const message = isEs
          ? `--host acepta 'claude' o 'codex', recibí '${hostArg}'.`
          : `--host accepts 'claude' or 'codex', got '${hostArg}'.`;
        if (json) console.log(JSON.stringify({ ok: false, error: "invalid-host", message }));
        else p.cancel(message);
        process.exit(2);
      }
      const logFile = auditPathOrExit(() => sessionLogPath(repo, startId), json);
      privateResultOrExit(ensurePrivateAuditDirectory(auditDir), json);
      if (existsSync(logFile)) {
        privateResultOrExit(
          lifecycleAppend(logFile, startId, repo, cwd, hostArg ?? "claude", ""),
          json,
        );
        p.outro(isEs ? "audit-mode ya estaba activo" : "audit-mode was already active");
        return;
      }
      // O_APPEND from the very first line: the log is only ever appended to.
      //
      // The two navori versions are stamped HERE, at marking time, because this
      // is the only instant at which both are true of the session: the report
      // runs later — sometimes releases later — and any version it read off disk
      // would describe its own moment, not the session's.
      privateResultOrExit(
        createPrivateAuditFile(
          logFile,
          `${JSON.stringify({
            ts: new Date().toISOString(),
            event: "start",
            cwd,
            repo,
            sessionId: startId,
            ...(hostArg ? { host: hostArg } : {}),
            navoriRendered: renderedHarnessVersion(cwd),
            navoriCli: readCliVersion(),
          })}\n`,
        ),
        json,
      );
      // Only the bounded metadata protocol can be consumed; legacy or partial
      // startup content remains untouched and produces a visible coverage gap.
      const absorbed = absorbAuditMetadataSpool({
        host: hostArg ?? "claude",
        rootSessionId: startId,
        repo,
        auditRoot: auditsRoot(),
      });
      if (!absorbed.fullyAbsorbed) p.log.warn("audit-observation-gap: startup-spool-retained");
      // #675: the id is only checked for SHAPE (`SESSION_ID_RE`, which exists
      // to stop traversal and does that well). Nothing checked that it names a
      // real session, so a typo — `--start p` — answered "audit-mode active"
      // and left a log that can never produce a report, while the repo it sits
      // in starts counting as audited.
      //
      // A WARNING and not a failure, on measured grounds: across this repo's
      // own store the transcript exists by the time `--start` runs (same second
      // for a fresh session, earlier for a resumed one), so this does not fire
      // on the hook flow — but the margin is one second, and refusing to mark a
      // session because a file is late would be a worse trade than one line of
      // noise.
      // Codex keeps no Claude transcript, so its absence is not a typo signal.
      if (hostArg !== "codex" && !resolveTranscript(startId, cwd)) {
        p.log.warn(
          isEs
            ? `No encontré transcript para '${startId}': puede tardar al abrir. Un id incorrecto no genera reporte; borra su log manualmente: ${logFile}`
            : `No transcript found for '${startId}': may be late on opening. Wrong ids cannot report; delete their log manually: ${logFile}`,
        );
      }
      p.outro(
        isEs
          ? `${color.green("audit-mode activo")} ${dim(logFile)}`
          : `${color.green("audit-mode active")} ${dim(logFile)}`,
      );
      return;
    }

    const stopId = args.stop;
    if (typeof stopId === "string" && stopId) {
      // The shape guard runs FIRST, on the raw value: it is what keeps a
      // path-shaped id out of a filename (#503), and the prefix resolution
      // below would soften that rejection into a plain "not marked".
      const exact = auditPathOrExit(() => sessionLogPath(repo, stopId), json);
      // A full id keeps naming its log directly; anything else — starting with
      // the 8-char id the report itself prints — is resolved as a prefix.
      const target = existsSync(exact)
        ? { logFile: exact, sessionId: stopId }
        : resolveStopTarget(repo, stopId, json, isEs);
      // The versions are re-read HERE, not copied from `start`: a rollout
      // merged mid-session moves the harness under a run already in flight, and
      // a single stamp cannot say so. The parser keeps this pair only when one
      // of the two moved.
      const stopHost = args.host;
      if (stopHost !== undefined && stopHost !== "claude" && stopHost !== "codex")
        flagError("invalid-host", "Host inválido.", "Invalid host.");
      privateResultOrExit(
        lifecycleAppend(
          target.logFile,
          target.sessionId,
          repo,
          cwd,
          stopHost === "claude" || stopHost === "codex" ? stopHost : undefined,
          `${JSON.stringify({
            ts: new Date().toISOString(),
            event: "stop",
            navoriRendered: renderedHarnessVersion(cwd),
            navoriCli: readCliVersion(),
          })}\n`,
        ),
        json,
      );
      // The RESOLVED id, not the prefix: the report that follows must describe
      // the session that was just sealed and no other.
      args.session = target.sessionId;
    }

    const days = args.days === undefined ? undefined : Number(args.days);
    const periodFilters = {
      days: Number.isFinite(days) ? days : undefined,
      since: args.since,
      until: args.until,
      range: requestedRange({
        days: Number.isFinite(days) ? days : undefined,
        since: args.since,
        until: args.until,
      }),
    };
    const filters = { ...periodFilters, session: args.session };
    // Which repo each marked session belongs to matters only for `--all-repos`,
    // where it picks the catalog the session is judged against.
    const readContext = createAuditDiscoveryContext();
    const audited = allRepos ? listAuditedRepos(periodFilters, readContext) : undefined;
    const marked: MarkedSession[] = audited
      ? audited.repos.flatMap((r) => findMarkedSessions(r.repo, periodFilters, true, readContext))
      : findMarkedSessions(repo, filters, true, readContext);
    const scopeLabel = allRepos ? "--all-repos" : repo;
    if (!json) for (const w of audited?.warnings ?? []) p.log.warn(w);

    if (marked.length === 0 && args.session) {
      const msg = isEs
        ? `No hay sesiones marcadas con audit-mode para '${scopeLabel}'. Actívalo con 'navori audit --start <id-de-sesión>'.`
        : `No sessions marked with audit-mode for '${scopeLabel}'. Activate it with 'navori audit --start <session-id>'.`;
      if (json)
        console.log(JSON.stringify({ ok: false, error: "no-marked-sessions", repo: scopeLabel }));
      else p.cancel(msg);
      process.exit(2);
    }

    const catalog = readHarnessCatalog(cwd);
    // `--all-repos`: each session is judged against the harness of ITS repo
    // (read once per root); a root that no longer exists falls back to this one.
    const catalogs = new Map<string, HarnessCatalog>();
    const catalogOf = (m: MarkedSession): HarnessCatalog => {
      if (!allRepos || !m.cwd) return catalog;
      const root = projectRootFromCwd(m.cwd);
      if (!existsSync(root)) return catalog;
      const known = catalogs.get(root) ?? readHarnessCatalog(root);
      catalogs.set(root, known);
      return known;
    };
    const parsed = [];
    const missing: string[] = [];
    const sourceProblems: Array<{ sessionId: string; status: MarkedSession["sourceStatus"] }> = [];
    const registeredOwners = new Set(
      marked.flatMap((marker) =>
        (marker.childSources ?? [])
          .filter((child) => child.sourceStatus === "verified")
          .map((child) =>
            JSON.stringify([marker.cwd ? projectRootFromCwd(marker.cwd) : null, child.threadId]),
          ),
      ),
    );
    for (const m of marked) {
      if (
        m.host === "codex" &&
        m.sourceStatus === "verified" &&
        registeredOwners.has(
          JSON.stringify([m.cwd ? projectRootFromCwd(m.cwd) : null, m.sessionId]),
        )
      )
        continue;
      if (m.sourceStatus !== "verified") {
        missing.push(m.sessionId.slice(0, 8));
        sourceProblems.push({ sessionId: m.sessionId, status: m.sourceStatus });
        continue;
      }
      if (!m.transcript) {
        // A Codex session has no transcript by design (R71): it is reported from
        // its log, not listed as an orphan.
        const codex =
          m.host === "codex"
            ? parseCodexSession(
                m.sessionId,
                m.logFile,
                m.rollout,
                m.hostProvenance === "recovered:rollout" ? m.hostProvenance : undefined,
                {
                  records: m.auditLogRecords ?? [],
                  reading: m.auditReading,
                  normalizationLoss: m.auditNormalizationLoss,
                  budget: readContext.budget,
                  children: m.childSources ?? [],
                },
              )
            : null;
        if (codex) {
          parsed.push(codex);
          continue;
        }
        missing.push(m.sessionId.slice(0, 8));
        continue;
      }
      const session = parseSession(m.transcript, readContext.budget);
      // The harness's own record of what its hooks did. It comes from the
      // session log, not the transcript, because a hook that runs and lets the
      // action through is invisible to the transcript by construction.
      attachHookEvents(session, m.logFile, {
        records: m.auditLogRecords ?? [],
        reading: m.auditReading,
        normalizationLoss: m.auditNormalizationLoss,
        budget: readContext.budget,
      });
      session.signals = detectSignals(session, catalogOf(m), lang);
      parsed.push(session);
    }

    if (parsed.length === 0 && args.session) {
      const msg = isEs
        ? `Se encontraron ${marked.length} sesiones marcadas pero ningún transcript localizable.`
        : `Found ${marked.length} marked sessions but no locatable transcript.`;
      // Naming them is the difference between "something is wrong with this
      // repo" and "these three logs are orphans": the ids are what a caller
      // needs to go delete, and the previous payload made the reader re-derive
      // them from the store by hand.
      if (json)
        console.log(
          JSON.stringify({
            ok: false,
            error: "no-transcripts",
            repo,
            orphanSessions: missing,
            sourceProblems,
          }),
        );
      else p.cancel(msg);
      process.exit(2);
    }

    // Provenance defines the Claude population, including missing Claude
    // sources; failed Codex rollouts never become missing Claude transcripts.
    const mined = marked
      .filter((m) => m.host === "claude")
      .map((m) => ({
        sessionId: m.sessionId,
        host: m.host,
        transcript: m.sourceStatus === "verified" ? m.transcript : null,
        cwd: m.cwd,
      }));
    const mining = mineClaudeMetrics(mined, readContext.budget);
    const minedMetrics = flattenMinedMetrics(mining, readContext.budget);
    // Coverage has no meaning for a single session: its denominator is a period.
    const coverageRows = audited
      ? audited.repos
      : args.session
        ? []
        : [repoCoverage(repo, periodFilters, cwd, readContext).row];
    if (!audited && !args.session && !json) {
      const { warning } = repoCoverage(repo, periodFilters, undefined, readContext);
      if (warning) p.log.warn(warning);
    }

    const report = buildReport(parsed, {
      readBudget: readContext.budget,
      repo: allRepos ? "all-repos" : repo,
      version: readCliVersion(),
      catalog: audited ? mergeCatalogs(catalog, [...catalogs.values()]) : catalog,
      extraMetrics: {
        ...(coverageRows.length > 0 ? coverageMetrics(coverageRows) : {}),
        ...minedMetrics.metrics,
      },
      extraAvailability: minedMetrics.availability,
      repos: audited?.repos.map((r) => ({ repo: r.repo, audited: r.audited, host: r.host })),
      // #675: the human note already printed these; `--json` could not see them
      // at all, which is the half a CI or an agent reads.
      orphanSessions: missing,
      // Unused-managed candidates are relative to ONE repo's managed set; across
      // repos they would call a skill idle that another repo's sessions used.
      managedAgents: allRepos ? [] : managedAgentNames(cwd, catalog.agents),
      // #778: the harness ON DISK now, against which every session's own stamp
      // is judged. Read here — the same `cwd` `--start` stamps from — so the
      // report module stays pure over parsed sessions.
      harnessVersion: renderedHarnessVersion(cwd),
      lang,
      requestedRange: args.session ? undefined : periodFilters.range,
      coverage: args.session ? undefined : coverageRows,
    });
    const reportPayload = { ...report, sourceProblems };

    // Frozen once, from the same report the files render. `--compare` alone
    // writes nothing: it reads the base and prints (or, with `--json`, attaches)
    // the comparison, which is never persisted in the range's own files.
    const snapshot =
      snapshotName || baseSnapshot
        ? buildSnapshot(report, {
            scope: allRepos ? "all" : "repo",
            rootCommit: allRepos ? null : gitRootCommit(projectRootFromCwd(cwd)),
            auditMode: auditModeOf(cwd),
          })
        : undefined;
    if (snapshotName)
      auditPathOrExit(
        () =>
          snapshotPath(
            allRepos ? null : repo,
            snapshotName,
            report.range.from.slice(0, 10),
            report.range.to.slice(0, 10),
          ),
        json,
      );

    if (json) {
      process.stdout.write(
        renderJson(
          baseSnapshot && snapshot
            ? { ...reportPayload, comparison: compareSnapshots(baseSnapshot, snapshot) }
            : reportPayload,
        ),
      );
      return;
    }

    // One directory per audited unit (R15/R16). A single session gets
    // `sessions/<day>-<id8>/`; a report spanning several gets
    // `ranges/<from>--<to>/`. The old layout named every file by RANGE, so two
    // runs over different ranges left overlapping pairs nothing reconciled.
    //
    // `--out` still wins verbatim: it is an escape hatch for scripting, and
    // imposing the layout on an explicit destination would defeat it.
    const single = !allRepos && parsed.length === 1 ? parsed[0] : undefined;
    const outDir = args.out
      ? resolve(args.out)
      : auditPathOrExit(
          () =>
            single
              ? sessionReportDir(repo, single.startedAt.slice(0, 10), single.sessionId)
              : rangeReportDir(
                  allRepos ? ALL_REPOS_DIR : repo,
                  report.range.from.slice(0, 10),
                  report.range.to.slice(0, 10),
                ),
          json,
        );
    const root = auditsRoot();
    const withinAudit = outDir === root || outDir.startsWith(root + "/");
    if (human === true && !withinAudit)
      flagError(
        "human-content-destination",
        "Destino privado requerido.",
        "Private audit destination required.",
      );
    const options = withinAudit ? {} : { ownedRoot: outDir };
    privateResultOrExit(ensurePrivateAuditDirectory(outDir, options), json);
    const mdFile = join(outDir, "report.md");
    const jsonFile = join(outDir, "report.json");
    privateResultOrExit(
      replacePrivateAuditFile(
        mdFile,
        renderMarkdown(report, lang, { includeHumanContent: human === true }),
        options,
      ),
      json,
    );
    privateResultOrExit(
      replacePrivateAuditFile(
        jsonFile,
        renderJson(reportPayload, { includeHumanContent: human === true }),
        options,
      ),
      json,
    );
    if (!single && !args.out) {
      const index = publishReport(report)
        .sessions.map((session) => `${session.startedAt.slice(0, 10)}\t${session.sessionId}`)
        .join("\n");
      privateResultOrExit(
        replacePrivateAuditFile(join(outDir, "sessions.txt"), index + "\n"),
        json,
      );
    }
    if (typeof snapshotName === "string" && snapshotName && snapshot) {
      const target = auditPathOrExit(
        () =>
          snapshotPath(
            allRepos ? null : repo,
            snapshotName,
            report.range.from.slice(0, 10),
            report.range.to.slice(0, 10),
          ),
        json,
      );
      auditPathOrExit(() => writeSnapshot(target, snapshot), json);
      p.log.success(`${isEs ? "Instantánea" : "Snapshot"} ${dim(target)}`);
      if (typeof copyTo === "string" && copyTo) {
        const copied = auditPathOrExit(
          () =>
            copySnapshotTo(target, copyTo, {
              cwd,
              scope: allRepos ? "all" : "repo",
              repoRoots: audited ? audited.repos.flatMap((r) => r.roots) : [],
            }),
          json,
        );
        p.log.success(`${isEs ? "Copiada a" : "Copied to"} ${dim(copied)}`);
      }
    }
    if (baseSnapshot && snapshot) {
      p.log.message(
        renderComparison(compareSnapshots(baseSnapshot, snapshot), baseSnapshot, snapshot).join(
          "\n",
        ),
      );
    }

    const high = report.signals.filter((s) => s.severity === "high").length;
    const warn = report.signals.filter((s) => s.severity === "warn").length;
    // The summary used to lead with `startupTokens`, the SMALLEST of the three
    // numbers in the report: a run showing "346k" in the terminal had 2.3M
    // weighted and 137.5M of raw cache_read in its body. The weighted total
    // leads now, and startup stays as the share it actually is.
    //
    // The figure comes from `report.ts` rather than from a second sum written
    // here: this one added `thinking` as a fourth addend, and thinking is a
    // SUBSET of output (`thinking_tokens <= output_tokens` in 100% of the 1028
    // assistant messages of transcript 4935c4d7, CC 2.1.236). So the same run
    // printed one billable in the terminal and a smaller one in the report it
    // had just written (finding A3) — the same invariant now holds for the
    // weighted figure: one function, called once, printed in both places.
    //
    // `topModel` is the dominant model ACROSS AGENTS ONLY (`byModel` never
    // counts the orchestrator's own model, #607's blind spot at range scale):
    // an orchestrator-only range falls back to the multiplier default, which
    // only mis-weights `cache_read` and only for the three rare model
    // overrides — see `weightedTokens`'s own comment for why that gap is
    // narrow rather than silent.
    const topModel =
      Object.entries(report.totals.byModel).sort(([, a], [, b]) => b - a)[0]?.[0] ?? null;
    const weightedTotal = weightedTokens(report.totals.tokens, topModel);
    const k = (n: number): string =>
      n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`;
    p.note(
      [
        `${report.totals.sessions} ${isEs ? "sesiones" : "sessions"} · ${projectedAgentCount(report) ?? "unavailable"} ${isEs ? "agentes" : "agents"}`,
        `${isEs ? "ponderado" : "weighted"}  ${["tokens.input", "tokens.output", "tokens.cacheRead", "tokens.cacheCreation"].every((key) => ["observed", "partial"].includes(report.availability?.[key]?.state ?? "")) ? k(weightedTotal) + " tok" : "unavailable"}`,
        `${isEs ? "arranque" : "startup"}  ${["observed", "partial"].includes(report.availability?.startupTokens?.state ?? "") ? k(report.totals.startupTokens) + " tok" : "unavailable"}`,
        `cache_read  ${["observed", "partial"].includes(report.availability?.["tokens.cacheRead"]?.state ?? "") ? k(report.totals.tokens.cacheRead) + " tok" : "unavailable"}`,
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
