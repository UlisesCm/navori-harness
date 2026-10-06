import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoFromCwd, sessionLogPath } from "../../audit/paths.ts";
import {
  beginReview,
  checkSealedEvidence,
  emitReviewOutcome,
  reviewEvidenceWarning,
  sealReview,
  type EvidenceOptions,
} from "../review-evidence.ts";
import { logReview, ReviewSidecarSchema } from "../review-schema.ts";
import { resolveStateRoot } from "../../primitives/state-root.ts";

const dirs: string[] = [];
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = {
    NAVORI_AUDITS_ROOT: process.env.NAVORI_AUDITS_ROOT,
    CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID,
    NAVORI_AUDIT_HOST: process.env.NAVORI_AUDIT_HOST,
    NAVORI_AUDIT_SESSION_ID: process.env.NAVORI_AUDIT_SESSION_ID,
    CODEX_SESSION_ID: process.env.CODEX_SESSION_ID,
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
  };
  delete process.env.NAVORI_AUDIT_HOST;
  delete process.env.NAVORI_AUDIT_SESSION_ID;
  delete process.env.CODEX_SESSION_ID;
  delete process.env.CODEX_THREAD_ID;
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  dirs.splice(0).forEach((d) => rmSync(d, { force: true, recursive: true }));
  vi.restoreAllMocks();
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "navori-evidence-")));
  dirs.push(root);
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  writeFileSync(join(root, "a.txt"), "a\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "base");
  return root;
}

function options(cwd: string, feature = "demo", gate = ""): EvidenceOptions {
  return { cwd, feature, target: "main", gate };
}

const sidecarBody = (feature: string, verdict = "APPROVED") => ({
  feature,
  verdict,
  findings: [{ category: "style", severity: "high", score: 80, file: "a.txt" }],
});

function stateFile(cwd: string, name: string): string {
  return join(cwd, ".navori", "state", "handoffs", name);
}

function writeSidecar(cwd: string, feature = "demo", verdict = "APPROVED"): void {
  mkdirSync(join(cwd, ".navori", "state", "handoffs"), { recursive: true });
  writeFileSync(
    stateFile(cwd, `review_${feature}.json`),
    JSON.stringify(sidecarBody(feature, verdict)),
  );
}

function readSidecar(cwd: string, feature = "demo"): Record<string, unknown> {
  return JSON.parse(readFileSync(stateFile(cwd, `review_${feature}.json`), "utf8"));
}

/** begin + sidecar + seal, returning the nonce. */
function sealed(cwd: string, feature = "demo", gate = ""): string {
  const begun = beginReview(options(cwd, feature, gate));
  if (begun.status !== "begun") throw new Error(begun.message);
  writeSidecar(cwd, feature);
  const result = sealReview({ ...options(cwd, feature, gate), nonce: begun.nonce });
  if (result.status !== "validated") throw new Error(JSON.stringify(result));
  return begun.nonce;
}

function correlationOf(cwd: string, feature = "demo", gate = ""): string | undefined {
  const root = resolveStateRoot({ cwd, feature });
  const parsed = ReviewSidecarSchema.parse(readSidecar(cwd, feature));
  emitReviewOutcome(() => options(cwd, feature, gate), {
    root,
    sidecar: parsed,
    hash: "0".repeat(64),
  });
  const log = readLog(cwd);
  return log.at(-1)?.correlation as string | undefined;
}

