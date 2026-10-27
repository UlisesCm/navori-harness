import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { emptyRepo, type RepoTemplate } from "../../../__tests__/helpers/repo-template.ts";
import { contentIdentity } from "../../primitives/content-identity.ts";
import { publishedContentIdentity, readPublications } from "../publications.ts";
import { session } from "./lifecycle-fixtures.ts";
import type { HookEvent, ReviewOutcome, SessionAudit } from "../model.ts";

let template: RepoTemplate;
beforeAll(() => {
  template = emptyRepo({ branch: "task" });
});
afterAll(() => template.dispose());
afterEach(() => vi.unstubAllEnvs());
const base = Date.parse("2026-10-01T00:00:00.000Z");
const iso = (offset: number): string => new Date(base + offset).toISOString();

function fixture(): {
  cwd: string;
  remote: string;
  observed: SessionAudit;
  git: (args: string[], offset?: number) => string;
  commit: (text: string, offset: number) => void;
} {
  const cwd = template.copy();
  const git = (args: string[], offset = 2000): string =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_AUTHOR_DATE: iso(offset), GIT_COMMITTER_DATE: iso(offset) },
    }).trim();
  git(["config", "user.name", "Fixture"]);
  git(["config", "user.email", "fixture@example.test"]);
  const remote = join(cwd, ".navori/state/remote.git");
  mkdirSync(remote, { recursive: true });
  git(["init", "--bare", remote]);
  git(["--git-dir=" + remote, "config", "core.logAllRefUpdates", "always"]);
  const commit = (text: string, offset: number): void => {
    writeFileSync(join(cwd, "code.txt"), text);
    git(["add", "code.txt"]);
    git(["commit", "-m", "fixture"], offset);
  };
  commit("reviewed", 2000);
  const identity = contentIdentity(cwd);
  if (!identity.ok) throw new Error(identity.reason);
  const review: ReviewOutcome = {
    name: "review-outcome",
    schemaVersion: 1,
    featureKey: "a".repeat(64),
    sidecar: "b".repeat(64),
    verdict: "approved",
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    correlation: "correlated",
    alg: identity.alg,
    fp: identity.fingerprint,
    sealedAtMs: base + 3000,
  };
  const hooks: HookEvent[] = ["gate-started", "allow"].map(
    (verdict: string, i: number): HookEvent => ({
      ts: iso(1000 + i * 100),
      tsMs: base + 1000 + i * 100,
      name: "quality-gate-pre-commit",
      phase: "PreToolUse",
      verdict,
      ms: 100,
      source: "core",
      agentId: "orchestrator",
      toolUseId: "gate-1",
    }),
  );
  const observed = session({
    sessionId: "pi-one",
    host: "pi",
    cwd,
    gitBranch: "task",
    startedAt: iso(0),
    endedAt: iso(20000),
    cliEvents: [
      {
        event: "cli",
        name: "review-outcome",
        verdict: "approved",
        tsMs: base + 3001,
        outcomePayload: review,
      },
    ],
  });
  observed.orchestrator.hookEvents = hooks;
  return { cwd, remote, observed, git, commit };
}

