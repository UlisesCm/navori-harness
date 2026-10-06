import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  chmodSync,
  closeSync,
  openSync,
  realpathSync,
  mkdirSync,
  mkdtempSync,
  lstatSync,
  renameSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "citty";
import * as privatePaths from "../../lib/audit/paths.ts";
import { auditCommand } from "../audit.ts";
import { parseCodexSession } from "../../lib/audit/parse.ts";
import { encodeCwdToSlug } from "../../lib/audit/paths.ts";

vi.mock(import("node:child_process"), { spy: true });
vi.mock(import("../../lib/audit/paths.ts"), { spy: true });
const realPaths = await vi.importActual<typeof privatePaths>("../../lib/audit/paths.ts");

/**
 * `audit` declares a hard contract in its own header: "every write lands under
 * the audit root". Nothing tested it — the CLI half that CREATES the log had no
 * spec at all, and the hook half only ever appends to a file that already
 * exists, so it cannot break the contract even when its input is path-shaped
 * (#503).
 *
 * These specs spawn the built CLI instead of calling the command in-process:
 * the assertions are about real exit codes and real bytes on disk, which is
 * exactly what the defect produced (a silent success writing outside the root,
 * or an unhandled ENOENT).
 */

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "dist", "index.js");
const REPO = "fixture-repo";

let sandbox: string;
/** `$NAVORI_AUDITS_ROOT` for the run. */
let auditsRoot: string;
/** Where this repo's logs must land: `<auditsRoot>/fixture-repo`. */
let auditDir: string;
/** The repo passed as `--cwd`. */
let repoDir: string;
let home: string;

interface CliResult {
  status: number;
  combined: string;
}

/** Spawn the real CLI with isolated paths and a conflict-free plain-output environment. */
function runAudit(args: string[], permissiveUmask = false): CliResult {
  const hasCwd = args.includes("--cwd");
  const baseArgs = hasCwd ? [] : ["--cwd", repoDir];
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.FORCE_COLOR;
  const commandArgs = [CLI, "audit", ...baseArgs, ...args];
  const r = spawnSync(
    permissiveUmask ? "sh" : "node",
    permissiveUmask ? ["-c", 'umask 000; exec "$@"', "sh", "node", ...commandArgs] : commandArgs,
    {
      encoding: "utf-8",
      env: {
        ...env,
        HOME: home,
        CODEX_HOME: join(home, ".codex"),
        NAVORI_TRANSCRIPTS_ROOT: join(home, ".claude", "projects"),
        NAVORI_AUDITS_ROOT: auditsRoot,
        NO_COLOR: "1",
      },
    },
  );
  return {
    status: r.status ?? -1,
    combined: (r.stdout ?? "") + (r.stderr ?? ""),
  };
}

/** Every path under `dir`, relative to it — directories included. */
function walk(dir: string, base: string = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    out.push(relative(base, full));
    if (entry.isDirectory()) out.push(...walk(full, base));
  }
  return out.sort();
}

/** The whole sandbox except the throwaway HOME, which the CLI only reads. */
function sandboxTree(): string[] {
  return walk(sandbox).filter((rel) => rel !== "home" && !rel.startsWith("home/"));
}

/**
 * The path the unvalidated builder used to produce for an id — i.e. where the
 * bug wrote. Recomputing it here (rather than hardcoding it) keeps the
 * assertions pinned to the escape itself and not to a literal that would drift.
 */
function preFixTarget(id: string): string {
  return join(auditDir, `session-${id}.log`);
}

/** Mark a session and give it a transcript the CLI can actually find. */
function markedSessionWithTranscript(
  id: string,
  day: string,
  usage: Record<string, unknown> = { input_tokens: 1, output_tokens: 1 },
): void {
  runAudit(["--start", id]);
  const transcripts = join(sandbox, "transcripts", "enc");
  mkdirSync(transcripts, { recursive: true });
  const jsonl = join(transcripts, `${id}.jsonl`);
  writeFileSync(
    jsonl,
    `${JSON.stringify({
      type: "assistant",
      sessionId: id,
      cwd: repoDir,
      timestamp: `${day}T10:00:00Z`,
      message: { model: "claude-opus-5", usage },
    })}\n`,
    "utf-8",
  );
  // The hook records the transcript path on the first prompt; without it
  // discovery would have to guess Claude Code's undocumented encoding.
  appendFileSync(
    join(auditDir, `session-${id}.log`),
    `${JSON.stringify({ ts: `${day}T10:00:00Z`, event: "prompt", prompt: "x", transcript: jsonl })}\n`,
    "utf-8",
  );
}

describe("Claude-only mining population", () => {
  // Covers: R4, R21
  it("keeps missing Codex rollouts out of the complete Claude denominator", () => {
    markedSessionWithTranscript("claude-mining", "2026-09-01");
    expect(runAudit(["--start", "codex-missing-mining", "--host", "codex"]).status).toBe(0);
    const response = runAudit(["--json"]);
    expect(response.status, response.combined).toBe(0);
    const report = JSON.parse(response.combined) as {
      availability: Record<string, { state: string; eligible: number }>;
      rangeMetrics: Record<string, number | null>;
    };
    expect(report.availability["activation.sessions"]).toMatchObject({
      state: "observed",
      eligible: 1,
    });
    expect(report.rangeMetrics["activation.sessions"]).toBe(1);
    expect(report.rangeMetrics["mining.passes"]).toBe(2);
  });
  // Covers: R4, R21
  it("publishes no Claude observed zero for a Codex-only missing source", () => {
    expect(runAudit(["--start", "codex-only-mining", "--host", "codex"]).status).toBe(0);
    const response = runAudit(["--json"]);
    expect(response.status, response.combined).toBe(0);
    const report = JSON.parse(response.combined) as {
      availability: Record<string, { state: string; eligible: number }>;
      rangeMetrics: Record<string, number | null>;
    };
    expect(report.availability["activation.sessions"]).toMatchObject({
      state: "unavailable",
      eligible: 0,
    });
    expect(report.rangeMetrics["activation.sessions"]).toBeNull();
    expect(report.rangeMetrics["mining.passes"]).toBe(0);
  });
});

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "navori-audit-cmd-"));
  home = join(sandbox, "home");
  // The store sits a few levels deep on purpose: the issue's `../../../../`
  // variant climbs four directories, and this keeps even the PRE-fix write
  // (the one the mutation check re-enables) inside the sandbox.
  auditsRoot = join(sandbox, "nested", "store", "audits");
  auditDir = join(auditsRoot, REPO);
  repoDir = join(sandbox, REPO);
  mkdirSync(home, { recursive: true });
  mkdirSync(auditsRoot, { recursive: true, mode: 0o700 });
  // An existing directory outside the audit root: without it the escape fails
  // with ENOENT, which is the LESS severe half of the defect. With it, the
  // pre-fix CLI writes there and reports success.
  mkdirSync(join(sandbox, "nested", "store", "outside"), { recursive: true });
  mkdirSync(repoDir, { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(sandbox, { recursive: true, force: true });
});