function markAudit(cwd: string): string {
  process.env.NAVORI_AUDITS_ROOT = join(cwd, "..", `audits-${process.pid}-${Date.now()}`);
  dirs.push(process.env.NAVORI_AUDITS_ROOT);
  process.env.CLAUDE_CODE_SESSION_ID = "sess-1";
  const log = sessionLogPath(repoFromCwd(cwd), "sess-1");
  mkdirSync(join(log, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(
    log,
    `${JSON.stringify({ event: "start", host: "claude", sessionId: "sess-1", cwd })}\n`,
    { mode: 0o600 },
  );
  return log;
}

function readLog(cwd: string): Array<Record<string, unknown>> {
  return readFileSync(sessionLogPath(repoFromCwd(cwd), "sess-1"), "utf8")
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => JSON.parse(line));
}

describe("begin", () => {
  // Covers: R16
  it("writes a nonce-keyed stamp and prints the nonce", () => {
    const cwd = repo();
    const result = beginReview(options(cwd));
    expect(result.status).toBe("begun");
    if (result.status !== "begun") return;
    const stamp = JSON.parse(
      readFileSync(stateFile(cwd, `review_demo.${result.nonce}.begin.json`), "utf8"),
    );
    expect(stamp).toMatchObject({
      v: 1,
      alg: "navori-content/v1",
      nonce: result.nonce,
      feature: "demo",
    });
    expect(stamp.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  // Covers: R16
  it("rejects a state dir outside the excluded directories", () => {
    const cwd = repo();
    const result = beginReview({ ...options(cwd), dir: "state" });
    expect(result.status).toBe("error");
    expect(existsSync(join(cwd, "state"))).toBe(false);
  });

  // Covers: R16
  it("does not emit a gate field when no gate is configured (B2)", () => {
    const cwd = repo();
    const nonce = sealed(cwd);
    const stamp = JSON.parse(
      readFileSync(stateFile(cwd, `review_demo.${nonce}.begin.json`), "utf8"),
    );
    expect("gate" in stamp).toBe(false);
    expect("gate" in (readSidecar(cwd).evidence as object)).toBe(false);
    const configured = sealed(cwd, "other", "bun check");
    const other = JSON.parse(
      readFileSync(stateFile(cwd, `review_other.${configured}.begin.json`), "utf8"),
    );
    expect(other.gate).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("seal", () => {
  // Covers: R16
  it("embeds validated evidence and does not change the stamped fingerprint", () => {
    const cwd = repo();
    const nonce = sealed(cwd);
    const evidence = readSidecar(cwd).evidence as Record<string, unknown>;
    expect(evidence).toMatchObject({ v: 1, state: "validated", nonce });
    const root = resolveStateRoot({ cwd, feature: "demo" });
    expect(checkSealedEvidence(root, ReviewSidecarSchema.parse(readSidecar(cwd))).status).toBe(
      "sealed",
    );
  });

  // Covers: R16
  it("seals a change during the review as changed-during-review without relabeling", () => {
    const cwd = repo();
    const begun = beginReview(options(cwd));
    if (begun.status !== "begun") throw new Error("begin failed");
    const before = JSON.parse(
      readFileSync(stateFile(cwd, `review_demo.${begun.nonce}.begin.json`), "utf8"),
    );
    writeFileSync(join(cwd, "a.txt"), "edited during review\n");
    writeSidecar(cwd);
    const result = sealReview({ ...options(cwd), nonce: begun.nonce });
    expect(result.status).toBe("changed-during-review");
    const evidence = readSidecar(cwd).evidence as Record<string, string>;
    expect(evidence.fingerprint).toBe(before.fingerprint);
    expect(evidence.sealedFingerprint).not.toBe(before.fingerprint);
    markAudit(cwd);
    expect(correlationOf(cwd)).toBe("changed-during-review");
  });

  // Covers: R16
  it.each([
    ["an unknown nonce", (cwd: string) => ({ cwd, nonce: "00000000-0000-4000-8000-000000000000" })],
    ["a malformed nonce", (cwd: string) => ({ cwd, nonce: "nope" })],
  ])("refuses %s without writing evidence", (_label, build) => {
    const cwd = repo();
    writeSidecar(cwd);
    const { nonce } = build(cwd);
    expect(sealReview({ ...options(cwd), nonce }).status).toBe("error");
    expect("evidence" in readSidecar(cwd)).toBe(false);
  });

  // Covers: R16
  it("refuses a missing, invalid or foreign-feature sidecar", () => {
    const cwd = repo();
    const begun = beginReview(options(cwd));
    if (begun.status !== "begun") throw new Error("begin failed");
    expect(sealReview({ ...options(cwd), nonce: begun.nonce }).status).toBe("error");
    mkdirSync(join(cwd, ".navori", "state", "handoffs"), { recursive: true });
    writeFileSync(stateFile(cwd, "review_demo.json"), "{not json");
    expect(sealReview({ ...options(cwd), nonce: begun.nonce }).status).toBe("error");
    writeSidecar(cwd, "demo");
    writeFileSync(stateFile(cwd, "review_demo.json"), JSON.stringify(sidecarBody("someone-else")));
    expect(sealReview({ ...options(cwd), nonce: begun.nonce }).status).toBe("error");
  });

  // Covers: R16
  it("refuses a sidecar that already carries evidence (B1)", () => {
    const cwd = repo();
    const nonce = sealed(cwd);
    const second = beginReview(options(cwd));
    if (second.status !== "begun") throw new Error("begin failed");
    // The reviewer forgot to rewrite the sidecar: the old sealed APPROVED stays.
    const result = sealReview({ ...options(cwd), nonce: second.nonce });
    expect(result.status).toBe("error");
    expect((readSidecar(cwd).evidence as { nonce: string }).nonce).toBe(nonce);
  });

  // Covers: R16
  it("refuses a sidecar older than its begin stamp (B1)", () => {
    const cwd = repo();
    writeSidecar(cwd);
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(stateFile(cwd, "review_demo.json"), old, old);
    const begun = beginReview(options(cwd));
    if (begun.status !== "begun") throw new Error("begin failed");
    expect(sealReview({ ...options(cwd), nonce: begun.nonce }).status).toBe("error");
    expect("evidence" in readSidecar(cwd)).toBe(false);
  });

  // Covers: R16
  it("accepts a sidecar whose mtime equals the begin stamp's (tie, B1)", () => {
    const cwd = repo();
    const begun = beginReview(options(cwd));
    if (begun.status !== "begun") throw new Error("begin failed");
    writeSidecar(cwd);
    // Pin both files to the same whole-second instant: Date drops sub-ms precision.
    const tie = new Date(Math.floor(Date.now() / 1000) * 1000);
    utimesSync(stateFile(cwd, `review_demo.${begun.nonce}.begin.json`), tie, tie);
    utimesSync(stateFile(cwd, "review_demo.json"), tie, tie);
    expect(sealReview({ ...options(cwd), nonce: begun.nonce }).status).toBe("validated");
  });

  // Covers: R16
  it("keeps concurrent reviewers apart by nonce (M1)", () => {
    const cwd = repo();
    const first = beginReview(options(cwd));
    if (first.status !== "begun") throw new Error("begin failed");
    writeFileSync(join(cwd, "a.txt"), "changed between the two begins\n");
    const second = beginReview(options(cwd));
    if (second.status !== "begun") throw new Error("begin failed");
    expect(second.nonce).not.toBe(first.nonce);
    writeSidecar(cwd);
    expect(sealReview({ ...options(cwd), nonce: first.nonce }).status).toBe(
      "changed-during-review",
    );
    writeSidecar(cwd);
    expect(sealReview({ ...options(cwd), nonce: second.nonce }).status).toBe("validated");
  });
});

describe("correlation through log-review", () => {
  // Covers: R16
  it("is correlated when the content is unchanged and omits fp otherwise", () => {
    const cwd = repo();
    sealed(cwd);
    markAudit(cwd);
    expect(correlationOf(cwd)).toBe("correlated");
    expect(readLog(cwd).at(-1)?.fp).toMatch(/^[a-f0-9]{64}$/);
    writeFileSync(join(cwd, "a.txt"), "changed after the seal\n");
    expect(correlationOf(cwd)).toBe("changed-after-review");
    expect("fp" in (readLog(cwd).at(-1) ?? {})).toBe(false);
  });

  // Covers: R16
  it("is missing for a legacy sidecar even when HEAD is unchanged", () => {
    const cwd = repo();
    writeSidecar(cwd);
    markAudit(cwd);
    expect(correlationOf(cwd)).toBe("missing");
  });

  // Covers: R16
  it("is invalid for evidence declared by hand or edited after the seal", () => {
    const cwd = repo();
    sealed(cwd);
    markAudit(cwd);
    const sidecar = readSidecar(cwd);
    writeFileSync(
      stateFile(cwd, "review_demo.json"),
      JSON.stringify({ ...sidecar, verdict: "CHANGES_REQUESTED" }),
    );
    expect(correlationOf(cwd)).toBe("invalid");
    const evidence = sidecar.evidence as Record<string, unknown>;
    writeFileSync(
      stateFile(cwd, "review_demo.json"),
      JSON.stringify({
        ...sidecar,
        evidence: { ...evidence, nonce: "11111111-1111-4111-8111-111111111111" },
      }),
    );
    expect(correlationOf(cwd)).toBe("invalid");
    writeFileSync(
      stateFile(cwd, "review_demo.json"),
      JSON.stringify({ ...sidecar, evidence: { ...evidence, fingerprint: "f".repeat(64) } }),
    );
    expect(correlationOf(cwd)).toBe("invalid");
    writeFileSync(
      stateFile(cwd, "review_demo.json"),
      JSON.stringify({ ...sidecar, evidence: "yes" }),
    );
    expect(correlationOf(cwd)).toBe("invalid");
  });

  // Covers: R16
  it("is unknown-algorithm for a future version or algorithm", () => {
    const cwd = repo();
    sealed(cwd);
    markAudit(cwd);
    const sidecar = readSidecar(cwd);
    const evidence = sidecar.evidence as Record<string, unknown>;
    writeFileSync(
      stateFile(cwd, "review_demo.json"),
      JSON.stringify({ ...sidecar, evidence: { ...evidence, alg: "navori-content/v2" } }),
    );
    expect(correlationOf(cwd)).toBe("unknown-algorithm");
    writeFileSync(
      stateFile(cwd, "review_demo.json"),
      JSON.stringify({ ...sidecar, evidence: { ...evidence, v: 2 } }),
    );
    expect(correlationOf(cwd)).toBe("unknown-algorithm");
  });
});

describe("review-outcome emission", () => {
  // Covers: R16
  it("emits exactly one event per run, even with zero findings, with a hashed feature", () => {
    const cwd = repo();
    markAudit(cwd);
    mkdirSync(join(cwd, ".navori", "state", "handoffs"), { recursive: true });
    writeFileSync(
      stateFile(cwd, "review_secret-payroll-fix.json"),
      JSON.stringify({ feature: "secret-payroll-fix", verdict: "APPROVED", findings: [] }),
    );
    const observe = (info: Parameters<typeof emitReviewOutcome>[1]) =>
      emitReviewOutcome(() => options(cwd, "secret-payroll-fix"), info);
    const first = logReview({ cwd, feature: "secret-payroll-fix", observe });
    expect(first).toMatchObject({ status: "appended", appended: 0 });
    const events = readLog(cwd);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "cli",
      name: "review-outcome",
      verdict: "approved",
      schemaVersion: 1,
      critical: 0,
      high: 0,
      correlation: "missing",
    });
    expect(String(events[0]?.featureKey)).toMatch(/^[a-f0-9]{64}$/);
    const raw = readFileSync(sessionLogPath(repoFromCwd(cwd), "sess-1"), "utf8");
    expect(raw).not.toContain("secret-payroll-fix");
    expect(Buffer.byteLength(JSON.stringify(events[0]))).toBeLessThanOrEqual(2048);
    // A zero-finding sidecar writes no findings line, so a re-read is another event with the same hash.
    expect(logReview({ cwd, feature: "secret-payroll-fix", observe })).toMatchObject({
      appended: 0,
    });
    const again = readLog(cwd);
    expect(again).toHaveLength(2);
    expect(again[1]?.sidecar).toBe(events[0]?.sidecar);
  });

  // Covers: R16
  it("counts findings by severity and normalizes the verdict", () => {
    const cwd = repo();
    markAudit(cwd);
    mkdirSync(join(cwd, ".navori", "state", "handoffs"), { recursive: true });
    writeFileSync(
      stateFile(cwd, "review_demo.json"),
      JSON.stringify({
        feature: "demo",
        verdict: "changes_requested",
        findings: [
          { category: "c", severity: "high", score: 90, file: "a" },
          { category: "c", severity: "high", score: 20, file: "a" },
          { category: "c", severity: "critical", score: 70, file: "a" },
        ],
      }),
    );
    logReview({
      cwd,
      feature: "demo",
      observe: (info) => emitReviewOutcome(() => options(cwd), info),
    });
    expect(readLog(cwd)[0]).toMatchObject({
      verdict: "changes-requested",
      critical: 1,
      high: 1,
      medium: 0,
    });
  });

  // Covers: R16
  it("does no work and writes nothing without an exact audit context", () => {
    const cwd = repo();
    writeSidecar(cwd);
    delete process.env.CLAUDE_CODE_SESSION_ID;
    const context = vi.fn(() => options(cwd));
    const result = logReview({
      cwd,
      feature: "demo",
      observe: (info) => emitReviewOutcome(context, info),
    });
    expect(result.status).toBe("appended");
    expect(context).not.toHaveBeenCalled();
  });

  // Covers: R16
  it("never changes the result when the observation fails or the log is unsafe", () => {
    const cwd = repo();
    writeSidecar(cwd);
    const baseline = logReview({ cwd, feature: "demo" });
    rmSync(stateFile(cwd, "findings.jsonl"));
    const throwing = logReview({
      cwd,
      feature: "demo",
      observe: () => {
        throw new Error("boom");
      },
    });
    expect(throwing).toEqual(baseline);
    rmSync(stateFile(cwd, "findings.jsonl"));
    const log = markAudit(cwd);
    rmSync(log);
    symlinkSync(join(cwd, "a.txt"), log);
    const unsafe = logReview({
      cwd,
      feature: "demo",
      observe: (info) => emitReviewOutcome(() => options(cwd), info),
    });
    expect(unsafe).toEqual(baseline);
    expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("a\n");
  });

  // Covers: R16
  it("emits one event per feature in a session", () => {
    const cwd = repo();
    markAudit(cwd);
    for (const feature of ["one", "two"]) {
      mkdirSync(join(cwd, ".navori", "state", "handoffs"), { recursive: true });
      writeFileSync(
        stateFile(cwd, `review_${feature}.json`),
        JSON.stringify({ feature, verdict: "APPROVED", findings: [] }),
      );
      logReview({
        cwd,
        feature,
        observe: (info) => emitReviewOutcome(() => options(cwd, feature), info),
      });
    }
    const keys = readLog(cwd).map((event) => event.featureKey);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  // Covers: R16
  it("omits the gate for an unconfigured gate and carries it for a configured one (B2)", () => {
    const cwd = repo();
    sealed(cwd, "nogate", "");
    sealed(cwd, "gated", "bun check");
    markAudit(cwd);
    expect(correlationOf(cwd, "nogate", "")).toBe("correlated");
    expect("gate" in (readLog(cwd).at(-1) ?? {})).toBe(false);
    expect(correlationOf(cwd, "gated", "bun check")).toBe("correlated");
    expect(readLog(cwd).at(-1)?.gate).toMatch(/^[a-f0-9]{64}$/);
    // A gate configured later no longer matches the sealed identity.
    expect(correlationOf(cwd, "nogate", "bun check")).toBe("changed-after-review");
  });
});

describe("publisher warning (M8)", () => {
  // Covers: R16
  it("explains why a review carries no valid evidence and stays silent for a sealed one", () => {
    const cwd = repo();
    const root = resolveStateRoot({ cwd, feature: "demo" });
    expect(reviewEvidenceWarning(root, "demo")).toContain("not found");
    writeSidecar(cwd);
    expect(reviewEvidenceWarning(root, "demo")).toContain("missing");
    sealed(cwd);
    expect(reviewEvidenceWarning(root, "demo")).toBeNull();
  });
});