describe("publication evidence", () => {
  // Covers: R1, R2 (0053)
  it("keeps missing ownership and recorder horizons unavailable", (): void => {
    const f = fixture();
    f.git(["push", f.remote, "HEAD:refs/heads/task"], 4000);
    f.observed.orchestrator.hookEvents[1]!.agentId = "different-owner";
    expect(readPublications(f.remote, [f.observed])).toEqual({
      state: "unavailable",
      reason: "ambiguous-ownership",
    });
    f.observed.orchestrator.hookEvents = [];
    expect(readPublications(f.remote, [f.observed])).toEqual({
      state: "unavailable",
      reason: "missing-gate-source",
    });
  });
  // Covers: R1, R2 (0053)
  it("can correlate an earlier selected session of the same engine and checkout", (): void => {
    const f = fixture();
    const earlier = { ...f.observed, endedAt: iso(4000) };
    const publisher = {
      ...f.observed,
      sessionId: "publisher",
      startedAt: iso(5000),
      cliEvents: [],
      orchestrator: { ...f.observed.orchestrator, hookEvents: [] },
    };
    f.git(["push", f.remote, "HEAD:refs/heads/task"], 6000);
    const evidence = readPublications(f.remote, [earlier, publisher]);
    expect(evidence.state).toBe("observed");
    if (evidence.state === "observed")
      expect(evidence.publications).toEqual([{ sessionId: "publisher", correlatedApproval: true }]);
    const foreign = readPublications(f.remote, [{ ...earlier, host: "claude" }, publisher]);
    if (foreign.state === "observed")
      expect(foreign.publications[0]?.correlatedApproval).toBe(false);
    else throw new Error(foreign.reason);
  });
  // Covers: R1, R2 (0053)
  it.runIf(process.platform !== "win32")(
    "matches executable files and symlinks while excluding lifecycle state",
    (): void => {
      const f = fixture();
      mkdirSync(join(f.cwd, "progress"));
      writeFileSync(join(f.cwd, "progress/current.md"), "private lifecycle");
      writeFileSync(join(f.cwd, "exec.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      symlinkSync("code.txt", join(f.cwd, "link"));
      f.git(["add", "progress/current.md", "exec.sh", "link"]);
      f.git(["commit", "-m", "fixture files"], 5000);
      f.git(["push", f.remote, "HEAD:refs/heads/task"], 6000);
      const identity = contentIdentity(f.cwd);
      if (!identity.ok) throw new Error(identity.reason);
      expect(publishedContentIdentity(f.remote, f.git(["rev-parse", "HEAD"]))).toBe(
        identity.fingerprint,
      );
    },
  );
  // Covers: R1, R2 (0053)
  it("leaves same-second ordering unavailable instead of guessing a green gate", (): void => {
    const f = fixture();
    f.observed.orchestrator.hookEvents[1]!.ts = iso(2500);
    f.git(["push", f.remote, "HEAD:refs/heads/task"], 4000);
    expect(readPublications(f.remote, [f.observed])).toEqual({
      state: "unavailable",
      reason: "ambiguous-time",
    });
  });
  // Covers: R1, R2 (0053)
  it("does not let an earlier green override a later failed gate", (): void => {
    const f = fixture();
    f.observed.orchestrator.hookEvents.push(
      ...["gate-started", "block"].map((verdict: string, i: number): HookEvent => ({
        ts: iso(1500 + i * 100),
        tsMs: base + 1500 + i * 100,
        name: "quality-gate-pre-commit",
        phase: "PreToolUse",
        verdict,
        ms: 100,
        source: "core",
        agentId: "orchestrator",
        toolUseId: "gate-red",
      })),
    );
    f.git(["push", f.remote, "HEAD:refs/heads/task"], 4000);
    const evidence = readPublications(f.remote, [f.observed]);
    expect(evidence.state).toBe("observed");
    if (evidence.state === "observed") expect(evidence.commits[0]?.greenGate).toBe(false);
  });
  // Covers: R1, R2 (0053)
  it("ignores inherited Git checkout overrides and rejects unsealed observations", (): void => {
    const f = fixture();
    f.git(["push", f.remote, "HEAD:refs/heads/task"], 4000);
    vi.stubEnv("GIT_DIR", join(f.cwd, "wrong-git-dir"));
    expect(readPublications(f.remote, [f.observed]).state).toBe("observed");
    expect(readPublications(f.remote, [{ ...f.observed, sealed: false }])).toEqual({
      state: "unavailable",
      reason: "incomplete-session",
    });
  });
  // Covers: R1, R2 (0053)
  it("matches the working identity without writing to a checkout or remote", (): void => {
    const f = fixture();
    f.git(["push", f.remote, "HEAD:refs/heads/task"], 4000);
    const identity = contentIdentity(f.cwd);
    if (!identity.ok) throw new Error(identity.reason);
    const before = readdirSync(f.remote, { recursive: true }).sort();
    const index = readFileSync(join(f.cwd, ".git/index"));
    expect(publishedContentIdentity(f.remote, f.git(["rev-parse", "HEAD"]))).toBe(
      identity.fingerprint,
    );
    expect(readPublications(f.remote, [f.observed])).toEqual({
      state: "observed",
      publications: [{ sessionId: "pi-one", correlatedApproval: true }],
      commits: [{ sessionId: "pi-one", greenGate: true }],
    });
    expect(readdirSync(f.remote, { recursive: true }).sort()).toEqual(before);
    expect(readFileSync(join(f.cwd, ".git/index"))).toEqual(index);
  });

  // Covers: R1, R2 (0053)
  it("counts changed content as published without correlated approval", (): void => {
    const f = fixture();
    f.commit("changed after approval", 5000);
    f.git(["push", f.remote, "HEAD:refs/heads/task"], 6000);
    const evidence = readPublications(f.remote, [f.observed]);
    expect(evidence.state).toBe("observed");
    if (evidence.state !== "observed") throw new Error(evidence.reason);
    expect(evidence.publications).toEqual([{ sessionId: "pi-one", correlatedApproval: false }]);
    expect(evidence.commits.map((commit): boolean => commit.greenGate)).toEqual([true, false]);
  });

  // Covers: R1, R2 (0053)
  it.each(["late", "uncorrelated", "rejected"])(
    "does not credit a %s review",
    (mode: string): void => {
      const f = fixture();
      const review = f.observed.cliEvents![0]!.outcomePayload;
      if (review?.name !== "review-outcome") throw new Error("fixture");
      if (mode === "late") review.sealedAtMs = base + 5000;
      if (mode === "uncorrelated") review.correlation = "changed-after-review";
      if (mode === "rejected") review.verdict = "changes-requested";
      f.git(["push", f.remote, "HEAD:refs/heads/task"], 4000);
      const evidence = readPublications(f.remote, [f.observed]);
      expect(evidence.state).toBe("observed");
      if (evidence.state === "observed")
        expect(evidence.publications[0]?.correlatedApproval).toBe(false);
    },
  );

  // Covers: R1, R2 (0053)
  it("leaves missing sources and overlapping sessions unavailable", (): void => {
    const f = fixture();
    expect(readPublications(undefined, [])).toEqual({
      state: "unavailable",
      reason: "not-requested",
    });
    expect(readPublications(f.remote, [f.observed])).toEqual({
      state: "unavailable",
      reason: "missing-reflog",
    });
    f.git(["push", f.remote, "HEAD:refs/heads/task"], 4000);
    expect(readPublications(f.remote, [f.observed, { ...f.observed, sessionId: "other" }])).toEqual(
      { state: "unavailable", reason: "ambiguous-publication" },
    );
    // A startup branch is not immutable ownership evidence for a later push.
    expect(
      readPublications(f.remote, [
        f.observed,
        { ...f.observed, sessionId: "other", gitBranch: "different-at-startup" },
      ]),
    ).toEqual({ state: "unavailable", reason: "ambiguous-publication" });
  });
});