describe("metadata transport", () => {
  const metadata = {
    event: "hook",
    name: "quality-gate-pre-commit",
    source: "core",
    phase: "PreToolUse",
    verdict: "gate-started",
    ms: 1,
    tsMs: 1,
    agentId: "orchestrator",
  };
  const sessionId = "metadata-session";
  const eventInput = JSON.stringify(metadata);

  /** Complete private marker independent of production creation APIs. */
  function marker(host: "claude" | "codex" = "claude"): string {
    chmodSync(auditsRoot, 0o700);
    mkdirSync(auditDir, { mode: 0o700 });
    const log = join(auditDir, `session-${sessionId}.log`);
    writeFileSync(log, JSON.stringify({ event: "start", host, sessionId, cwd: repoDir }) + "\n", {
      mode: 0o600,
    });
    return log;
  }
  function flags(host = "claude"): string[] {
    return [
      "--record-metadata",
      "--host",
      host,
      "--root-session",
      sessionId,
      "--repo",
      REPO,
      "--root",
      auditsRoot,
    ];
  }
  /** No ambient identity or notifier can supply this explicit subprocess transport. */
  function transportEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      CI: "1",
      NAVORI_AUDITS_ROOT: auditsRoot,
    };
    for (const key of [
      "FORCE_COLOR",
      "NAVORI_AUDIT_HOST",
      "NAVORI_AUDIT_SESSION_ID",
      "CLAUDE_CODE_SESSION_ID",
      "CODEX_SESSION_ID",
      "CODEX_THREAD_ID",
    ])
      delete env[key];
    return env;
  }
  function invoke(args = flags(), input: string | Buffer = eventInput, fd?: number) {
    return spawnSync(process.execPath, [CLI, "audit", ...args], {
      input: fd === undefined ? input : undefined,
      stdio: fd === undefined ? "pipe" : [fd, "pipe", "pipe"],
      encoding: "utf-8",
      env: transportEnv(),
      timeout: 5000,
    });
  }
  function silent(result: ReturnType<typeof invoke>, status: number): void {
    expect(result.status).toBe(status);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  }

  // Covers: R10, R11, R21
  it.each(["claude", "codex"] as const)("appends one real private %s record", (host) => {
    const log = marker(host);
    silent(invoke(flags(host)), 0);
    const rows = readFileSync(log, "utf-8").trim().split("\n");
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[1]!)).toMatchObject({
      ...metadata,
      wireVersion: 1,
      host,
      rootSessionId: sessionId,
      eventId: expect.any(String),
    });
  });

  // Covers: R10, R11, R21
  it("accepts exactly 2048 UTF-8 input bytes including JSON whitespace", () => {
    const log = marker();
    silent(invoke(flags(), eventInput.padEnd(2048, " ")), 0);
    expect(readFileSync(log, "utf-8").trim().split("\n")).toHaveLength(2);
  });

  // Covers: R10, R11
  it("consumes only validated metadata startup spool through the real start command", () => {
    expect(runAudit(["--arm"]).status).toBe(0);
    silent(invoke(flags(), JSON.stringify({ ...metadata, phase: "SessionStart" })), 0);
    const spool = join(auditDir, `pending-${sessionId}.jsonl`);
    const record = JSON.parse(readFileSync(spool, "utf8")) as { eventId: string };
    expect(runAudit(["--start", sessionId]).status).toBe(0);
    expect(existsSync(spool)).toBe(false);
    expect(readFileSync(join(auditDir, `session-${sessionId}.log`), "utf8")).toContain(
      record.eventId,
    );
  });

  // Covers: R10, R11
  it("spools only an armed startup and silently skips unmarked later phases", () => {
    chmodSync(auditsRoot, 0o700);
    mkdirSync(auditDir, { mode: 0o700 });
    silent(invoke(), 0);
    expect(readdirSync(auditDir)).toEqual([]);
    writeFileSync(join(auditDir, ".armed"), JSON.stringify({ cwd: repoDir }), {
      mode: 0o600,
    });
    silent(invoke(flags(), JSON.stringify({ ...metadata, phase: "SessionStart" })), 0);
    expect(
      JSON.parse(readFileSync(join(auditDir, `pending-${sessionId}.jsonl`), "utf-8")),
    ).toMatchObject({ wireVersion: 1, phase: "SessionStart" });
  });

  // Covers: R10, R11, R21
  it.each([
    "",
    "{",
    eventInput + eventInput,
    eventInput.padEnd(2049, " "),
    Buffer.from([0xff]),
    Buffer.concat([Buffer.from(eventInput), Buffer.from("é".repeat(1024))]),
    JSON.stringify({ ...metadata, reason: "PRIVATE raw reason" }),
    JSON.stringify({ ...metadata, verdict: "PRIVATE unknown verdict" }),
  ])("rejects malformed, oversized or human-content input without side effects (%#)", (input) => {
    const log = marker();
    const before = readFileSync(log);
    silent(invoke(flags(), input), 2);
    expect(readFileSync(log)).toEqual(before);
    expect(readdirSync(auditDir)).toEqual([`session-${sessionId}.log`]);
  });

  // Covers: R10, R11, R21
  it.each(
    [
      ["--record-metadata=false", "--start", "new"],
      ["--no-record-metadata", "--root-session", sessionId],
      [...flags(), "--root", "/other"],
      [...flags(), "--host", "codex"],
      [...flags(), "--root-session", "other"],
      [...flags(), "--repo", "other"],
      [...flags(), "--arm=false"],
      [...flags(), "--json=false"],
      [...flags(), "--collect=false"],
      [...flags(), "--start", "new"],
      [...flags(), "--capture-child", "child"],
      [...flags(), "--snapshot", "private"],
      ["--repo", REPO],
      ["--root", "/other"],
      ["--record-metadata"],
      flags(" CLAUDE "),
      [
        "--record-metadata",
        "--host",
        "claude",
        "--root-session",
        "bad/id",
        "--repo",
        REPO,
        "--root",
        auditsRoot,
      ],
      [
        "--record-metadata",
        "--host",
        "claude",
        "--root-session",
        sessionId,
        "--repo",
        "../escape",
        "--root",
        auditsRoot,
      ],
      [
        "--record-metadata",
        "--host",
        "claude",
        "--root-session",
        sessionId,
        "--repo",
        REPO,
        "--root",
        "relative",
      ],
    ].map((args) => ({ args })),
  )("rejects false, orphan, duplicate or conflicting parsed flags (%#)", ({ args }) => {
    const log = marker();
    const before = readFileSync(log);
    const tree = sandboxTree();
    silent(invoke(args), 2);
    expect(readFileSync(log)).toEqual(before);
    expect(sandboxTree()).toEqual(tree);
  });

  // Covers: R10, R11
  it.each(["unsafe", "symlink", "identity", "host"])(
    "refuses a %s target without repair",
    (fault) => {
      const log = marker();
      if (fault === "unsafe") chmodSync(log, 0o644);
      if (fault === "identity")
        writeFileSync(
          log,
          JSON.stringify({ event: "start", sessionId: "other", cwd: repoDir }) + "\n",
        );
      if (fault === "symlink") {
        const target = join(auditDir, "target");
        writeFileSync(target, readFileSync(log), { mode: 0o600 });
        rmSync(log);
        symlinkSync(target, log);
      }
      const before = readFileSync(log);
      silent(invoke(flags(fault === "host" ? "codex" : "claude")), 2);
      expect(readFileSync(log)).toEqual(before);
    },
  );

  // Covers: R10, R11
  it("silently rejects a stdin read failure", () => {
    const log = marker();
    const fd = openSync(auditDir, "r");
    try {
      silent(invoke(flags(), eventInput, fd), 2);
    } finally {
      closeSync(fd);
    }
    expect(readFileSync(log, "utf-8").trim().split("\n")).toHaveLength(1);
  });

  // Covers: R10, R11, R21
  it("does not append a valid document until its pipe reaches EOF", async () => {
    const log = marker();
    const before = readFileSync(log);
    const child = spawn(process.execPath, [CLI, "audit", ...flags()], {
      env: transportEnv(),
      stdio: "pipe",
    });
    const done = new Promise<number | null>((resolveExit) => child.once("close", resolveExit));
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      child.stdin.write(eventInput);
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 200));
      expect(child.exitCode).toBeNull();
      expect(readFileSync(log)).toEqual(before);
      child.stdin.end();
      expect(await done).toBe(0);
      expect(readFileSync(log, "utf-8").trim().split("\n")).toHaveLength(2);
    } finally {
      clearTimeout(watchdog);
      if (child.exitCode === null) child.kill("SIGKILL");
      await done;
    }
  }, 10000);
});

describe("audit subprocess color environment", () => {
  it("omits inherited FORCE_COLOR without changing the parent environment", () => {
    vi.stubEnv("FORCE_COLOR", "1");
    const spawn = vi.mocked(spawnSync);
    spawn.mockClear();

    const result = runAudit(["--arm"]);

    expect(result.status).toBe(0);
    expect(spawn).toHaveBeenCalledOnce();
    const childEnv = spawn.mock.calls[0]?.[2]?.env;
    expect(childEnv).not.toHaveProperty("FORCE_COLOR");
    expect(childEnv?.NO_COLOR).toBe("1");
    expect(process.env.FORCE_COLOR).toBe("1");
    expect(result.combined).not.toContain(String.fromCharCode(27));
    expect(result.combined).not.toContain("Warning:");
    expect(result.combined).not.toContain("FORCE_COLOR");
  });
});

describe("audit explicit child capture action", () => {
  /** Metadata-only private fixture; the child is never a fake root start event. */
  function captureFixture(): { log: string; child: string } {
    const canonical = realpathSync(sandbox);
    repoDir = join(canonical, REPO);
    home = join(canonical, "home");
    auditsRoot = join(canonical, "nested", "store", "audits");
    auditDir = join(auditsRoot, REPO);
    chmodSync(auditsRoot, 0o700);
    mkdirSync(auditDir, { mode: 0o700 });
    writeFileSync(join(repoDir, "navori.config.json"), "{}");
    const sources = join(home, ".codex", "sessions");
    mkdirSync(sources, { recursive: true, mode: 0o700 });
    const rootSource = join(sources, "rollout-fixture-root.jsonl");
    const child = join(sources, "rollout-fixture-child.jsonl");
    for (const [path, id, parent] of [
      [rootSource, "root", null],
      [child, "child", "root"],
    ] as const) {
      writeFileSync(
        path,
        JSON.stringify({
          type: "session_meta",
          payload: {
            id,
            session_id: "root",
            cli_version: "0.160.0",
            cwd: repoDir,
            parent_thread_id: parent,
            source: parent ? { subagent: { thread_spawn: { parent_thread_id: parent } } } : "cli",
          },
        }) + "\n",
        { mode: 0o600 },
      );
    }
    const log = join(auditDir, "session-root.log");
    writeFileSync(
      log,
      JSON.stringify({
        event: "start",
        sessionId: "root",
        host: "codex",
        repo: REPO,
        cwd: repoDir,
        ts: "2026-10-04T12:00:00Z",
        transcript: rootSource,
      }) + "\n",
      { mode: 0o600 },
    );
    return { log, child };
  }

  // Covers: R5, R8, R9, R10
  it("returns path-free diagnostics, registers once and preserves the root lifecycle bytes", () => {
    const { log, child } = captureFixture();
    const original = readFileSync(log, "utf-8");
    const args = [
      "--capture-child",
      "child",
      "--root-session",
      "root",
      "--rollout",
      child,
      "--json",
    ];
    const first = runAudit(args);
    expect(first.status).toBe(0);
    expect(JSON.parse(first.combined)).toMatchObject({
      ok: true,
      registered: 1,
      skipped: 0,
    });
    expect(first.combined).not.toContain(child);
    expect(first.combined).not.toContain("sourceHeaderFingerprint");
    expect(readFileSync(log, "utf-8").startsWith(original)).toBe(true);
    const after = readFileSync(log, "utf-8");
    const second = runAudit(args);
    expect(second.status).toBe(0);
    expect(JSON.parse(second.combined)).toMatchObject({
      ok: true,
      registered: 0,
      skipped: 1,
    });
    expect(readFileSync(log, "utf-8")).toBe(after);
  });

  // Covers: R4, R5, R8, R9
  it("reads registered direct/grandchildren once without modifying logs and retains pruned capture", () => {
    const { log, child } = captureFixture();
    const grandchild = join(dirname(child), "rollout-fixture-grandchild.jsonl");
    const rootMetadata = JSON.parse(readFileSync(child, "utf-8"));
    rootMetadata.payload.id = "grandchild";
    rootMetadata.payload.parent_thread_id = "child";
    rootMetadata.payload.source.subagent.thread_spawn.parent_thread_id = "child";
    writeFileSync(grandchild, JSON.stringify(rootMetadata) + "\n", {
      mode: 0o600,
    });
    for (const [thread, path] of [
      ["grandchild", grandchild],
      ["child", child],
    ]) {
      appendFileSync(
        path!,
        JSON.stringify({
          type: "token_usage_record",
          timestamp: "2026-10-04T12:01:00Z",
          payload: {
            thread_id: thread,
            session_id: "root",
            turn_id: `${thread}-turn`,
            response_id: `${thread}-response`,
            usage: {
              input_tokens: 100,
              cached_input_tokens: 20,
              cache_write_input_tokens: 10,
              output_tokens: 40,
              reasoning_output_tokens: 5,
              total_tokens: 140,
            },
          },
        }) + "\n",
      );
      expect(
        runAudit([
          "--capture-child",
          thread!,
          "--root-session",
          "root",
          "--rollout",
          path!,
          "--json",
        ]).status,
      ).toBe(0);
    }
    const before = readFileSync(log, "utf-8");
    writeFileSync(
      join(auditDir, "session-child.log"),
      JSON.stringify({
        event: "start",
        sessionId: "child",
        host: "codex",
        repo: REPO,
        cwd: repoDir,
        ts: "2026-10-04T12:00:00Z",
        transcript: child,
      }) + "\n",
      { mode: 0o600 },
    );
    const result = runAudit(["--json"]);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.combined);
    expect(report.sessions).toHaveLength(1);
    expect(report.sessions[0].agents).toHaveLength(2);
    expect(report.totals.tokens).toMatchObject({
      input: 140,
      output: 80,
      cacheRead: 40,
      cacheCreation: 20,
      thinking: 10,
    });
    expect(
      report.sessions[0].agents.map((run: { spawnDepth: number }) => run.spawnDepth).sort(),
    ).toEqual([1, 2]);
    expect(result.combined).not.toContain(child);
    expect(result.combined).not.toContain("sourceHeaderFingerprint");
    expect(readFileSync(log, "utf-8")).toBe(before);
    rmSync(grandchild);
    const pruned = JSON.parse(runAudit(["--json"]).combined);
    const captured = pruned.sessions[0].agents.find(
      (run: { agentId: string }) => run.agentId === "grandchild",
    );
    expect(captured.codex.capturedAt).not.toBeNull();
    expect(captured.tokens.output).toBeNull();
    expect(readFileSync(log, "utf-8")).toBe(before);
    const changed = JSON.parse(readFileSync(child, "utf-8").split("\n")[0]!);
    changed.payload.parent_thread_id = "foreign-parent";
    changed.payload.source.subagent.thread_spawn.parent_thread_id = "foreign-parent";
    writeFileSync(child, JSON.stringify(changed) + "\n", { mode: 0o600 });
    const conflicted = JSON.parse(runAudit(["--json"]).combined);
    const invalid = conflicted.sessions
      .find((session: { sessionId: string }) => session.sessionId === "root")
      .agents.find((run: { agentId: string }) => run.agentId === "child");
    expect(invalid.codex.source.reason).toBe("identity-conflict");
    expect(invalid.tokens.output).toBeNull();
    expect(readFileSync(log, "utf-8")).toBe(before);
  });

  // Covers: R9, R10
  it.each(["--start", "--stop", "--snapshot", "--compare", "--collect", "--arm"])(
    "rejects capture combined with %s before any write",
    (flag) => {
      const { log, child } = captureFixture();
      const original = readFileSync(log, "utf-8");
      const extra = flag === "--collect" || flag === "--arm" ? [flag] : [flag, "other"];
      const result = runAudit([
        "--capture-child",
        "child",
        "--root-session",
        "root",
        "--rollout",
        child,
        "--json",
        ...extra,
      ]);
      expect(result.status).toBe(2);
      expect(JSON.parse(result.combined)).toEqual({
        ok: false,
        error: "capture-flags-conflict",
      });
      expect(readFileSync(log, "utf-8")).toBe(original);
    },
  );

  // Covers: R9, R10
  it("requires all three explicit binding arguments without environment fallback", () => {
    const { log } = captureFixture();
    const original = readFileSync(log, "utf-8");
    expect(runAudit(["--capture-child", "child", "--json"]).status).toBe(2);
    expect(readFileSync(log, "utf-8")).toBe(original);
  });
});

