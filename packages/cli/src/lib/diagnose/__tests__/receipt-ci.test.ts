import { describe, expect, it } from "vitest";
import {
  verifyReceiptCi,
  type CiGateConfig,
  type Exec,
  type ExecResult,
  type ReceiptCiDeps,
} from "../receipt-ci.ts";
import type { ReceiptOptions, ReceiptResult } from "../receipt.ts";

const SHA = "a".repeat(40);
const CI: CiGateConfig = {
  workflow: ".github/workflows/ci.yml",
  jobs: ["checks", "test (1)", "test-merge"],
  label: "full",
  untrustedPaths: [".github/**", "package.json"],
  hookPaths: ["hooks/**", "plugins/*/scripts/**"],
  hooksCommand: "run-hooks",
};
const GATE = { fast: "f", full: "g" };
const RECEIPT: ReceiptOptions = {
  cwd: "/repo",
  feature: "feat",
  target: "dev",
  dir: ".navori/state",
  gate: "g",
};

const ok = (stdout = ""): ExecResult => ({ status: 0, stdout, stderr: "" });
const fail = (status = 1, stderr = ""): ExecResult => ({ status, stdout: "", stderr });
const json = (value: unknown): ExecResult => ok(JSON.stringify(value));

interface Scenario {
  head?: string;
  porcelain?: string;
  pr?: unknown | ExecResult;
  ancestor?: ExecResult;
  changed?: string[];
  baseConfig?: ExecResult;
  headConfig?: ExecResult;
  fetch?: ExecResult;
  hooks?: ExecResult;
  runs?: Array<Record<string, unknown>> | ExecResult;
  jobs?: Array<{ name: string; conclusion: string | null }>;
  /** Jobs keyed by `<id>/<attempt>` or by `<id>`; runs not listed fall back to `jobs`. */
  jobsByRun?: Record<string, Array<{ name: string; conclusion: string | null }>>;
  receipt?: Partial<ReceiptResult>;
  receiptExit?: number;
}

const run = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 10,
  run_attempt: 1,
  status: "completed",
  conclusion: "success",
  head_sha: SHA,
  ...over,
});
const green = (): Array<{ name: string; conclusion: string | null }> =>
  CI.jobs.map((name) => ({ name, conclusion: "success" }));
/**
 * Jobs of a run whose `if` skipped the tests, as GitHub reports it (run 42148871569): the
 * skipped matrix shows once as `test`, never as `test (1)`.
 */
const skippedTests = (checks = "success"): Array<{ name: string; conclusion: string | null }> => [
  { name: "checks", conclusion: checks },
  { name: "test", conclusion: "skipped" },
  { name: "test-merge", conclusion: "skipped" },
];
const config = (qualityGate: unknown): ExecResult => json({ qualityGate });

/** Builds a fake `Exec` from a scenario and records every call. */
function harness(s: Scenario = {}): {
  deps: Partial<ReceiptCiDeps>;
  calls: string[];
  clock: { t: number };
} {
  const calls: string[] = [];
  const clock = { t: 0 };
  const exec: Exec = (command, args) => {
    const line = `${command} ${args.join(" ")}`;
    calls.push(line);
    if (command === "sh") return s.hooks ?? ok();
    if (command === "gh") {
      if (args[0] === "pr")
        return isResult(s.pr)
          ? s.pr
          : json(
              s.pr ?? {
                headRefOid: SHA,
                isCrossRepository: false,
                baseRefName: "dev",
              },
            );
      if (line.includes("/jobs")) {
        const [, id, attempt] = /\/runs\/(\d+)\/attempts\/(\d+)\//.exec(line) ?? [];
        const byRun = s.jobsByRun?.[`${id}/${attempt}`] ?? s.jobsByRun?.[`${id}`];
        return json({ jobs: byRun ?? s.jobs ?? green() });
      }
      return Array.isArray(s.runs) || s.runs === undefined
        ? json({ workflow_runs: s.runs ?? [run()] })
        : s.runs;
    }
    if (args[0] === "rev-parse") return ok(`${s.head ?? SHA}\n`);
    if (args[0] === "status") return ok(s.porcelain ?? "");
    if (args[0] === "fetch") return s.fetch ?? ok();
    if (args[0] === "merge-base") return s.ancestor ?? ok();
    if (args[0] === "diff") return ok((s.changed ?? ["src/a.ts"]).join("\0"));
    if (args[0] === "show")
      return args[1]!.startsWith("HEAD:")
        ? (s.headConfig ?? config(GATE))
        : (s.baseConfig ?? config(GATE));
    return fail();
  };
  const receipt: ReceiptResult = {
    formatVersion: 1,
    target: "dev",
    targetSha: "b",
    headSha: SHA,
    status: "ok",
    uncovered: [],
    drift: [],
    fresh: false,
    stale: ["gate"],
    consumed: true,
    gateKind: "ci",
    error: null,
    ...s.receipt,
  };
  return {
    calls,
    clock,
    deps: {
      exec,
      check: () => ({ exitCode: s.receiptExit ?? 0, result: receipt }),
      now: () => clock.t,
      sleep: (ms) => {
        clock.t += ms;
        return Promise.resolve();
      },
    },
  };
}
function isResult(value: unknown): value is ExecResult {
  return typeof value === "object" && value !== null && "stdout" in value && "status" in value;
}

