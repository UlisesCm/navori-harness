import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attestHandoff, nativeActor } from "../actor-provenance.ts";
import { beginReview, correlateReview, sealReview } from "../review-evidence.ts";
import { ReviewSidecarSchema } from "../review-schema.ts";
import { resolveStateRoot } from "../../primitives/state-root.ts";
import { signReceipt, checkReceipt } from "../../diagnose/receipt.ts";

let dir: string;
let cwd: string;
const rootId = "00000000-0000-0000-0000-000000000001";
const producerId = "00000000-0000-0000-0000-000000000002";
const reviewerId = "00000000-0000-0000-0000-000000000003";
const scribeId = "00000000-0000-0000-0000-000000000004";
const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const state = (name: string): string => join(cwd, ".navori/state/handoffs", name);
function actor(thread: string, role: string, extra: Record<string, unknown> = {}): void {
  vi.stubEnv("CODEX_THREAD_ID", thread);
  writeFileSync(
    join(dir, "sessions/2026/10/12", `rollout-${thread}.jsonl`),
    JSON.stringify({
      type: "session_meta",
      payload: {
        id: thread,
        session_id: rootId,
        parent_thread_id: rootId,
        cli_version: "0.162.1",
        cwd,
        agent_role: role,
        source: { subagent: { thread_spawn: { parent_thread_id: rootId, agent_role: role } } },
        ...extra,
      },
    }) + "\n",
  );
}
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "navori-actor-")));
  cwd = join(dir, "repo");
  mkdirSync(cwd);
  git("init", "-b", "main");
  git("config", "user.email", "t@t.test");
  git("config", "user.name", "T");
  writeFileSync(join(cwd, "a.txt"), "base\n");
  git("add", ".");
  git("commit", "-qm", "base");
  git("switch", "-c", "feature");
  mkdirSync(state(""), { recursive: true });
  mkdirSync(join(dir, "sessions/2026/10/12"), { recursive: true });
  vi.stubEnv("CODEX_HOME", dir);
  vi.spyOn(process, "cwd").mockImplementation(() => cwd);
  writeFileSync(
    state("workplan_demo.json"),
    JSON.stringify({
      feature: "demo",
      level: 1,
      classification: { score: 1, level: 1, signals: [] },
      objective: "test",
      acceptance: [{ id: "A1", description: "test", command: "test", expected: "pass" }],
      files: [
        { path: "a.txt", new: false },
        { path: "note.md", new: true },
      ],
      outOfScope: [],
    }),
  );
  writeFileSync(
    state("impl_demo.json"),
    JSON.stringify({
      feature: "demo",
      status: "DONE",
      worktree: cwd,
      branch: "feature",
      commits: [],
      filesTouched: ["a.txt"],
      verification: { command: "test", exitCode: 0, summary: "pass" },
      markdownRequests: [{ path: "note.md", intent: "document", evidence: "a.txt" }],
    }),
  );
  writeFileSync(join(cwd, "a.txt"), "changed\n");
  actor(producerId, "implementer");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("native delivery ownership", () => {
  // Covers: R13
  it.each(["0.162.1", "0.163.0"])(
    "admits %s only with matching native identity and parent metadata",
    (version) => {
      actor(producerId, "implementer", { cli_version: version });
      expect(nativeActor(cwd)).toMatchObject({
        version,
        thread: producerId,
        root: rootId,
        parent: rootId,
        role: "implementer",
      });
      actor(producerId, "implementer", { cli_version: version, id: reviewerId });
      expect(nativeActor(cwd)).toBeUndefined();
      actor(producerId, "implementer", { cli_version: version, parent_thread_id: reviewerId });
      expect(nativeActor(cwd)).toBeUndefined();
    },
  );
  // Covers: R13
  it.each(["0.164.0", "0.163", "0.163.0-preview", "", null])(
    "rejects unsupported or malformed version %s",
    (version) => {
      actor(producerId, "implementer", { cli_version: version });
      expect(nativeActor(cwd)).toBeUndefined();
    },
  );
  // Covers: R5
  it("requires the own supported native role and rejects conflicts, missing and unsupported headers", () => {
    expect(nativeActor(cwd)?.role).toBe("implementer");
    actor(producerId, "implementer", { cli_version: "0.164.0" });
    expect(nativeActor(cwd)).toBeUndefined();
    actor(producerId, "implementer", { agent_role: "reviewer" });
    expect(nativeActor(cwd)).toBeUndefined();
    actor(producerId, "implementer", { parent_thread_id: reviewerId });
    expect(nativeActor(cwd)).toBeUndefined();
    vi.stubEnv("CODEX_THREAD_ID", reviewerId);
    expect(nativeActor(cwd)).toBeUndefined();
  });
  // Covers: R5, R13
  it.each(["0.162.1", "0.163.0"])(
    "binds producer delivery with %s, accepts an independent reviewer and rejects handoff/diff drift at every consumer",
    (version) => {
      actor(producerId, "implementer", { cli_version: version });
      expect(nativeActor(cwd)?.version).toBe(version);
      const options = { cwd, feature: "demo", target: "main", dir: state(""), gate: "test" };
      expect(attestHandoff(options)).toEqual({ status: "attested" });
      expect(beginReview(options).status).toBe("error");
      actor(producerId, "reviewer", { cli_version: version });
      expect(beginReview(options).status).toBe("error");
      actor(reviewerId, "reviewer", { cli_version: version });
      const begun = beginReview(options);
      expect(begun.status).toBe("begun");
      if (begun.status !== "begun") throw new Error("begin failed");
      writeFileSync(
        state("review_demo.json"),
        JSON.stringify({ feature: "demo", verdict: "APPROVED", findings: [] }),
      );
      expect(sealReview({ ...options, nonce: begun.nonce }).status).toBe("validated");
      const sidecar = ReviewSidecarSchema.parse(
        JSON.parse(readFileSync(state("review_demo.json"), "utf8")),
      );
      expect(correlateReview(resolveStateRoot(options), sidecar, options).correlation).toBe(
        "correlated",
      );
      expect(signReceipt(options).exitCode).toBe(0);
      expect(checkReceipt(options).exitCode).toBe(0);
      git("add", "a.txt");
      git("commit", "-qm", "reviewed publication bytes");
      expect(correlateReview(resolveStateRoot(options), sidecar, options).correlation).toBe(
        "correlated",
      );
      expect(checkReceipt(options).exitCode).toBe(0);
      writeFileSync(state("impl_demo.json"), readFileSync(state("impl_demo.json"), "utf8") + " ");
      expect(correlateReview(resolveStateRoot(options), sidecar, options).correlation).toBe(
        "unavailable",
      );
      expect(signReceipt(options).exitCode).toBe(1);
      expect(checkReceipt(options).exitCode).toBe(1);
      writeFileSync(join(cwd, "a.txt"), "drift\n");
      expect(beginReview(options).status).toBe("error");
    },
  );
  // Covers: R5
  it("permits linked checkout delivery with the same common-dir but rejects an unrelated repository", () => {
    const original = cwd;
    const sibling = join(dir, "sibling");
    git("worktree", "add", "-b", "sibling", sibling);
    expect(nativeActor(sibling)?.role).toBe("implementer");
    const other = join(dir, "other");
    mkdirSync(other);
    execFileSync("git", ["init", "-b", "main"], { cwd: other });
    expect(nativeActor(other)).toBeUndefined();
    expect(nativeActor(original)?.role).toBe("implementer");
  });
  // Covers: R5
  it("retains implementer ownership for approved engine mirrors and rejects unrequested prose or code", () => {
    const mirrors = [
      ".claude/agents/implementer.md",
      ".codex/agents/implementer.toml",
      ".pi/agents/implementer.md",
    ];
    const planPath = state("workplan_demo.json");
    const plan = JSON.parse(readFileSync(planPath, "utf8")) as {
      files: Array<{ path: string; new: boolean }>;
    };
    plan.files.push(...[...mirrors, "arbitrary.md"].map((path) => ({ path, new: true })));
    writeFileSync(planPath, JSON.stringify(plan));
    const options = { cwd, feature: "demo", target: "main" };
    expect(attestHandoff(options)).toEqual({ status: "attested" });
    writeFileSync(join(cwd, "note.md"), "note\n");
    for (const path of mirrors) {
      mkdirSync(join(cwd, path.slice(0, path.lastIndexOf("/"))), { recursive: true });
      writeFileSync(join(cwd, path), "generated agent mirror\n");
    }
    actor(scribeId, "scribe");
    writeFileSync(join(cwd, "arbitrary.md"), "unrequested prose\n");
    expect(attestHandoff(options).status).toBe("error");
    rmSync(join(cwd, "arbitrary.md"));
    expect(attestHandoff(options)).toEqual({ status: "attested" });
    actor(reviewerId, "reviewer");
    expect(beginReview({ ...options, gate: "" }).status).toBe("begun");
    actor(scribeId, "scribe");
    writeFileSync(join(cwd, "a.txt"), "unauthorized scribe code\n");
    expect(attestHandoff(options).status).toBe("error");
  });
});