/**
 * #597 — activation without passing through the model's attention. `--arm`
 * leaves a per-repo flag the SessionStart hook consumes; these specs pin the
 * CLI half: the flag's location (the hook computes the same path), one-shot
 * semantics, and that disarming is safe when nothing is armed.
 */
describe("audit --arm / --disarm (#597)", () => {
  const armedFile = () => join(auditDir, ".armed");

  it("writes the armed flag where the SessionStart hook will look for it", () => {
    const res = runAudit(["--arm"]);
    expect(res.status).toBe(0);
    expect(existsSync(armedFile())).toBe(true);
    // Diagnostic content, parseable: when it fires on the wrong repo, the
    // recorded cwd says where the arm actually happened.
    const body = JSON.parse(readFileSync(armedFile(), "utf-8")) as {
      cwd: string;
    };
    expect(body.cwd).toBe(repoDir);
  });

  it("is idempotent and says so instead of re-stamping", () => {
    runAudit(["--arm"]);
    const first = readFileSync(armedFile(), "utf-8");
    const res = runAudit(["--arm"]);
    expect(res.status).toBe(0);
    expect(res.combined).toMatch(/ya estaba armado|already armed/);
    expect(readFileSync(armedFile(), "utf-8")).toBe(first);
  });

  it("disarm removes the flag; disarming nothing is a clean no-op", () => {
    runAudit(["--arm"]);
    expect(runAudit(["--disarm"]).status).toBe(0);
    expect(existsSync(armedFile())).toBe(false);
    const res = runAudit(["--disarm"]);
    expect(res.status).toBe(0);
    expect(res.combined).toMatch(/no había nada armado|nothing was armed/);
  });

  it("arming does NOT start anything: no session log appears", () => {
    runAudit(["--arm"]);
    const entries = readdirSync(auditDir).filter((f) => f.startsWith("session-"));
    expect(entries).toEqual([]);
  });

  it("arms the parent repo when run inside an agent worktree (#764)", () => {
    const wtDir = join(repoDir, ".claude", "worktrees", "agent-a2a999b59fde9ce6c");
    mkdirSync(wtDir, { recursive: true });
    const res = runAudit(["--arm", "--cwd", wtDir]);
    expect(res.status).toBe(0);
    expect(existsSync(armedFile())).toBe(true);
    expect(existsSync(join(auditsRoot, "agent-a2a999b59fde9ce6c"))).toBe(false);
  });
});