async function verify(s: Scenario = {}, waitMs = 0) {
  const h = harness(s);
  const out = await verifyReceiptCi(
    { receipt: RECEIPT, ci: CI, pr: 7, waitMs, pollMs: 1000 },
    h.deps,
  );
  return { ...out, calls: h.calls, clock: h.clock };
}

describe("verifyReceiptCi", () => {
  it("happy path: green run on the exact SHA", async () => {
    const { exitCode, result } = await verify();
    expect(exitCode).toBe(0);
    expect(result).toMatchObject({ status: "ok", runId: 10, runAttempt: 1, headSha: SHA });
    expect(result.jobs.every((job) => job.conclusion === "success")).toBe(true);
    expect(result.hooks).toEqual({ paths: [], ran: false, exitCode: null });
  });

  it("PR head differs from local HEAD: no evidence", async () => {
    const { exitCode, result } = await verify({
      pr: { headRefOid: "c".repeat(40), isCrossRepository: false, baseRefName: "dev" },
    });
    expect(exitCode).toBe(2);
    expect(result).toMatchObject({ status: "no-evidence" });
    expect(result.reason).toContain("push first");
  });

  it("cross-repository PR is refused", async () => {
    const { result } = await verify({
      pr: { headRefOid: SHA, isCrossRepository: true, baseRefName: "dev" },
    });
    expect(result.status).toBe("refused");
  });

  it("dirty tree: no evidence", async () => {
    const { result } = await verify({ porcelain: " M src/a.ts\0" });
    expect(result).toMatchObject({ status: "no-evidence", reason: "working tree is not clean" });
  });

  it("receipt drift or uncovered files: no evidence", async () => {
    const drift = await verify({
      receipt: { drift: [{ path: "x", blob: "b", kind: "changed" }], status: "findings" },
      receiptExit: 2,
    });
    expect(drift.result.status).toBe("no-evidence");
    const uncovered = await verify({
      receipt: { uncovered: ["y"], status: "findings" },
      receiptExit: 2,
    });
    expect(uncovered.result.reason).toContain("does not match HEAD");
  });

  it("receipt absent, or not signed with ci, or stale inputs: no evidence", async () => {
    expect(
      (await verify({ receipt: { error: "receipt is absent" }, receiptExit: 1 })).result.reason,
    ).toContain("receipt is absent");
    expect((await verify({ receipt: { gateKind: "full" } })).result.reason).toContain(
      "--gate-ran ci",
    );
    expect((await verify({ receipt: { stale: ["gate", "inputs"] } })).result.reason).toContain(
      "inputs",
    );
  });

  it("target is not an ancestor of HEAD: no evidence", async () => {
    const { result, calls } = await verify({ ancestor: fail(1) });
    expect(result.reason).toContain("not an ancestor");
    expect(calls.some((c) => c.startsWith("gh api"))).toBe(false);
  });

  it("target cannot be fetched: no evidence, never the stale local ref", async () => {
    const { result, calls } = await verify({ fetch: fail(1) });
    expect(result.status).toBe("no-evidence");
    expect(result.reason).toContain("cannot fetch origin/dev");
    expect(calls.some((c) => c.startsWith("git merge-base"))).toBe(false);
  });

  it("a skipped or missing required job is not success", async () => {
    const skipped = await verify({
      jobs: [
        { name: "checks", conclusion: "success" },
        { name: "test (1)", conclusion: "skipped" },
      ],
    });
    expect(skipped.result.status).toBe("no-evidence");
    expect(skipped.result.reason).toContain("test (1)=skipped");
    expect(skipped.result.reason).toContain("test-merge=missing");
  });

  it("a cancelled run is no evidence", async () => {
    const run1 = await verify({ runs: [run({ conclusion: "cancelled" })] });
    expect(run1.result.reason).toContain("cancelled");
    const jobs = green();
    jobs[1]!.conclusion = "cancelled";
    expect((await verify({ jobs })).result.status).toBe("no-evidence");
  });

  it("only the highest attempt counts: a superseded green attempt does not", async () => {
    const { result } = await verify({
      runs: [run({ run_attempt: 1 }), run({ run_attempt: 2, conclusion: "failure" })],
      jobs: [{ name: "checks", conclusion: "failure" }],
    });
    expect(result.runAttempt).toBe(2);
    expect(result.status).toBe("no-evidence");
  });

  it("a superseded green attempt is not evidence even when the latest one skipped the tests", async () => {
    const { result } = await verify({
      runs: [run({ run_attempt: 1 }), run({ run_attempt: 2 })],
      jobsByRun: { "10/2": skippedTests() },
    });
    expect(result).toMatchObject({ status: "no-evidence", runId: 10, runAttempt: 2 });
    expect(result.reason).toContain("test (1)=skipped");
  });

  it("a newer run that skipped the tests does not hide an older green run (#1564)", async () => {
    const { exitCode, result } = await verify({
      runs: [run({ id: 10 }), run({ id: 11 })],
      jobsByRun: { 11: skippedTests() },
    });
    expect(exitCode).toBe(0);
    expect(result).toMatchObject({ status: "ok", runId: 10, runAttempt: 1 });
    expect(result.jobs.every((job) => job.conclusion === "success")).toBe(true);
  });

  it("a newer red run wins over an older green run on the same HEAD", async () => {
    const { exitCode, result } = await verify({
      runs: [run({ id: 10 }), run({ id: 11, conclusion: "failure" })],
      jobsByRun: { 11: CI.jobs.map((name) => ({ name, conclusion: "failure" })) },
    });
    expect(exitCode).toBe(2);
    expect(result).toMatchObject({ status: "no-evidence", runId: 11 });
    expect(result.reason).toContain("checks=failure");
  });

  it("a skipped run with a failed required job is not passed over", async () => {
    const { result } = await verify({
      runs: [run({ id: 10 }), run({ id: 11, conclusion: "failure" })],
      jobsByRun: { 11: skippedTests("failure") },
    });
    expect(result).toMatchObject({ status: "no-evidence", runId: 11 });
    expect(result.reason).toContain("checks=failure");
  });

  it("an unexpanded matrix job that did not skip leaves its entries missing", async () => {
    const { result } = await verify({
      runs: [run({ id: 10 }), run({ id: 11, conclusion: "failure" })],
      jobsByRun: {
        11: [
          { name: "checks", conclusion: "success" },
          { name: "test", conclusion: "failure" },
          { name: "test-merge", conclusion: "skipped" },
        ],
      },
    });
    expect(result).toMatchObject({ status: "no-evidence", runId: 11 });
    expect(result.reason).toContain("test (1)=missing");
  });

  it("a newer cancelled run wins over an older green run", async () => {
    const { result } = await verify({
      runs: [run({ id: 10 }), run({ id: 11, conclusion: "cancelled" })],
    });
    expect(result).toMatchObject({ status: "no-evidence", runId: 11 });
    expect(result.reason).toContain("cancelled");
  });

  it("a newer pending run is awaited, not skipped for an older green run", async () => {
    const { result, clock } = await verify(
      { runs: [run({ id: 10 }), run({ id: 11, status: "in_progress", conclusion: null })] },
      3000,
    );
    expect(result).toMatchObject({ status: "no-evidence" });
    expect(result.reason).toContain("pending");
    expect(clock.t).toBe(3000);
  });

  it("when every run skipped the tests, the newest one gives the reason", async () => {
    const { result } = await verify({
      runs: [run({ id: 10 }), run({ id: 11 })],
      jobs: skippedTests(),
    });
    expect(result).toMatchObject({ status: "no-evidence", runId: 11 });
    expect(result.reason).toContain("test (1)=skipped");
  });

  it("ignores runs of another SHA", async () => {
    const { result } = await verify({ runs: [run({ head_sha: "d".repeat(40) })] });
    expect(result.reason).toBe("no CI run found for this SHA");
  });

  it("waits for a pending run until it completes", async () => {
    let polls = 0;
    const h = harness();
    const base = h.deps.exec!;
    h.deps.exec = (command, args, cwd) => {
      if (command === "gh" && args[0] === "api" && !args[1]!.includes("/jobs") && polls++ < 2)
        return json({ workflow_runs: [run({ status: "in_progress", conclusion: null })] });
      return base(command, args, cwd);
    };
    const out = await verifyReceiptCi(
      { receipt: RECEIPT, ci: CI, pr: 7, waitMs: 60_000, pollMs: 1000 },
      h.deps,
    );
    expect(out.result.status).toBe("ok");
    expect(h.clock.t).toBe(2000);
  });

  it("still pending past the deadline: no evidence", async () => {
    const { result, clock } = await verify(
      { runs: [run({ status: "queued", conclusion: null })] },
      3000,
    );
    expect(result).toMatchObject({ status: "no-evidence" });
    expect(result.reason).toContain("pending");
    expect(clock.t).toBe(3000);
  });

  it("gh unavailable or failing: no evidence with the reason", async () => {
    const missing = await verify({
      pr: { status: null, stdout: "", stderr: "", error: "spawn gh ENOENT" } satisfies ExecResult,
    });
    expect(missing.result.status).toBe("no-evidence");
    expect(missing.result.reason).toContain("ENOENT");
    const offline = await verify({ runs: fail(1, "could not resolve host") });
    expect(offline.result.reason).toContain("could not resolve host");
  });

  it("untrusted path: refused with the list, without asking CI", async () => {
    const { exitCode, result, calls } = await verify({
      changed: ["src/a.ts", ".github/workflows/ci.yml", "package.json"],
    });
    expect(exitCode).toBe(2);
    expect(result.status).toBe("refused");
    expect(result.untrusted).toEqual([".github/workflows/ci.yml", "package.json"]);
    expect(calls.some((c) => c.startsWith("gh api"))).toBe(false);
  });

  it("a qualityGate change against the target is refused, even though no path is listed", async () => {
    const { result } = await verify({
      changed: ["navori.config.json"],
      headConfig: config({ ...GATE, full: "other" }),
    });
    expect(result.status).toBe("refused");
    expect(result.untrusted[0]).toContain("qualityGate");
  });

  it("the same qualityGate with different key order is not a change", async () => {
    const { result } = await verify({
      changed: ["navori.config.json"],
      headConfig: config({ full: "g", fast: "f" }),
    });
    expect(result.status).toBe("ok");
  });

  it("an unreadable target config is refused", async () => {
    expect((await verify({ baseConfig: fail(128) })).result.status).toBe("refused");
  });

  it("hook paths run the hooks command: pass continues, fail refuses", async () => {
    const pass = await verify({ changed: ["hooks/a.sh", "plugins/x/scripts/b.sh"] });
    expect(pass.result.status).toBe("ok");
    expect(pass.result.hooks).toEqual({
      paths: ["hooks/a.sh", "plugins/x/scripts/b.sh"],
      ran: true,
      exitCode: 0,
    });
    expect(pass.calls).toContain("sh -c run-hooks");
    const bad = await verify({ changed: ["hooks/a.sh"], hooks: fail(1) });
    expect(bad.result.status).toBe("refused");
    expect(bad.result.hooks.exitCode).toBe(1);
    expect(bad.calls.some((c) => c.startsWith("gh api"))).toBe(false);
  });

  it("does not run the hooks command when no hook path changed", async () => {
    expect((await verify()).calls.some((c) => c.startsWith("sh "))).toBe(false);
  });
});
