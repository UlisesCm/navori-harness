import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

function runAudit(args: string[]): CliResult {
  const r = spawnSync("node", [CLI, "audit", "--cwd", repoDir, ...args], {
    encoding: "utf-8",
    env: { ...process.env, HOME: home, NAVORI_AUDITS_ROOT: auditsRoot, FORCE_COLOR: "0" },
  });
  return { status: r.status ?? -1, combined: (r.stdout ?? "") + (r.stderr ?? "") };
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
  mkdirSync(auditsRoot, { recursive: true });
  // An existing directory outside the audit root: without it the escape fails
  // with ENOENT, which is the LESS severe half of the defect. With it, the
  // pre-fix CLI writes there and reports success.
  mkdirSync(join(sandbox, "nested", "store", "outside"), { recursive: true });
  mkdirSync(repoDir, { recursive: true });
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
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
  it("reports no-marked-sessions and exits 2 when the repo has none", () => {
    const res = runAudit(["--json"]);
    expect(res.status).toBe(2);
    expect(JSON.parse(res.combined.trim())).toEqual({
      ok: false,
      error: "no-marked-sessions",
      repo: REPO,
    });
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
    const parsed = JSON.parse(res.combined.trim()) as { ok: boolean; error: string };
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
  /** Mark a session and give it a transcript the CLI can actually find. */
  function markedSessionWithTranscript(id: string, day: string): void {
    runAudit(["--start", id]);
    const transcripts = join(sandbox, "transcripts", "enc");
    mkdirSync(transcripts, { recursive: true });
    const jsonl = join(transcripts, `${id}.jsonl`);
    writeFileSync(
      jsonl,
      `${JSON.stringify({
        type: "assistant",
        timestamp: `${day}T10:00:00Z`,
        message: { model: "claude-opus-5", usage: { input_tokens: 1, output_tokens: 1 } },
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

  // Covers: R15
  it("gives one session its own directory with log, json and md", () => {
    markedSessionWithTranscript("sess-alpha", "2026-08-25");
    const res = runAudit(["--session", "sess-alpha"]);
    expect(res.status).toBe(0);
    const dir = join(auditDir, "sessions", "2026-08-25-sess-alp");
    for (const file of ["report.md", "report.json", "session.log"]) {
      expect(existsSync(join(dir, file)), `${file} missing`).toBe(true);
    }
  });

  // Covers: R16
  it("puts a multi-session report under ranges/, with its index", () => {
    markedSessionWithTranscript("sess-one", "2026-08-25");
    markedSessionWithTranscript("sess-two", "2026-08-26");
    const res = runAudit([]);
    expect(res.status).toBe(0);
    const dir = join(auditDir, "ranges", "2026-08-25--2026-08-26");
    expect(existsSync(join(dir, "report.md"))).toBe(true);
    // The index is what makes the aggregate navigable without opening the JSON.
    const index = readFileSync(join(dir, "sessions.txt"), "utf-8");
    expect(index).toContain("2026-08-25-sess-one");
    expect(index).toContain("2026-08-26-sess-two");
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
 * numbers in its own report: a run printing "346k" carried 2.3M billable and
 * 137.5M of cache_read in the body.
 */
describe("audit: the summary reports the real spend (R14)", () => {
  // Covers: R14
  it("names the billable total, not only startup", () => {
    runAudit(["--start", "sess-sum"]);
    const transcripts = join(sandbox, "transcripts", "enc");
    mkdirSync(transcripts, { recursive: true });
    const jsonl = join(transcripts, "sess-sum.jsonl");
    writeFileSync(
      jsonl,
      `${JSON.stringify({
        type: "assistant",
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
    expect(res.combined).toContain("facturable");
    // cache_read is reported too, and separately: it accrues every turn and is
    // not new spend, so folding it into one number would mislead the other way.
    expect(res.combined).toContain("cache_read");
  });
});