describe("private CLI lifecycle and exports", () => {
  describe("exclusive arm claim orchestration", () => {
    let armed: string;
    let claim: string;
    let initialExitCode: typeof process.exitCode;

    beforeEach(() => {
      expect(runAudit(["--arm"]).status).toBe(0);
      armed = join(auditDir, ".armed");
      claim = `${armed}.claim`;
      initialExitCode = process.exitCode;
      process.exitCode = 0;
      vi.stubEnv("NAVORI_AUDITS_ROOT", auditsRoot);
    });
    afterEach(() => {
      process.exitCode = initialExitCode;
    });

    /** Parse the actual command and delegate real filesystem helpers in this process. */
    async function consume(): Promise<void> {
      await runCommand(auditCommand, {
        rawArgs: [
          "--consume-arm",
          "--start",
          "delayed-a",
          "--host",
          "codex",
          "--cwd",
          repoDir,
          "--root",
          auditsRoot,
        ],
      });
      expect(process.exitCode).toBe(2);
      expect(existsSync(join(auditDir, "session-delayed-a.log"))).toBe(false);
    }

    // Covers: R10
    it.each([false, true])(
      "refuses a delayed old reader after cleanup; observable distinct rearm=%s",
      async (rearm) => {
        const original = statSync(armed);
        const create = realPaths.createPrivateAuditFile;
        let replacement: Buffer | undefined;
        let generation: ReturnType<typeof statSync> | undefined;
        vi.spyOn(privatePaths, "createPrivateAuditFile").mockImplementation(
          (file, data, options) => {
            if (file === claim) {
              expect(
                runAudit([
                  "--consume-arm",
                  "--start",
                  "winner-b",
                  "--host",
                  "codex",
                  "--root",
                  auditsRoot,
                ]).status,
              ).toBe(0);
              expect(existsSync(claim)).toBe(false);
              if (rearm) {
                // Distinct size proves observable generation difference even if inode is reused.
                replacement = Buffer.from(
                  JSON.stringify({ ts: "2026-10-05T00:00:00.000Z", cwd: repoDir }) + " \n",
                );
                writeFileSync(armed, replacement, { mode: 0o600 });
                generation = statSync(armed);
                expect([generation.dev, generation.ino, generation.size]).not.toEqual([
                  original.dev,
                  original.ino,
                  original.size,
                ]);
              }
            }
            return create(file, data, options);
          },
        );
        await consume();
        expect(existsSync(claim)).toBe(false);
        expect(existsSync(join(auditDir, "session-winner-b.log"))).toBe(true);
        if (replacement && generation) {
          expect(readFileSync(armed)).toEqual(replacement);
          const after = statSync(armed);
          expect([after.dev, after.ino, after.size, after.mode]).toEqual([
            generation.dev,
            generation.ino,
            generation.size,
            generation.mode,
          ]);
        } else expect(existsSync(armed)).toBe(false);
      },
    );

    // Covers: R10
    it.each([
      "partial-create",
      "post-create-guard",
      "create-close-throw",
      "revalidate-throw",
      "arm-remove-refusal",
      "arm-remove-close-throw",
      "cleanup-read-refusal",
      "token-mismatch",
      "replacement",
      "insecure-claim",
      "cleanup-remove-refusal",
      "cleanup-close-throw",
    ])("refuses %s without authorizing start or another claim cleanup", async (failure) => {
      const create = realPaths.createPrivateAuditFile;
      const read = realPaths.readPrivateAuditFile;
      const remove = realPaths.removePrivateAuditFile;
      let reads = 0;
      let retained: Buffer | undefined;
      const refusal = { ok: false, reason: "io", partial: true } as const;
      vi.spyOn(privatePaths, "createPrivateAuditFile").mockImplementation((file, data, options) => {
        const created = create(file, failure === "partial-create" ? "partial" : data, options);
        if (file === claim) {
          if (failure === "partial-create") return refusal;
          if (failure === "post-create-guard") {
            chmodSync(claim, 0o644);
            return refusal;
          }
          if (failure === "create-close-throw") throw new Error("injected-close");
        }
        return created;
      });
      vi.spyOn(privatePaths, "readPrivateAuditFile").mockImplementation((file, options) => {
        if (file === armed && ++reads === 2 && failure === "revalidate-throw")
          throw new Error("injected-read");
        if (file === claim && failure === "cleanup-read-refusal") return refusal;
        return read(file, options);
      });
      vi.spyOn(privatePaths, "removePrivateAuditFile").mockImplementation((file, options) => {
        if (
          (file === armed && failure === "arm-remove-refusal") ||
          (file === claim && failure === "cleanup-remove-refusal")
        )
          return refusal;
        const removed = remove(file, options);
        if (file === armed) {
          if (failure === "arm-remove-close-throw") throw new Error("injected-close");
          if (failure === "token-mismatch") {
            writeFileSync(claim, "other-owner\n");
            retained = readFileSync(claim);
          }
          if (failure === "replacement") {
            const bytes = readFileSync(claim);
            // Keep the old inode alive to guarantee a replacement inode.
            renameSync(claim, join(auditDir, "old-claim"));
            writeFileSync(claim, bytes, { mode: 0o600 });
            retained = bytes;
          }
          if (failure === "insecure-claim") {
            chmodSync(claim, 0o644);
            retained = readFileSync(claim);
          }
        }
        if (file === claim && failure === "cleanup-close-throw") throw new Error("injected-close");
        return removed;
      });
      await consume();
      const untouchedArm = [
        "partial-create",
        "post-create-guard",
        "create-close-throw",
        "revalidate-throw",
        "arm-remove-refusal",
      ].includes(failure);
      expect(existsSync(armed)).toBe(untouchedArm);
      const ownCleanup = [
        "revalidate-throw",
        "arm-remove-refusal",
        "arm-remove-close-throw",
        "cleanup-close-throw",
      ].includes(failure);
      expect(existsSync(claim)).toBe(!ownCleanup);
      if (retained) expect(readFileSync(claim)).toEqual(retained);
    });

    // Covers: R10
    it("retains a confirmed private claim after a forced process crash without activation", () => {
      const script = `
        import fs from "node:fs";
        import {syncBuiltinESMExports} from "node:module";
        const claim = process.argv[1];
        const open = fs.openSync, close = fs.closeSync, stat = fs.lstatSync;
        let fd, confirmed = false;
        fs.openSync = (...args) => { const value = open(...args); if (args[0] === claim) fd = value; return value; };
        fs.closeSync = value => { close(value); if (value === fd) confirmed = true; };
        fs.lstatSync = (...args) => { if (confirmed && args[0] === claim) process.exit(99); return stat(...args); };
        syncBuiltinESMExports();
        process.argv = [process.execPath, ${JSON.stringify(CLI)}, "audit", ...process.argv.slice(2)];
        await import(${JSON.stringify(CLI)});
      `;
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          script,
          claim,
          "--consume-arm",
          "--start",
          "crashed",
          "--host",
          "codex",
          "--cwd",
          repoDir,
          "--root",
          auditsRoot,
        ],
        {
          cwd: resolve(dirname(CLI), ".."),
          encoding: "utf8",
          env: { ...process.env, NAVORI_AUDITS_ROOT: auditsRoot },
        },
      );
      expect(result.status, result.stderr).toBe(99);
      expect(existsSync(armed)).toBe(true);
      expect(statSync(claim).mode & 0o777).toBe(0o600);
      expect(readFileSync(claim, "utf8")).toMatch(/^[a-f0-9-]{36}\n$/);
      expect(existsSync(join(auditDir, "session-crashed.log"))).toBe(false);
      expect(
        runAudit([
          "--consume-arm",
          "--start",
          "after-crash",
          "--host",
          "codex",
          "--root",
          auditsRoot,
        ]).status,
      ).toBe(2);
      expect(existsSync(armed)).toBe(true);
      expect(existsSync(claim)).toBe(true);
    });

    // Covers: R10
    it.each(["private", "public", "symlink", "empty"])(
      "preserves existing/crashed %s claim",
      async (kind) => {
        const content = kind === "empty" ? "" : "crashed-owner\n";
        const target = join(auditDir, "claim-target");
        if (kind === "symlink") {
          writeFileSync(target, content, { mode: 0o600 });
          symlinkSync(target, claim);
        } else writeFileSync(claim, content, { mode: kind === "public" ? 0o644 : 0o600 });
        const armBytes = readFileSync(armed);
        const before = lstatSync(claim);
        await consume();
        expect(readFileSync(armed)).toEqual(armBytes);
        expect(readFileSync(claim, "utf8")).toBe(content);
        const after = lstatSync(claim);
        expect([after.dev, after.ino, after.size, after.mode]).toEqual([
          before.dev,
          before.ino,
          before.size,
          before.mode,
        ]);
      },
    );
  });
  // Covers: R10
  it.each(
    [
      ["--consume-arm=false"],
      ["--no-consume-arm"],
      ["--consume-arm", "--consume-arm"],
      ["--host", "codex"],
      ["--cwd", "/"],
      ["--root", "/"],
      ["--start", "other"],
      ["--collect"],
      ["--arm"],
      ["--disarm"],
      ["--stop", "other"],
      ["--record-metadata"],
      ["--repo", REPO],
      ["--capture-child", "child"],
      ["--json"],
      ["--include-human-content"],
    ].map((flags) => ({ flags })),
  )("refuses conflicting parsed consume flags $flags before any writer", ({ flags: extra }) => {
    expect(runAudit(["--arm"]).status).toBe(0);
    const file = join(auditDir, ".armed");
    const bytes = readFileSync(file);
    expect(
      runAudit([
        "--consume-arm",
        "--start",
        "strict",
        "--host",
        "claude",
        "--cwd",
        repoDir,
        "--root",
        auditsRoot,
        ...extra,
      ]).status,
    ).toBe(2);
    expect(readFileSync(file)).toEqual(bytes);
    expect(readdirSync(auditDir)).toEqual([".armed"]);
  });
  // Covers: R10
  it("rejects root mismatch and missing consumption, preserving idempotent disarm", () => {
    expect(runAudit(["--disarm"]).status).toBe(0);
    expect(
      runAudit(["--consume-arm", "--start", "missing", "--host", "claude", "--root", auditsRoot])
        .status,
    ).toBe(2);
    expect(runAudit(["--arm"]).status).toBe(0);
    const before = readFileSync(join(auditDir, ".armed"));
    expect(
      runAudit(["--consume-arm", "--start", "wrong-root", "--host", "claude", "--root", sandbox])
        .status,
    ).toBe(2);
    expect(readFileSync(join(auditDir, ".armed"))).toEqual(before);
    expect(readdirSync(auditDir)).toEqual([".armed"]);
  });
  // Covers: R10
  it.each(["--start", "--stop"])(
    "rejects repeated %s identity instead of selecting the report path",
    (flag) => {
      expect(runAudit([flag, "first", flag, "second"]).status).toBe(2);
      expect(existsSync(auditDir)).toBe(false);
    },
  );
  // Covers: R10
  it("creates private lifecycle files even under child umask 000", () => {
    rmSync(auditsRoot, { recursive: true });
    expect(runAudit(["--arm"], true).status).toBe(0);
    expect(statSync(auditsRoot).mode & 0o777).toBe(0o700);
    expect(statSync(auditDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(auditDir, ".armed")).mode & 0o777).toBe(0o600);
    expect(runAudit(["--start", "permissive"], true).status).toBe(0);
    expect(statSync(join(auditDir, "session-permissive.log")).mode & 0o777).toBe(0o600);
  });
  // Covers: R10
  it.each(["root", "repo", "leaf"])("refuses symlink %s without changing its target", (part) => {
    const target = join(sandbox, "target");
    if (part === "leaf") {
      mkdirSync(auditDir, { mode: 0o700 });
      writeFileSync(target, "sentinel\n", { mode: 0o600 });
      symlinkSync(target, join(auditDir, "session-linked.log"));
    } else {
      mkdirSync(target, { mode: 0o700 });
      if (part === "root") rmSync(auditsRoot, { recursive: true });
      symlinkSync(target, part === "root" ? auditsRoot : auditDir);
    }
    expect(runAudit(["--start", "linked"]).status).toBe(2);
    if (part === "leaf") expect(readFileSync(target, "utf8")).toBe("sentinel\n");
    else expect(readdirSync(target)).toEqual([]);
  });
  // Covers: R10
  it.each([null, "", "relative", "/other/fixture-repo"])(
    "refuses wrong or ambient marker cwd %j before stop",
    (cwd) => {
      mkdirSync(auditDir, { mode: 0o700 });
      const path = join(auditDir, "session-wrong.log");
      const bytes = JSON.stringify({ event: "start", sessionId: "wrong", cwd }) + "\n";
      writeFileSync(path, bytes, { mode: 0o600 });
      expect(runAudit(["--stop", "wrong"]).status).toBe(2);
      expect(readFileSync(path, "utf8")).toBe(bytes);
    },
  );
  // Covers: R10
  it("preserves an incomplete live tail when sealing is requested", () => {
    runAudit(["--start", "tail"]);
    const path = join(auditDir, "session-tail.log");
    appendFileSync(path, '{"event":');
    const bytes = readFileSync(path, "utf8");
    expect(runAudit(["--stop", "tail"]).status).toBe(2);
    expect(readFileSync(path, "utf8")).toBe(bytes);
  });
  // Covers: R10
  it.each(["--start", "--stop"])("refuses an unmarked exact private file for %s", (flag) => {
    mkdirSync(auditDir, { mode: 0o700 });
    const path = join(auditDir, "session-unsafe.log");
    const bytes = '{"event":"hook"}\n';
    writeFileSync(path, bytes, { mode: 0o600 });
    expect(runAudit([flag, "unsafe"]).status).toBe(2);
    expect(readFileSync(path, "utf8")).toBe(bytes);
  });
  // Covers: R10
  it.each(["--start", "--stop", "--disarm"])(
    "preserves insecure existing targets for %s",
    (flag) => {
      mkdirSync(auditDir, { mode: 0o700 });
      const path = join(auditDir, flag === "--disarm" ? ".armed" : "session-unsafe.log");
      const bytes = JSON.stringify({ event: "start", sessionId: "unsafe", cwd: repoDir }) + "\n";
      writeFileSync(path, bytes, { mode: 0o644 });
      expect(runAudit(flag === "--disarm" ? [flag] : [flag, "unsafe"]).status).toBe(2);
      expect(readFileSync(path, "utf8")).toBe(bytes);
      expect(statSync(path).mode & 0o777).toBe(0o644);
    },
  );
  // Covers: R10 R11
  it.each([
    { flags: ["--json"] },
    { flags: ["--snapshot", "shared"] },
    { flags: ["--out", "/tmp/untrusted-report"] },
  ])("rejects human opt-in with $flags", ({ flags }) => {
    expect(runAudit(["--include-human-content", ...flags]).status).toBe(2);
  });
  // Covers: R10 R11
  it("writes rerunnable private metadata artifacts without copying the raw log", () => {
    markedSessionWithTranscript("private-export", "2026-08-25");
    appendFileSync(
      join(auditDir, "session-private-export.log"),
      '{"event":"prompt","prompt":"SECRET_PROMPT_SENTINEL"}\n',
    );
    for (let pass = 0; pass < 2; pass++)
      expect(runAudit(["--session", "private-export"]).status).toBe(0);
    const dir = join(auditDir, "sessions", "2026-08-25-private-");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    for (const name of ["report.md", "report.json"]) {
      expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(dir, name), "utf8")).not.toContain("SECRET_PROMPT_SENTINEL");
    }
    expect(existsSync(join(dir, "session.log"))).toBe(false);
  });
  // Covers: R10 R11
  it("refuses insecure output files and directories without rewriting them", () => {
    markedSessionWithTranscript("output-private", "2026-08-25");
    const out = join(sandbox, "custom");
    mkdirSync(out, { mode: 0o755 });
    expect(runAudit(["--session", "output-private", "--out", out]).status).toBe(2);
    expect(statSync(out).mode & 0o777).toBe(0o755);
    chmodSync(out, 0o700);
    const target = join(out, "report.md");
    writeFileSync(target, "old-report", { mode: 0o644 });
    expect(runAudit(["--session", "output-private", "--out", out]).status).toBe(2);
    expect(readFileSync(target, "utf8")).toBe("old-report");
    expect(statSync(target).mode & 0o777).toBe(0o644);
  });
  // Covers: R11
  it("allows explicit private human generation per invocation, followed by metadata-only regeneration", () => {
    markedSessionWithTranscript("human-private", "2026-08-25");
    const result = runAudit(["--session", "human-private", "--include-human-content"]);
    expect(result.status).toBe(0);
    expect(result.combined).not.toContain("initialPrompt");
    const dir = join(auditDir, "sessions", "2026-08-25-human-pr");
    expect(readFileSync(join(dir, "report.json"), "utf8")).toContain("initialPrompt");
    expect(runAudit(["--session", "human-private"]).status).toBe(0);
    expect(readFileSync(join(dir, "report.json"), "utf8")).toContain('"initialPrompt": ""');
  });
});

