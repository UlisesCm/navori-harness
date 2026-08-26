import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
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
