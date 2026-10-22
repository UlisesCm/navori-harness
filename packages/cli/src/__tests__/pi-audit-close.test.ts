import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createAuditReadBudget } from "../lib/audit/model.ts";
import { parsePiSession } from "../lib/audit/pi-session.ts";
import { readAuditJsonl } from "../lib/audit/paths.ts";
import { absorbAuditMetadataSpool, ensureAuditSpoolDir } from "../lib/audit/cli-event.ts";

type Host = "claude" | "codex" | "pi";
interface Registration {
  engine: Host;
  event: string;
  command: string;
}
interface Sandbox {
  root: string;
  project: string;
  binDir: string;
  cleanup: () => void;
}
interface BenchHooks {
  createSandbox: () => Sandbox;
  readRegistrations: () => Registration[];
  scenarioEnvironment: (
    sandbox: Sandbox,
    scenario: string,
    reg: Registration,
    audit: "active" | "root",
  ) => NodeJS.ProcessEnv;
  writePayload: (sandbox: Sandbox, scenario: string, reg: Registration) => string;
}

// Same synthetic private factory/payload as the original #1355 benchmark diagnostic.
const imported: unknown = await import(
  pathToFileURL(resolve(import.meta.dirname, "../../../../scripts/js/bench-hooks.mjs")).href
);
const bench = imported as BenchHooks;
let sandbox: Sandbox;
beforeAll(() => {
  sandbox = bench.createSandbox();
});
afterAll(() => {
  sandbox.cleanup();
});

function registration(host: Host): Registration {
  const reg = bench
    .readRegistrations()
    .find(
      (value: Registration): boolean =>
        value.engine === host &&
        value.event === "SessionEnd" &&
        value.command.includes("audit-mode-close"),
    );
  if (!reg) throw new Error(`Missing close registration for ${host}`);
  return reg;
}
function fixture(
  host: Host = "pi",
  audit: "active" | "root" = "active",
): { env: NodeJS.ProcessEnv; log: string; dir: string } {
  const env = bench.scenarioEnvironment(sandbox, "SessionEnd", registration(host), audit);
  const dir = join(String(env.NAVORI_AUDITS_ROOT), "project");
  return { env, dir, log: join(dir, "session-bench-session.log") };
}
const close = { event: "session-end", reason: "prompt_input_exit", tsMs: 100 };

function direct(
  env: NodeJS.ProcessEnv,
  input: unknown = close,
  host: Host = "pi",
): SpawnSyncReturns<string> {
  return spawnSync(
    join(sandbox.binDir, "navori"),
    [
      "audit",
      "--record-metadata",
      "--host",
      host,
      "--root-session",
      "bench-session",
      "--repo",
      "project",
      "--root",
      String(env.NAVORI_AUDITS_ROOT),
    ],
    {
      cwd: sandbox.project,
      env,
      input: JSON.stringify(input),
      encoding: "utf8",
      timeout: 5000,
    },
  );
}

describe("Pi audit close through the real writer (#1355)", () => {
  it.each(["claude", "codex", "pi"] as const)(
    "appends a real %s hook close while preserving the header",
    (host: Host) => {
      const reg = registration(host);
      const payload = bench.writePayload(sandbox, "SessionEnd", reg);
      const { env, log } = fixture(host);
      const header = readFileSync(log);
      const result = spawnSync("bash", ["-c", reg.command], {
        cwd: sandbox.project,
        env,
        input: readFileSync(payload),
        encoding: "utf8",
        timeout: 5000,
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
      const bytes = readFileSync(log);
      expect(bytes.subarray(0, header.length)).toEqual(header);
      const rows: Array<Record<string, unknown>> = bytes
        .toString("utf8")
        .trim()
        .split("\n")
        .map(
          (line: string): Record<string, unknown> => JSON.parse(line) as Record<string, unknown>,
        );
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({
        event: "session-end",
        host,
        reason: "prompt_input_exit",
        rootSessionId: "bench-session",
        wireVersion: 1,
      });
      expect(rows[1]?.eventId).toEqual(expect.any(String));
      if (host === "pi") {
        const session = join(sandbox.root, "synthetic-pi-session.jsonl");
        writeFileSync(
          session,
          JSON.stringify({ type: "session", id: "bench-session", cwd: sandbox.project }) + "\n",
        );
        expect(
          parsePiSession("bench-session", log, session, {
            records: rows,
            budget: createAuditReadBudget(),
            reading: readAuditJsonl(log, () => {}),
          }),
        ).toMatchObject({ sealed: true, endReason: "prompt_input_exit" });
      }
    },
  );

  it("accepts direct Pi close without stderr or creating a spool", () => {
    const { env, log, dir } = fixture();
    const before = readdirSync(dir);
    const result = direct(env);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(2);
    expect(readdirSync(dir)).toEqual(before);
  });

  it("rejects a foreign host marker without relabeling it", () => {
    const { env, log } = fixture("claude");
    const before = readFileSync(log);
    expect(direct(env).status).toBe(2);
    expect(readFileSync(log)).toEqual(before);
  });

  it("rejects unsafe permissions without repairing the file", () => {
    const { env, log } = fixture();
    chmodSync(log, 0o644);
    const before = readFileSync(log);
    expect(direct(env).status).toBe(2);
    expect(readFileSync(log)).toEqual(before);
  });

  it("skips an unmarked Pi close without creating a marker or spool", () => {
    const { env, dir } = fixture("pi", "root");
    expect(existsSync(dir)).toBe(false);
    expect(direct(env).status).toBe(0);
    expect(existsSync(dir)).toBe(false);
  });

  it.each([
    { ...close, reason: "private free text" },
    { ...close, eventId: "caller-authored" },
    { ...close, reason: "x".repeat(2049) },
    {
      event: "hook",
      name: "probe",
      phase: "SessionStart",
      verdict: "allow",
      source: "core",
      ms: 0,
      tsMs: 100,
    },
  ])("rejects unsupported Pi metadata without appending or spooling: %#", (input: unknown) => {
    const { env, log, dir } = fixture();
    const before = readFileSync(log);
    const files = readdirSync(dir);
    expect(direct(env, input).status).toBe(2);
    expect(readFileSync(log)).toEqual(before);
    expect(readdirSync(dir)).toEqual(files);
  });

  it("keeps Pi startup capture and spool APIs disabled", () => {
    const { env, dir } = fixture();
    const request = {
      host: "pi" as const,
      rootSessionId: "bench-session",
      repo: "project",
      auditRoot: String(env.NAVORI_AUDITS_ROOT),
    };
    expect(ensureAuditSpoolDir(request)).toBe(false);
    expect(absorbAuditMetadataSpool(request)).toMatchObject({ status: "invalid", recorded: 0 });
    expect(existsSync(join(dir, "pending-bench-session.jsonl"))).toBe(false);
  });
});