/**
 * #778 — the SessionStart records that had nowhere to land.
 *
 * `--start` creates the session log and runs from UserPromptSubmit, so every
 * SessionStart hook fires before the file exists and the recorder threw its
 * record away: measured, `session-start-context` was written down in 1 of ~20
 * startups. The hook now parks those lines in `pending-<session>.jsonl`; this is
 * the CLI half that folds them in — and reclaims the ones nobody ever marked.
 */
describe("audit --start: the SessionStart spool (#778)", () => {
  const spool = (id: string) => join(auditDir, `pending-${id}.jsonl`);

  function writeSpool(id: string, ...names: string[]): void {
    mkdirSync(auditDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      spool(id),
      `${names
        .map((name) =>
          JSON.stringify({
            tsMs: 1,
            event: "hook",
            name,
            phase: "SessionStart",
            verdict: "inject",
          }),
        )
        .join("\n")}\n`,
      "utf-8",
    );
  }

  // Covers: R10 R11
  it("preserves unvalidated legacy spool records without copying their content", () => {
    writeSpool("sess-spool", "session-start-context", "check-jscpd");
    expect(runAudit(["--start", "sess-spool"]).status).toBe(0);

    const log = readFileSync(join(auditDir, "session-sess-spool.log"), "utf-8");
    expect(log).not.toContain('"name":"session-start-context"');
    expect(log).not.toContain('"name":"check-jscpd"');
    // The `start` record still leads: nothing about absorbing may cost the
    // stamp that makes the log a marked session.
    expect(log.split("\n")[0]).toContain('"event":"start"');
    // Absorbed means MOVED: leaving it would double every record on a re-run.
    expect(existsSync(spool("sess-spool"))).toBe(true);
  });

  it("marks the session normally when there is no spool at all", () => {
    expect(runAudit(["--start", "sess-plain"]).status).toBe(0);
    expect(existsSync(join(auditDir, "session-sess-plain.log"))).toBe(true);
  });

  // Covers: R10
  it("preserves historical spools regardless of age", () => {
    writeSpool("sess-old", "session-start-context");
    writeSpool("sess-new", "session-start-context");
    const ancient = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    utimesSync(spool("sess-old"), ancient, ancient);

    runAudit(["--start", "sess-other"]);

    // A couple of lines per unmarked session is small; forever is not, and the
    // recorder may not leak.
    expect(existsSync(spool("sess-old"))).toBe(true);
    expect(existsSync(spool("sess-new"))).toBe(true);
  });

  it("never leaves the audit root, even for a path-shaped id", () => {
    const res = runAudit(["--start", "../../outside/evil"]);
    expect(res.status).not.toBe(0);
    expect(existsSync(join(sandbox, "nested", "store", "outside", "evil.jsonl"))).toBe(false);
  });
});

describe("audit --start: host (R71)", () => {
  // Covers: R71
  it("stamps host on the start record and parseCodexSession recognises the log", () => {
    expect(runAudit(["--start", "cx-1", "--host", "codex"]).status).toBe(0);
    const logFile = join(auditDir, "session-cx-1.log");
    expect(JSON.parse(readFileSync(logFile, "utf-8").trim().split("\n")[0] ?? "")).toMatchObject({
      event: "start",
      host: "codex",
    });
    expect(parseCodexSession("cx-1", logFile)?.unavailable).toBe("transcript");
  });

  // Covers: R71
  it("a Claude start stays an orphan for parseCodexSession, and an unknown host is rejected", () => {
    runAudit(["--start", "cl-1", "--host", "claude"]);
    expect(parseCodexSession("cl-1", join(auditDir, "session-cl-1.log"))).toBeNull();
    const bad = runAudit(["--start", "bad-1", "--host", "gemini"]);
    expect(bad.status).toBe(2);
    expect(existsSync(join(auditDir, "session-bad-1.log"))).toBe(false);
  });
});

describe("audit --start: valid session id", () => {
  it("writes the log inside the audit root", () => {
    const res = runAudit(["--start", "3f9a-b2c_1"]);
    const logFile = join(auditDir, "session-3f9a-b2c_1.log");

    expect(res.status).toBe(0);
    expect(existsSync(logFile)).toBe(true);
    expect(JSON.parse(readFileSync(logFile, "utf-8").trim())).toMatchObject({
      event: "start",
      repo: REPO,
      sessionId: "3f9a-b2c_1",
    });
    // Nothing anywhere else: the audit dir and its single log, and that's it.
    expect(sandboxTree().filter((rel) => rel.endsWith(".log"))).toEqual([
      relative(sandbox, logFile),
    ]);
  });

  it("is idempotent: a second --start does not rewrite the log", () => {
    runAudit(["--start", "sess1"]);
    const before = readFileSync(join(auditDir, "session-sess1.log"), "utf-8");
    const res = runAudit(["--start", "sess1"]);
    expect(res.status).toBe(0);
    expect(readFileSync(join(auditDir, "session-sess1.log"), "utf-8")).toBe(before);
  });

  it("normalizes agent worktree cwd to parent repo instead of phantom agent directory (#764)", () => {
    const wtDir = join(repoDir, ".claude", "worktrees", "agent-a2a999b59fde9ce6c");
    mkdirSync(wtDir, { recursive: true });
    const res = runAudit(["--start", "sess-wt", "--cwd", wtDir]);
    const logFile = join(auditDir, "session-sess-wt.log");

    expect(res.status).toBe(0);
    expect(existsSync(logFile)).toBe(true);
    expect(JSON.parse(readFileSync(logFile, "utf-8").trim())).toMatchObject({
      event: "start",
      repo: REPO,
      sessionId: "sess-wt",
    });
    expect(existsSync(join(auditsRoot, "agent-a2a999b59fde9ce6c"))).toBe(false);
  });
});

/**
 * The report's own header states the navori that GENERATED it, which for a
 * report built after an upgrade is not the one that ran the session. Marking
 * time is the only instant at which both versions are true of the session, so
 * that is where they are recorded.
 */
describe("audit --start: stamps the navori that ran the session", () => {
  /** A recorder hook rendered at `version`, which is what the stamp reads. */
  function renderRecorder(version: string): void {
    mkdirSync(join(repoDir, ".claude", "hooks"), { recursive: true });
    writeFileSync(
      join(repoDir, ".claude", "hooks", "audit-mode-trigger.sh"),
      [
        `# navori:managed start id="audit-mode-trigger-base" hash="abc123" version="${version}" source="@navori/core"`,
        "exit 0",
        '# navori:managed end id="audit-mode-trigger-base"',
        "",
      ].join("\n"),
    );
  }

  function startRecord(id: string): Record<string, unknown> {
    return JSON.parse(readFileSync(join(auditDir, `session-${id}.log`), "utf-8").trim()) as Record<
      string,
      unknown
    >;
  }

  it("reads the rendered version off the recorder's own marker", () => {
    renderRecorder("0.6.5");
    expect(runAudit(["--start", "stamped"]).status).toBe(0);
    expect(startRecord("stamped").navoriRendered).toBe("0.6.5");
  });

  it("records the CLI version alongside it, so a render lag is visible", () => {
    renderRecorder("0.6.5");
    runAudit(["--start", "lagging"]);
    const rec = startRecord("lagging");
    // The two are read from different places on purpose: the marker describes
    // the harness on disk, the binary describes itself. Equal is the healthy
    // case, not the only one.
    expect(rec.navoriCli).toMatch(/^\d+\.\d+\.\d+/);
    expect(rec.navoriRendered).not.toBe(rec.navoriCli);
  });

  it("stamps null rather than guessing when the repo has no rendered recorder", () => {
    expect(runAudit(["--start", "bare"]).status).toBe(0);
    const rec = startRecord("bare");
    expect(rec.navoriRendered).toBeNull();
    // The CLI still knows itself: a null there would mean the binary failed to
    // read its own package.json, which is a different failure.
    expect(rec.navoriCli).toMatch(/^\d+\.\d+\.\d+/);
  });
});

/**
 * The ids are the ones reproduced in #503, each with what the unvalidated
 * builder did with it. `join` normalizes, but `session-` glues to the FIRST
 * segment only — hence "one level absorbed, the rest escapes".
 */
const REJECTED: Array<[string, string]> = [
  ["escapes the audit root into an existing directory", "a/../../../outside/planted"],
  ["lands in the store root without the session- prefix", "a/../../escaped"],
  ["climbs four levels out of the store", "../../../../tmp/nav-escape"],
  ["drops the prefix inside the repo dir", "a/../.."],
  ["relative parent", "../x"],
  ["absolute path", "/abs"],
  ["the current directory", "."],
];

describe("audit --start: a path-shaped session id is rejected (#503)", () => {
  it.each(REJECTED)("rejects an id that %s", (_label, id) => {
    const before = sandboxTree();
    const res = runAudit(["--start", id]);

    // Explicit, handled rejection: exit 1 and a message naming the id.
    expect(res.status).toBe(1);
    expect(res.combined).toContain(id);
    expect(res.combined).toMatch(/invalid session id/i);
    // Not the raw ENOENT + stack the escaped path used to produce.
    expect(res.combined).not.toContain("ENOENT");
    expect(res.combined).not.toMatch(/\n\s+at /);

    // And the other half, the one that actually proves the contract: the
    // rejection wrote nothing, here or anywhere else in the sandbox.
    expect(existsSync(preFixTarget(id))).toBe(false);
    expect(sandboxTree()).toEqual(before);
  });

  it("the fixture really does escape the audit root (guards the guard)", () => {
    // If this ever stops holding, the cases above would pass without testing
    // an escape at all.
    for (const id of ["a/../../../outside/planted", "../../../../tmp/nav-escape"]) {
      expect(preFixTarget(id).startsWith(`${auditsRoot}/`)).toBe(false);
    }
    // These two stay inside the root but lose the `session-` prefix, so
    // discovery can never find them again: orphan logs, not escapes.
    for (const id of ["a/../../escaped", "a/../.."]) {
      expect(preFixTarget(id).startsWith(`${auditsRoot}/`)).toBe(true);
      expect(preFixTarget(id)).not.toContain("/session-");
    }
  });

  it("reports the rejection as JSON under --json", () => {
    const res = runAudit(["--json", "--start", "a/../../escaped"]);
    expect(res.status).toBe(1);
    expect(JSON.parse(res.combined.trim())).toMatchObject({
      ok: false,
      error: "invalid-session-id",
    });
  });
});

describe("audit --stop", () => {
  it("exits 2 cleanly when the session was never marked", () => {
    const res = runAudit(["--stop", "never-marked"]);
    expect(res.status).toBe(2);
    expect(res.combined).toMatch(/not marked|no está marcada/);
    expect(res.combined).not.toMatch(/\n\s+at /);
  });

  it("rejects a path-shaped id too, and seals nothing", () => {
    const before = sandboxTree();
    const res = runAudit(["--stop", "a/../.."]);
    expect(res.status).toBe(1);
    expect(res.combined).toMatch(/invalid session id/i);
    expect(sandboxTree()).toEqual(before);
  });
});

describe("audit --json", () => {
  // Covers: R8
  it.each(["0/N", "0/0", "unknown"])(
    "publishes a read-only %s coverage envelope without synthetic sessions",
    (state) => {
      mkdirSync(join(home, ".claude", "projects"), { recursive: true });
      mkdirSync(join(home, ".codex", "sessions"), { recursive: true });
      mkdirSync(join(repoDir, ".git"), { recursive: true });
      if (state === "0/N") {
        const slug = encodeCwdToSlug(repoDir);
        const dir = join(home, ".claude", "projects", slug);
        mkdirSync(dir);
        writeFileSync(
          join(dir, "host.jsonl"),
          JSON.stringify({
            type: "user",
            sessionId: "host",
            cwd: repoDir,
            isSidechain: false,
            timestamp: "2026-09-20T00:00:00Z",
          }) + "\n",
        );
      }
      if (state === "unknown") writeFileSync(auditDir, "not a directory");
      const before = sandboxTree();
      const res = runAudit(["--json", "--since", "2026-09-20", "--until", "2026-09-20"]);
      expect(res.status).toBe(0);
      const report = JSON.parse(res.combined.trim());
      expect(report.sessions).toEqual([]);
      expect(report.coverage[0]).toMatchObject({
        host: state === "0/N" ? 1 : 0,
        captured: state === "unknown" ? null : 0,
        audited: state === "unknown" ? null : 0,
        ratio: state === "0/N" ? 0 : null,
        reason:
          state === "unknown"
            ? "incomplete-enumeration"
            : state === "0/0"
              ? "empty-population"
              : null,
      });
      expect(report.rangeMetrics["coverage.pct"]).toBe(state === "0/N" ? 0 : null);
      expect(report.totals.tokens.input).toBeNull();
      expect(sandboxTree()).toEqual(before);
    },
  );
  // Covers: R6, R8
  it("reports an empty range with unknown evidence without writing", () => {
    const before = sandboxTree();
    const res = runAudit(["--json"]);
    expect(res.status).toBe(0);
    const report = JSON.parse(res.combined.trim());
    expect(report.schemaVersion).toBe(11);
    expect(report.sessions).toEqual([]);
    expect(report.rangeMetrics["coverage.sessions.host"]).toBeNull();
    expect(report.totals.tokens.input).toBeNull();
    expect(report.signals).toEqual([]);
    expect(sandboxTree()).toEqual(before);
  });
});

/**
 * The defect that motivated spec 0013: a mode-switching flag invoked WITHOUT a
 * value.
 *
 * citty hands a valueless `type: "string"` flag the empty string, not
 * `undefined`, so the guards that read `typeof id === "string" && id` treated
 * `--stop` exactly like "no --stop at all" — and the command fell through to the
 * range report, printing a summary that reads like a successful seal. It failed
 * OPEN: an operator ran it, saw "4 sessions", and nothing had been sealed.
 *
 * Spawning the real CLI matters here for the same reason as the specs above: the
 * whole defect lived in the exit code and in what did (not) reach disk.
 */
describe("audit: a mode flag with no value stops the command (R2)", () => {
  // Covers: R2
  it("--start with no id exits non-zero and writes no report", () => {
    const res = runAudit(["--start"]);
    expect(res.status).not.toBe(0);
    expect(res.combined).toContain("--start");
    // The heart of the defect: not merely "no log" but "no REPORT either".
    // Falling through to the range report is what made the failure look like
    // success.
    expect(sandboxTree().filter((f) => f.endsWith(".md") || f.endsWith(".json"))).toEqual([]);
  });

  // Covers: R2
  it("--stop with no id exits non-zero and writes no report", () => {
    const res = runAudit(["--stop"]);
    expect(res.status).not.toBe(0);
    expect(res.combined).toContain("--stop");
    expect(sandboxTree().filter((f) => f.endsWith(".md") || f.endsWith(".json"))).toEqual([]);
  });

  // Covers: R2
  it("reports the missing value as JSON under --json, not as prose", () => {
    const res = runAudit(["--json", "--stop"]);
    expect(res.status).not.toBe(0);
    const parsed = JSON.parse(res.combined.trim()) as {
      ok: boolean;
      error: string;
    };
    expect(parsed).toMatchObject({ ok: false, error: "missing-flag-value" });
  });

  // Covers: R2
  it("still accepts an empty value for a flag that only carries data", () => {
    // `--since` is a filter, not a mode switch: an empty value falls back to its
    // default instead of silently changing what the command does. The guard must
    // not spread to those, or every optional filter becomes mandatory.
    runAudit(["--start", "sess1"]);
    const res = runAudit(["--json", "--since", "", "--session", "sess1"]);
    // Asserting on the CAUSE, not on the exit code: this run also fails (the
    // fixture session has no transcript), and both failures share `exit 2`. What
    // must not happen is that it fails as a missing flag value.
    const parsed = JSON.parse(res.combined.trim()) as { error: string };
    expect(parsed.error).not.toBe("missing-flag-value");
  });
});

describe("audit --start is the only way in (R1)", () => {
  // Covers: R1
  it("names the log file it created", () => {
    const res = runAudit(["--start", "sess-named"]);
    expect(res.status).toBe(0);
    expect(res.combined).toContain("session-sess-named.log");
    expect(existsSync(join(auditDir, "session-sess-named.log"))).toBe(true);
  });
});

/**
 * Spec 0013, lote D — one directory per audited unit.
 *
 * The old layout named every artifact by RANGE (`audit-<from>-<to>.md`), so two
 * runs covering different ranges left overlapping pairs that nothing ever
 * reconciled — four had piled up in this repo's own store.
 */
describe("audit: output layout (R15, R16, R18)", () => {
  // Covers: R15
  it("gives one session its own directory with log, json and md", () => {
    markedSessionWithTranscript("sess-alpha", "2026-08-25");
    const res = runAudit(["--session", "sess-alpha"]);
    expect(res.status).toBe(0);
    const dir = join(auditDir, "sessions", "2026-08-25-sess-alp");
    for (const file of ["report.md", "report.json"]) {
      expect(existsSync(join(dir, file)), `${file} missing`).toBe(true);
    }
    expect(existsSync(join(dir, "session.log"))).toBe(false);
  });

  // Covers: R16
  it("puts a multi-session report under ranges/, with its index", () => {
    markedSessionWithTranscript("sess-one", "2026-08-25");
    markedSessionWithTranscript("sess-two", "2026-08-26");
    const res = runAudit(["--since", "2026-08-25", "--until", "2026-08-26"]);
    expect(res.status).toBe(0);
    const dir = join(auditDir, "ranges", "2026-08-25--2026-08-27");
    expect(existsSync(join(dir, "report.md"))).toBe(true);
    // The index is what makes the aggregate navigable without opening the JSON.
    const index = readFileSync(join(dir, "sessions.txt"), "utf-8");
    expect(index).toContain("2026-08-25");
    expect(index).toContain("2026-08-26");
    expect(
      index
        .split("\n")
        .filter(Boolean)
        .every((row) => row.split("\t").length === 2),
    ).toBe(true);
  });

  // Covers: R18
  it("leaves reports written by the old layout alone", () => {
    markedSessionWithTranscript("sess-old", "2026-08-25");
    // What a pre-0013 navori left behind, loose in the repo dir.
    const legacy = join(auditDir, "audit-2026-08-01-2026-08-02.md");
    writeFileSync(legacy, "reporte viejo", "utf-8");
    runAudit(["--session", "sess-old"]);
    // Migrating (or deleting) these would be a write the user never asked for,
    // inside a store navori shares with backups.
    expect(readFileSync(legacy, "utf-8")).toBe("reporte viejo");
  });

  // Covers: R15
  it("honours --out verbatim instead of imposing the layout", () => {
    markedSessionWithTranscript("sess-out", "2026-08-25");
    const custom = join(sandbox, "custom-out");
    runAudit(["--session", "sess-out", "--out", custom]);
    // `--out` is the scripting escape hatch; nesting it would defeat it.
    expect(existsSync(join(custom, "report.md"))).toBe(true);
    expect(existsSync(join(custom, "sessions"))).toBe(false);
  });
});

/**
 * R14 — the summary used to lead with `startupTokens`, the SMALLEST of the three
 * numbers in its own report: a run printing "346k" carried 2.3M weighted and
 * 137.5M of raw cache_read in the body.
 */
describe("audit: the summary reports the real spend (R14)", () => {
  // Covers: R6
  it.each([false, true])(
    "prints projected agent counts in the real CLI: observed=%s",
    (observed) => {
      const id = "summary-agents";
      markedSessionWithTranscript(id, "2026-08-25");
      const jsonl = join(sandbox, "transcripts", "enc", `${id}.jsonl`);
      writeFileSync(
        jsonl,
        JSON.stringify({
          type: "assistant",
          sessionId: id,
          cwd: repoDir,
          timestamp: "2026-08-25T10:00:00Z",
          message: { content: observed ? [] : [42] },
        }) + "\n",
      );
      const res = runAudit(["--session", id]);
      expect(res.status).toBe(0);
      expect(res.combined).toContain(`${observed ? 0 : "unavailable"} agentes`);
      if (!observed) expect(res.combined).not.toContain("0 agentes");
    },
  );
  // Covers: R14
  it("names the weighted total, not only startup", () => {
    runAudit(["--start", "sess-sum"]);
    const transcripts = join(sandbox, "transcripts", "enc");
    mkdirSync(transcripts, { recursive: true });
    const jsonl = join(transcripts, "sess-sum.jsonl");
    writeFileSync(
      jsonl,
      `${JSON.stringify({
        type: "assistant",
        sessionId: "sess-sum",
        cwd: repoDir,
        timestamp: "2026-08-25T10:00:00Z",
        message: {
          model: "claude-opus-5",
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_creation_input_tokens: 500_000,
            cache_read_input_tokens: 9_000_000,
          },
        },
      })}\n`,
      "utf-8",
    );
    appendFileSync(
      join(auditDir, "session-sess-sum.log"),
      `${JSON.stringify({ ts: "2026-08-25T10:00:00Z", event: "prompt", prompt: "x", transcript: jsonl })}\n`,
      "utf-8",
    );

    const res = runAudit(["--session", "sess-sum"]);
    expect(res.status).toBe(0);
    expect(res.combined).toContain("ponderado");
    // cache_read is reported too, at its own raw figure: it is real, billed
    // spend at (usually) 0.1x an input token, folded into the weighted total
    // above rather than a separate "not new spend" caveat.
    expect(res.combined).toContain("cache_read");
  });
});

/**
 * Audit finding A3 — one run, two different totals for the same figure.
 *
 * The terminal summary added `thinking` as a fourth addend while the report
 * body never did. Thinking is a SUBSET of output — verified over the 1028
 * assistant messages of transcript `4935c4d7` (CC 2.1.236): `thinking_tokens
 * <= output_tokens` in 100% of them — so the summary was inflated by the whole
 * session's thinking, and the two artifacts of the same command disagreed in
 * print about the only number the tool exists to produce.
 *
 * The invariant now guards the WEIGHTED figure (#927): terminal and body both
 * call `weightedTokens` once, over the same totals, rather than each keeping
 * its own arithmetic — the exact class of drift A3 found in the first place.
 */
describe("audit: one weighted definition, terminal and body (A3)", () => {
  it("prints the same figure in the summary and in the report", () => {
    markedSessionWithTranscript("sess-bill", "2026-08-25", {
      input_tokens: 10,
      output_tokens: 20,
      cache_creation_input_tokens: 500_000,
      cache_read_input_tokens: 9_000_000,
      output_tokens_details: { thinking_tokens: 400_000 },
    });

    const res = runAudit(["--session", "sess-bill"]);
    expect(res.status).toBe(0);

    const dir = join(auditDir, "sessions", "2026-08-25-sess-bil");
    const bodyText = readFileSync(join(dir, "report.md"), "utf-8");
    const raw = /TOTAL (\S+) tokens/.exec(bodyText);
    const bodyWeighted = /\((\S+) ponderados/.exec(bodyText);
    const terminal = /ponderado\s+(\S+) tok/.exec(res.combined);
    // input + output + cacheCreation, thinking NOT added on top of output.
    expect(raw?.[1]).toBe("500k");
    // input×1 + output×20×5 + cacheCreation×500_000×1.25 + cacheRead×9_000_000×0.1
    // = 10 + 100 + 625_000 + 900_000 = 1_525_110 → "1.5M".
    expect(bodyWeighted?.[1]).toBe("1.5M");
    expect(terminal?.[1]).toBe(bodyWeighted?.[1]);

    // Guards the guard: with no thinking in the fixture the two figures would
    // agree for the wrong reason.
    const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf-8")) as {
      totals: { tokens: { thinking: number } };
    };
    expect(report.totals.tokens.thinking).toBe(400_000);
  });
});

/**
 * Audit finding A1 — the only sealing flow the tool teaches could never work.
 *
 * The report prints `navori audit --stop <id8>` for a session still running,
 * but `--stop` composed the log name from the literal value and the file
 * carries the FULL uuid, so an 8-char prefix named nothing and the command
 * exited 2 every single time. `--session` had accepted prefixes all along;
 * `--stop` is now symmetric with it.
 */
describe("audit --stop resolves a prefix, like --session (A1)", () => {
  /** The `stop` records appended to a session's log. */
  function stopEvents(id: string): unknown[] {
    const raw = readFileSync(join(auditDir, `session-${id}.log`), "utf-8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { event?: string })
      .filter((rec) => rec.event === "stop");
  }

  it("seals the session an 8-char prefix names — the exact advice the report gives", () => {
    markedSessionWithTranscript("abcdef0123456789", "2026-08-25");
    const res = runAudit(["--stop", "abcdef01"]);
    expect(res.status).toBe(0);
    expect(stopEvents("abcdef0123456789")).toHaveLength(1);
  });

  it("still seals on the full id, unchanged", () => {
    markedSessionWithTranscript("sess-full", "2026-08-25");
    const res = runAudit(["--stop", "sess-full"]);
    expect(res.status).toBe(0);
    expect(stopEvents("sess-full")).toHaveLength(1);
  });

  it("refuses an ambiguous prefix, names the candidates and seals nothing", () => {
    markedSessionWithTranscript("dupli-aaa", "2026-08-25");
    markedSessionWithTranscript("dupli-bbb", "2026-08-26");
    const res = runAudit(["--stop", "dupli"]);

    expect(res.status).toBe(2);
    // Sealing the wrong log appends a `stop` event that cannot be taken back,
    // so the ambiguity is an error and never a guess.
    expect(res.combined).toMatch(/ambiguo|ambiguous/);
    expect(res.combined).toContain("dupli-aaa");
    expect(res.combined).toContain("dupli-bbb");
    expect(stopEvents("dupli-aaa")).toEqual([]);
    expect(stopEvents("dupli-bbb")).toEqual([]);
  });

  it("reports the ambiguity as JSON under --json", () => {
    markedSessionWithTranscript("dupli-aaa", "2026-08-25");
    markedSessionWithTranscript("dupli-bbb", "2026-08-26");
    const res = runAudit(["--json", "--stop", "dupli"]);
    expect(res.status).toBe(2);
    const parsed = JSON.parse(res.combined.trim()) as { matches: string[] };
    expect(parsed).toMatchObject({
      ok: false,
      error: "ambiguous-session-prefix",
      prefix: "dupli",
    });
    // Order is by marking time, which two spawns a few ms apart make a poor
    // thing to assert on; the set is what the human needs to disambiguate.
    expect([...parsed.matches].sort()).toEqual(["dupli-aaa", "dupli-bbb"]);
  });

  it("keeps saying 'not marked' for a prefix that matches nothing", () => {
    markedSessionWithTranscript("sess-lonely", "2026-08-25");
    const res = runAudit(["--stop", "zzz"]);
    expect(res.status).toBe(2);
    expect(res.combined).toMatch(/not marked|no está marcada/);
    expect(stopEvents("sess-lonely")).toEqual([]);
  });

  it("accepts `latest`, the same word --session takes", () => {
    // Routing through `findMarkedSessions` gave `--stop latest` for free. It is
    // pinned here rather than left as a side effect, because this path appends
    // to an append-only log: whatever it resolves to, it must be deliberate.
    // One marked session, so `latest` names it without depending on the
    // marking-time ordering that two spawns milliseconds apart make unstable.
    markedSessionWithTranscript("sess-only", "2026-08-25");
    const res = runAudit(["--stop", "latest"]);
    expect(res.status).toBe(0);
    expect(stopEvents("sess-only")).toHaveLength(1);
  });
});

/**
 * #675 — `--start` accepted any id the traversal guard allowed and answered
 * "audit-mode active" for all of them.
 *
 * The case found in the real store was `session-p.log`: a one-letter id, two
 * lines, no transcript that could ever resolve — and the ONLY session of that
 * repo, so `bonum-nexus` counted as audited on nothing at all.
 */
describe("audit --start over an id that names no session (#675)", () => {
  /** A transcript where `resolveTranscript`'s directory scan will find it. */
  function transcriptFor(id: string): void {
    const dir = join(home, ".claude", "projects", "enc");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.jsonl`), "", "utf-8");
  }

  it("warns, without refusing to mark the session", () => {
    const res = runAudit(["--start", "p"]);

    // Still marked: a session whose transcript is one second late is a real
    // session, and refusing it would be a worse failure than a warning.
    expect(res.status).toBe(0);
    expect(existsSync(join(auditDir, "session-p.log"))).toBe(true);
    expect(res.combined).toMatch(/transcript/i);
    // The remedy has to be the true one: `--disarm` clears a pending `--arm`,
    // it does not undo a `--start`, so the message names the file to delete.
    expect(res.combined).toContain(join(auditDir, "session-p.log"));
  });

  it("says nothing when the id does resolve a transcript", () => {
    transcriptFor("sess-real");
    const res = runAudit(["--start", "sess-real"]);
    expect(res.status).toBe(0);
    expect(res.combined).not.toMatch(/No transcript found|No encontré transcript/);
  });

  it("names the orphans in --json instead of only in the human note", () => {
    // The human path already printed "sin transcript <ids>"; `--json` — the
    // half a CI or an agent reads — could not see them at all.
    markedSessionWithTranscript("sess-good", "2026-08-25");
    runAudit(["--start", "sess-orphan"]);

    const res = runAudit(["--json"]);
    expect(res.status).toBe(0);
    const report = JSON.parse(res.combined) as {
      schemaVersion: number;
      orphanSessions: string[];
    };
    expect(report.schemaVersion).toBe(11);
    expect(report.orphanSessions).toHaveLength(1);
    expect(report.orphanSessions[0]).toMatch(/^unknown-[a-f0-9]{12}$/);
    expect(res.combined).not.toContain("sess-orp");
    expect(JSON.parse(runAudit(["--json"]).combined).orphanSessions).toEqual(report.orphanSessions);
  });

  it("names them too when NO session has a transcript", () => {
    runAudit(["--start", "sess-ghost"]);
    const res = runAudit(["--json"]);
    expect(res.status).toBe(0);
    const payload = JSON.parse(res.combined) as {
      sessions: unknown[];
      orphanSessions: string[];
    };
    expect(payload.sessions).toEqual([]);
    expect(payload.orphanSessions).toHaveLength(1);
    expect(payload.orphanSessions[0]).toMatch(/^unknown-[a-f0-9]{12}$/);
    expect(res.combined).not.toContain("sess-gho");
    expect(JSON.parse(runAudit(["--json"]).combined).orphanSessions).toEqual(
      payload.orphanSessions,
    );
  });
});

/**
 * Spec 0039 R61, R62, R68, R69 — the range report over every audited repo, and
 * its snapshot. Spawned like the rest of this file: the assertions are about
 * where bytes land and which exit code comes back.
 */
describe("audit --all-repos / --snapshot / --copy-to / --compare (R61, R62, R68, R69)", () => {
  const SECOND = "second-repo";
  let secondDir: string;
  const slug = (path: string): string => path.replace(/[^a-zA-Z0-9_-]/g, "-");

  /** A session of `dir`'s repo with a transcript the CLI can find. */
  function markIn(dir: string, id: string, day: string): void {
    runAudit(["--cwd", dir, "--start", id]);
    const transcripts = join(sandbox, "transcripts", "enc");
    mkdirSync(transcripts, { recursive: true });
    const jsonl = join(transcripts, `${id}.jsonl`);
    writeFileSync(
      jsonl,
      `${JSON.stringify({
        type: "assistant",
        sessionId: id,
        cwd: dir,
        timestamp: `${day}T10:00:00Z`,
        message: {
          model: "claude-opus-5",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      })}\n`,
      "utf-8",
    );
    appendFileSync(
      join(auditsRoot, dir.split("/").pop() ?? "", `session-${id}.log`),
      `${JSON.stringify({ ts: `${day}T10:00:00Z`, event: "prompt", prompt: "x", transcript: jsonl })}\n`,
      "utf-8",
    );
  }

  function hostSession(dir: string, name: string): void {
    const d = join(home, ".claude", "projects", slug(dir));
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, name), "", "utf-8");
  }

  const snapshotsUnder = (dir: string): string[] =>
    existsSync(dir) ? walk(dir).filter((p) => p.includes("snapshot-")) : [];

  beforeEach(() => {
    secondDir = join(sandbox, SECOND);
    mkdirSync(secondDir, { recursive: true });
  });

  // Covers: R61, R62
  it("aggregates every audited repo, with a row and a coverage figure per repo", () => {
    markIn(repoDir, "sess-a", "2026-08-25");
    markIn(secondDir, "sess-b", "2026-08-26");
    // Host sessions: the audited one, an unaudited one, and one in an agent
    // worktree of the same repo.
    hostSession(repoDir, "sess-a.jsonl");
    hostSession(repoDir, "unaudited.jsonl");
    hostSession(`${repoDir}/.claude/worktrees/agent-x`, "wt.jsonl");
    hostSession(secondDir, "sess-b.jsonl");

    const res = runAudit(["--all-repos", "--json"]);
    expect(res.status, res.combined).toBe(0);
    const report = JSON.parse(res.combined) as {
      repos: Array<{ repo: string; audited: number; host: number | null }>;
      rangeMetrics: Record<string, number | null>;
      totals: { sessions: number };
    };
    expect(report.totals.sessions).toBe(2);
    expect(report.repos).toHaveLength(2);
    expect(new Set(report.repos.map((row) => row.repo)).size).toBe(2);
    for (const row of report.repos) {
      expect(row).toEqual({
        repo: expect.stringMatching(/^unknown-[a-f0-9]{12}$/),
        audited: 1,
        host: null,
      });
    }
    expect(res.combined).not.toContain(REPO);
    expect(res.combined).not.toContain(SECOND);
    expect(JSON.parse(runAudit(["--all-repos", "--json"]).combined).repos).toEqual(report.repos);
    expect(report.rangeMetrics["coverage.sessions.audited"]).toBe(2);
    expect(report.rangeMetrics["coverage.sessions.host"]).toBeNull();
    expect(report.rangeMetrics["coverage.pct"]).toBeNull();
  });

  // Covers: R62
  it("reports the coverage of a single-repo range too", () => {
    markIn(repoDir, "sess-a", "2026-08-25");
    hostSession(repoDir, "sess-a.jsonl");
    hostSession(repoDir, "other.jsonl");
    const res = runAudit(["--json"]);
    const metrics = (
      JSON.parse(res.combined) as {
        rangeMetrics: Record<string, number | null>;
      }
    ).rangeMetrics;
    expect(metrics["coverage.sessions.audited"]).toBe(1);
    expect(metrics["coverage.sessions.host"]).toBeNull();
  });

  // Covers: R6, R8
  it("rejects schema11 snapshot production before any artifact writes", () => {
    markIn(repoDir, "sess-a", "2026-08-25");
    const before = sandboxTree();
    const res = runAudit(["--snapshot", "base"]);
    expect(res.status, res.combined).toBe(2);
    expect(res.combined).toContain("snapshot-schema-unavailable");
    expect(sandboxTree()).toEqual(before);
  });

  // Covers: R68
  it("rejects a snapshot name that would leave the audit root", () => {
    markIn(repoDir, "sess-a", "2026-08-25");
    const res = runAudit(["--snapshot", "../escape"]);
    expect(res.status).toBe(1);
    expect(res.combined).toMatch(/Invalid snapshot name/);
    expect(existsSync(join(auditDir, "ranges", "escape"))).toBe(false);
  });

  // Covers: R6
  it("rejects schema11 snapshot copies without creating or overwriting destinations", () => {
    execFileSync("git", ["init", "-q"], { cwd: repoDir });
    mkdirSync(join(repoDir, "docs", "deep"), { recursive: true });
    markIn(repoDir, "sess-a", "2026-08-25");

    const res = runAudit([
      "--cwd",
      join(repoDir, "docs", "deep"),
      "--snapshot",
      "base",
      "--copy-to",
      "docs/base.json",
    ]);
    expect(res.status, res.combined).toBe(2);
    expect(existsSync(join(repoDir, "docs", "base.json"))).toBe(false);
    writeFileSync(join(repoDir, "docs", "base.json"), "preserved");

    const again = runAudit([
      "--cwd",
      repoDir,
      "--snapshot",
      "base2",
      "--copy-to",
      "docs/base.json",
    ]);
    expect(again.status).toBe(2);
    expect(readFileSync(join(repoDir, "docs", "base.json"), "utf-8")).toBe("preserved");
  });

  // Covers: R6, R8
  it("rejects all-repos schema11 snapshots at every copy destination", () => {
    markIn(repoDir, "sess-a", "2026-08-25");
    markIn(secondDir, "sess-b", "2026-08-26");

    const inside = runAudit([
      "--all-repos",
      "--snapshot",
      "all",
      "--copy-to",
      join(secondDir, "all.json"),
    ]);
    expect(inside.status).toBe(2);
    expect(inside.combined).toContain("snapshot-schema-unavailable");
    expect(existsSync(join(secondDir, "all.json"))).toBe(false);

    // A relative path resolves from the toplevel of the cwd repo: also inside.
    execFileSync("git", ["init", "-q"], { cwd: repoDir });
    const relative = runAudit(["--all-repos", "--snapshot", "all2", "--copy-to", "all.json"]);
    expect(relative.status).toBe(2);
    expect(existsSync(join(repoDir, "all.json"))).toBe(false);

    const outside = join(sandbox, "elsewhere", "all.json");
    const ok = runAudit(["--all-repos", "--snapshot", "all3", "--copy-to", outside]);
    expect(ok.status, ok.combined).toBe(2);
    expect(existsSync(outside)).toBe(false);
    expect(snapshotsUnder(join(auditsRoot, "_all-repos"))).toEqual([]);
    // `_all-repos` is not a repo: it must not show up as a row.
    const rows = (
      JSON.parse(runAudit(["--all-repos", "--json"]).combined) as {
        repos: Array<{ repo: string }>;
      }
    ).repos;
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.repo)).size).toBe(2);
    for (const row of rows) {
      expect(row.repo).toMatch(/^unknown-[a-f0-9]{12}$/);
      expect(row.repo).not.toBe(REPO);
      expect(row.repo).not.toBe(SECOND);
    }
  });

  // Covers: R6
  it("preserves legacy baselines while rejecting comparison against schema11 reports", () => {
    markIn(repoDir, "sess-a", "2026-08-25");
    const snap = {
      snapshotFormat: 1,
      generatedBy: "navori@0.11.0",
      scope: "repo",
      range: { from: "2026-08-25", to: "2026-08-25" },
      rangeMetrics: { "sessions.total": 5 },
    };
    const prior = join(sandbox, "prior.json");
    writeFileSync(prior, JSON.stringify(snap), "utf-8");

    const res = runAudit(["--compare", prior]);
    expect(res.status, res.combined).toBe(2);
    expect(res.combined).toContain("snapshot-schema-unavailable");
    expect(JSON.parse(readFileSync(prior, "utf-8"))).toEqual(snap);
  });

  // Covers: R68, R69
  it("rejects combinations that would write nothing useful or the wrong thing", () => {
    markIn(repoDir, "sess-a", "2026-08-25");
    const copyOnly = runAudit(["--copy-to", join(sandbox, "x.json")]);
    expect(copyOnly.status).toBe(2);
    expect(existsSync(join(sandbox, "x.json"))).toBe(false);

    expect(runAudit(["--json", "--snapshot", "x"]).status).toBe(2);
    expect(runAudit(["--all-repos", "--start", "sess-z"]).status).toBe(2);
    expect(runAudit(["--all-repos", "--session", "latest"]).status).toBe(2);
    expect(runAudit(["--compare", join(sandbox, "missing.json")]).status).toBe(1);
  });
});
