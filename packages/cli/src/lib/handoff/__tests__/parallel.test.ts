import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  beginParallel,
  checkParallel,
  completeParallel,
  finalizeParallel,
  prepareParallel,
} from "../parallel.ts";
import { attestHandoff, readOwnership } from "../actor-provenance.ts";
import { beginReview } from "../review-evidence.ts";
import { checkHandoff } from "../check.ts";

const cli = resolve(dirname(fileURLToPath(import.meta.url)), "../../../index.ts");
const liveScript = resolve(dirname(cli), "../../../scripts/js/check-scribe-parallel-live.mjs");
const feature = "demo-e1";
const rootId = "00000000-0000-0000-0000-000000000001";
const threads = {
  implementer: "00000000-0000-0000-0000-000000000002",
  scribe: "00000000-0000-0000-0000-000000000003",
  reviewer: "00000000-0000-0000-0000-000000000004",
};
const request = {
  spec: "demo",
  delivery: "E1",
  milestone: "M1",
  implementerPaths: ["a.ts"],
  markdownRequests: [
    { path: "docs/note.md", intent: "Document the accepted contract", evidence: "R1" },
  ],
  derivedPaths: ["AGENTS.md"],
};
let temp: string;
let cwd: string;
let runId: string;
const state = (file: string): string => join(cwd, ".navori/state/handoffs", file);
const options = (): { cwd: string; feature: string; target: string; gate: string } => ({
  cwd,
  feature,
  target: "main",
  gate: "",
});
const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const writeJson = (file: string, value: unknown): void =>
  writeFileSync(file, JSON.stringify(value));

/** Synthetic native headers exercise the unit boundary, never live acceptance evidence. */
function actor(role: keyof typeof threads, extra: Record<string, unknown> = {}): void {
  const thread = threads[role];
  vi.stubEnv("CODEX_THREAD_ID", thread);
  writeFileSync(
    join(temp, "sessions/2026/10/15", `rollout-${thread}.jsonl`),
    `${JSON.stringify({ type: "session_meta", payload: { id: thread, session_id: rootId, parent_thread_id: rootId, cli_version: "0.162.1", cwd, agent_role: role, source: { subagent: { thread_spawn: { parent_thread_id: rootId, agent_role: role } } }, ...extra } })}\n`,
  );
}

async function prepare(custom: unknown = request): ReturnType<typeof prepareParallel> {
  const result = await prepareParallel({ ...options(), request: custom });
  runId = result.runId ?? "";
  return result;
}
function complete(
  role: "implementer" | "scribe",
  status = "DONE",
): ReturnType<typeof completeParallel> {
  actor(role);
  beginParallel({ ...options(), runId });
  return completeParallel({
    ...options(),
    runId,
    status,
    reason: status === "BLOCKED" ? "Producer cannot continue" : undefined,
  });
}
function handoff(extra: Record<string, unknown> = {}): void {
  writeJson(state(`impl_${feature}.json`), {
    feature,
    status: "DONE",
    worktree: cwd,
    branch: "feature",
    head: git("rev-parse", "HEAD"),
    commits: [],
    filesTouched: ["a.ts", "docs/note.md"],
    verification: { command: "test", exitCode: 0, summary: "pass" },
    markdownRequests: request.markdownRequests,
    blockers: [],
    ...extra,
  });
}
function produced(): void {
  writeFileSync(join(cwd, "a.ts"), "export const value = 2;\n");
  writeFileSync(join(cwd, "docs/note.md"), "Accepted contract\n");
}

beforeEach(() => {
  temp = realpathSync(mkdtempSync(join(tmpdir(), "navori-parallel-")));
  cwd = join(temp, "repo");
  mkdirSync(cwd);
  git("init", "-b", "main");
  git("config", "user.email", "test@example.test");
  git("config", "user.name", "Test");
  mkdirSync(join(cwd, "docs"));
  writeFileSync(join(cwd, "a.ts"), "export const value = 1;\n");
  writeJson(join(cwd, "navori.config.json"), {
    name: "parallel-test",
    engines: ["codex"],
    preset: "custom",
    harness: { scribeOwnsMarkdown: true },
    sdd: { specsDir: ".navori/state/specs" },
  });
  git("add", ".");
  git("commit", "-qm", "base");
  git("switch", "-c", "feature");
  mkdirSync(state(""), { recursive: true });
  const spec = join(cwd, ".navori/state/specs/demo");
  mkdirSync(spec, { recursive: true });
  writeFileSync(join(spec, "requirements.md"), "- **R1** The value and its guide agree.\n");
  writeFileSync(join(spec, "design.md"), "The approved implementation exports the value.\n");
  writeFileSync(
    join(spec, "tasks.md"),
    "## E1 — Delivery\nEstimated LOC: 10\n### M1 — Work\n- **A1** [observable] `test` → pass\n- [ ] **T1** (R1) — Ship value; effect: behavior; test: test\n",
  );
  writeJson(state(`workplan_${feature}.json`), {
    feature,
    level: 3,
    classification: { level: 2, score: 8, signals: ["concurrency"] },
    objective: "Deliver accepted spec",
    files: ["a.ts", "docs/note.md", "AGENTS.md"].map((path) => ({ path, new: path !== "a.ts" })),
    acceptance: [{ id: "A1", description: "observable value", command: "test", expected: "pass" }],
    solution: { path: "solution.json", verdict: "READY" },
    phases: [{ name: "delivery", acceptance: ["A1"] }],
    risks: [{ risk: "drift", rollback: "stop" }],
  });
  mkdirSync(join(temp, "sessions/2026/10/15"), { recursive: true });
  vi.stubEnv("CODEX_HOME", temp);
  vi.spyOn(process, "cwd").mockImplementation(() => cwd);
  actor("implementer");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(temp, { recursive: true, force: true });
});

describe("parallel delivery authorization", () => {
  it("permits prior scribe preflight without inventing a completed handoff; serial still needs one", async () => {
    expect((await prepare()).status).toBe("prepared");
    expect(checkParallel(options()).status).toBe("ok");
    const check = {
      ...options(),
      dir: ".navori/state/handoffs",
      consumer: "scribe" as const,
      evidenceOptions: options(),
    };
    expect(checkHandoff({ ...check, parallel: true }).status).toBe("ok");
    expect(checkHandoff(check).status).toBe("findings");
    expect(checkHandoff({ ...check, consumer: "orchestrator", parallel: true }).status).toBe(
      "findings",
    );
    expect((await prepare()).status).toBe("error");
  });

  it.each(["implementer", "scribe"] as const)(
    "joins genuine native roles with %s finishing first, then admits only an independent reviewer",
    async (first) => {
      expect((await prepare()).status).toBe("prepared");
      produced();
      expect(complete(first).status).toBe("completed");
      actor("implementer");
      handoff();
      expect(finalizeParallel(options()).status).toBe("error");
      actor("reviewer");
      expect(beginReview(options()).status).toBe("error");
      expect(complete(first === "scribe" ? "implementer" : "scribe").status).toBe("completed");
      // Official render outputs are only allowed beyond the joint barrier.
      writeFileSync(join(cwd, "AGENTS.md"), "generated output\n");
      actor("implementer");
      expect(finalizeParallel(options())).toMatchObject({ status: "finalized", runId });
      expect(readOwnership(cwd, feature)?.actors.map((a) => a.role)).toEqual([
        "implementer",
        "scribe",
      ]);
      expect(beginReview(options()).status).toBe("error");
      actor("reviewer");
      expect(beginReview(options()).status).toBe("begun");
      git("add", "a.ts", "docs/note.md", "AGENTS.md");
      git("commit", "-qm", "reviewed publication bytes");
      expect(beginReview(options()).status).toBe("begun");
      writeFileSync(join(cwd, "docs/note.md"), "post-DONE mutation\n");
      expect(beginReview(options()).status).toBe("error");
    },
  );

  it("blocks stale serial ownership, serial attest and malformed authority without falling back", async () => {
    handoff();
    expect(attestHandoff(options()).status).toBe("attested");
    actor("reviewer");
    expect(beginReview(options()).status).toBe("begun");
    expect((await prepare()).status).toBe("prepared");
    expect(beginReview(options()).status).toBe("error");
    actor("implementer");
    expect(attestHandoff(options()).status).toBe("error");
    writeFileSync(state(`parallel_${feature}.json`), "broken");
    actor("reviewer");
    expect(beginReview(options()).status).toBe("error");
  });

  it.each([
    { ...request, implementerPaths: ["docs/note.md"] },
    { ...request, implementerPaths: ["../a.ts"] },
    { ...request, implementerPaths: ["/a.ts"] },
    { ...request, implementerPaths: ["not-approved.ts"] },
    { ...request, implementerPaths: ["docs"] },
    { ...request, derivedPaths: ["a.ts"] },
    {
      ...request,
      markdownRequests: [{ ...request.markdownRequests[0], path: ".navori/state/escape.md" }],
    },
    { ...request, milestone: "M2" },
    { ...request, delivery: "E2" },
    { ...request, actor: threads.implementer },
  ])("rejects crossed, escaping or caller-invented authority: %j", async (custom) => {
    expect((await prepare(custom)).status).toBe("error");
  });

  it("rejects symlinked files and parents, even dangling or created after preparation", async () => {
    symlinkSync("missing", join(cwd, "docs/note.md"));
    expect((await prepare()).status).toBe("error");
    rmSync(join(cwd, "docs/note.md"));
    expect((await prepare()).status).toBe("prepared");
    rmSync(join(cwd, "docs"), { recursive: true });
    symlinkSync(temp, join(cwd, "docs"));
    expect(checkParallel(options()).status).toBe("error");
  });

  it.each(["head", "branch", "base", "plan", "spec", "config", "outside", "render"])(
    "fails closed on %s drift",
    async (kind) => {
      expect((await prepare()).status).toBe("prepared");
      if (kind === "head") git("commit", "--allow-empty", "-qm", "moved");
      if (kind === "branch") git("branch", "-m", "other");
      if (kind === "base") {
        git("commit", "--allow-empty", "-qm", "base moved");
        git("update-ref", "refs/heads/main", "HEAD");
      }
      if (kind === "plan")
        writeJson(state(`workplan_${feature}.json`), {
          ...JSON.parse(readFileSync(state(`workplan_${feature}.json`), "utf8")),
          objective: "changed material scope",
        });
      if (kind === "spec")
        writeFileSync(join(cwd, ".navori/state/specs/demo/design.md"), "changed accepted design");
      if (kind === "config")
        writeFileSync(
          join(cwd, "navori.config.json"),
          readFileSync(join(cwd, "navori.config.json"), "utf8") + " ",
        );
      if (kind === "outside") writeFileSync(join(cwd, "outside.txt"), "unapproved\n");
      if (kind === "render") writeFileSync(join(cwd, "AGENTS.md"), "premature render\n");
      expect(checkParallel(options()).status).toBe("error");
      expect(complete("implementer").status).toBe("error");
    },
  );

  it("requires level 3, enabled flag and current target", async () => {
    const planPath = state(`workplan_${feature}.json`);
    const raw = readFileSync(planPath, "utf8");
    writeJson(planPath, { ...JSON.parse(raw), level: 2 });
    expect((await prepare()).status).toBe("error");
    writeFileSync(planPath, raw);
    const configPath = join(cwd, "navori.config.json");
    const config: Record<string, unknown> = JSON.parse(readFileSync(configPath, "utf8"));
    writeJson(configPath, { ...config, harness: { scribeOwnsMarkdown: false } });
    expect((await prepare()).status).toBe("error");
    writeJson(configPath, config);
    expect((await prepare()).status).toBe("prepared");
    expect(checkParallel({ ...options(), target: "other" }).status).toBe("error");
  });

  it("rejects missing native context, unsupported roles, stale runs and replayed completions", async () => {
    expect((await prepare()).status).toBe("prepared");
    vi.stubEnv("CODEX_THREAD_ID", "missing");
    expect(completeParallel({ ...options(), runId, status: "DONE" }).status).toBe("error");
    actor("reviewer");
    expect(completeParallel({ ...options(), runId, status: "DONE" }).status).toBe("error");
    actor("implementer");
    expect(completeParallel({ ...options(), runId: rootId, status: "DONE" }).status).toBe("error");
    expect(completeParallel({ ...options(), runId, status: "APPROVED" }).status).toBe("error");
    expect(complete("implementer").status).toBe("completed");
    expect(complete("implementer").status).toBe("error");
  });

  it("requires a fresh immutable begin and rejects a different native worker completing its claim", async () => {
    expect((await prepare()).status).toBe("prepared");
    expect(completeParallel({ ...options(), runId, status: "DONE" }).status).toBe("error");
    expect(beginParallel({ ...options(), runId: rootId }).status).toBe("error");
    expect(beginParallel({ ...options(), runId }).status).toBe("ok");
    expect(beginParallel({ ...options(), runId }).status).toBe("error");
    actor("implementer", { session_id: threads.reviewer });
    expect(completeParallel({ ...options(), runId, status: "DONE" }).status).toBe("error");
  });

  it("uses a real origin ref when configured and rejects missing refs rather than falling back", async () => {
    git("remote", "add", "origin", cwd);
    expect((await prepare()).status).toBe("error");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    expect((await prepare()).status).toBe("prepared");
    git("commit", "--allow-empty", "-qm", "remote moved");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    expect(checkParallel(options()).status).toBe("error");
  });

  it("binds a clean committed bootstrap HEAD and rejects later writes to its readonly inputs", async () => {
    const bootstrap = join(cwd, "immutable-fixture.test.ts");
    writeFileSync(bootstrap, "accepted executable specification\n");
    git("add", "immutable-fixture.test.ts");
    git("commit", "-qm", "accepted verification baseline");
    expect((await prepare()).status).toBe("prepared");
    produced();
    expect(checkParallel(options()).status).toBe("ok");
    writeFileSync(bootstrap, "changed executable specification\n");
    expect(checkParallel(options()).status).toBe("error");
    expect(complete("implementer").status).toBe("error");
  });

  it("rejects dirty delivery scope even when requested and divergent staged bytes at preparation", async () => {
    writeFileSync(join(cwd, "a.ts"), "already written before authorization\n");
    expect((await prepare()).status).toBe("error");
    git("add", "a.ts");
    writeFileSync(join(cwd, "a.ts"), "export const value = 1;\n");
    expect((await prepare()).status).toBe("error");
  });

  it("preserves final ownership through only acceptance bookkeeping and versioned task checkboxes", async () => {
    const spec = join(cwd, "specs/demo");
    mkdirSync(spec, { recursive: true });
    for (const file of ["requirements.md", "design.md", "tasks.md"])
      writeFileSync(join(spec, file), readFileSync(join(cwd, ".navori/state/specs/demo", file)));
    const config = JSON.parse(readFileSync(join(cwd, "navori.config.json"), "utf8")) as Record<
      string,
      unknown
    >;
    writeJson(join(cwd, "navori.config.json"), { ...config, sdd: { specsDir: "specs" } });
    git("add", "specs", "navori.config.json");
    git("commit", "-qm", "accepted versioned inputs");
    expect((await prepare()).status).toBe("prepared");
    produced();
    complete("implementer");
    complete("scribe");
    actor("implementer");
    handoff();
    expect(finalizeParallel(options()).status).toBe("finalized");
    const planPath = state(`workplan_${feature}.json`);
    const plan = JSON.parse(readFileSync(planPath, "utf8")) as Record<string, unknown>;
    writeJson(planPath, {
      ...plan,
      progress: { A1: "cumplido" },
      evidence: { A1: { kind: "unevidenced", reason: "engine-without-signal" } },
    });
    const tasks = join(spec, "tasks.md");
    writeFileSync(tasks, readFileSync(tasks, "utf8").replace("[ ] **T1**", "[x] **T1**"));
    actor("reviewer");
    expect(beginReview(options()).status).toBe("begun");
    writeFileSync(tasks, readFileSync(tasks, "utf8").replace("Ship value", "Change behavior"));
    expect(beginReview(options()).status).toBe("error");
    writeFileSync(tasks, readFileSync(tasks, "utf8").replace("Change behavior", "Ship value"));
    writeJson(planPath, {
      ...plan,
      acceptance: [
        {
          id: "A1",
          description: "observable value",
          command: "different command",
          expected: "pass",
        },
      ],
    });
    expect(beginReview(options()).status).toBe("error");
  });

  it("starts an explicit archived correction without a premature commit and rejects old claims", async () => {
    expect((await prepare()).status).toBe("prepared");
    const firstRun = runId;
    expect((await prepareParallel({ ...options(), request, supersede: firstRun })).status).toBe(
      "error",
    );
    produced();
    complete("implementer");
    complete("scribe");
    actor("implementer");
    handoff();
    expect(finalizeParallel(options()).status).toBe("finalized");
    expect((await prepareParallel({ ...options(), request, supersede: rootId })).status).toBe(
      "error",
    );
    const correction = await prepareParallel({ ...options(), request, supersede: firstRun });
    expect(correction.status).toBe("prepared");
    runId = correction.runId!;
    expect(runId).not.toBe(firstRun);
    expect(
      JSON.parse(readFileSync(state(`parallel_${feature}_${firstRun}_authorization.json`), "utf8"))
        .runId,
    ).toBe(firstRun);
    actor("reviewer");
    expect(beginReview(options()).status).toBe("error");
    actor("implementer");
    expect(completeParallel({ ...options(), runId: firstRun, status: "DONE" }).status).toBe(
      "error",
    );
    writeFileSync(join(cwd, "a.ts"), "export const value = 3;\n");
    complete("scribe");
    complete("implementer");
    handoff();
    expect(finalizeParallel(options()).status).toBe("finalized");
    actor("reviewer");
    expect(beginReview(options()).status).toBe("begun");
  });

  it("allows the next accepted milestone while freezing prior uncommitted delivery paths", async () => {
    const taskPath = join(cwd, ".navori/state/specs/demo/tasks.md");
    writeFileSync(
      taskPath,
      readFileSync(taskPath, "utf8") +
        "### M2 — Next\n- **A2** [observable] `test next` → pass\n- [ ] **T2** (R1) — Extend value; effect: behavior; test: test next\n",
    );
    const planPath = state(`workplan_${feature}.json`);
    const plan = JSON.parse(readFileSync(planPath, "utf8")) as {
      files: Array<{ path: string; new: boolean }>;
    };
    plan.files.push({ path: "b.ts", new: true });
    writeJson(planPath, plan);
    expect((await prepare()).status).toBe("prepared");
    const firstRun = runId;
    produced();
    complete("implementer");
    complete("scribe");
    const nextRequest = { ...request, milestone: "M2", implementerPaths: ["b.ts"] };
    writeFileSync(join(cwd, "a.ts"), "unattributed change between milestones\n");
    expect(
      (await prepareParallel({ ...options(), request: nextRequest, supersede: firstRun })).status,
    ).toBe("error");
    writeFileSync(join(cwd, "a.ts"), "export const value = 2;\n");
    const next = await prepareParallel({
      ...options(),
      request: nextRequest,
      supersede: firstRun,
    });
    expect(next.status).toBe("prepared");
    runId = next.runId!;
    expect(checkParallel(options()).status).toBe("ok");
    writeFileSync(join(cwd, "b.ts"), "export const next = 2;\n");
    writeFileSync(join(cwd, "a.ts"), "changed frozen M1\n");
    expect(checkParallel(options()).status).toBe("error");
    writeFileSync(join(cwd, "a.ts"), "export const value = 2;\n");
    complete("implementer");
    complete("scribe");
    actor("implementer");
    handoff({ filesTouched: ["b.ts", "docs/note.md"] });
    expect(finalizeParallel(options()).status).toBe("finalized");
    actor("reviewer");
    expect(beginReview(options()).status).toBe("begun");
  });

  it("parses only literal native calls and correlates an actual successful output by call ID", async () => {
    const { literalOperation, nativeCalls, patchPaths } = (await import(liveScript)) as {
      literalOperation: (input: string) => unknown;
      nativeCalls: (events: unknown[]) => unknown[];
      patchPaths: (patch: string, cwd: string) => string[];
    };
    const patch = "*** Begin Patch\n*** Add File: docs/note.md\n+guide\n*** End Patch";
    const input = `text(await tools.apply_patch(${JSON.stringify(patch)}));`;
    expect(literalOperation(input)).toEqual({ kind: "patch", patch });
    expect(literalOperation("text(await tools.apply_patch(process.env.PATCH));")).toBeUndefined();
    expect(literalOperation(`const fake = ${JSON.stringify(input)};`)).toBeUndefined();
    expect(literalOperation(`${input}\ntext(await tools.apply_patch("other"));`)).toBeUndefined();
    const events = [
      {
        timestamp: "2026-10-15T12:00:00Z",
        type: "response_item",
        payload: { type: "custom_tool_call", name: "exec", call_id: "actual", input },
      },
      {
        timestamp: "2026-10-15T12:00:01Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "unrelated",
          output: [{ type: "input_text", text: "{}" }],
        },
      },
      {
        timestamp: "2026-10-15T12:00:02Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "actual",
          output: [
            { type: "input_text", text: "Script completed\nWall time 0.2 seconds\nOutput:\n" },
            { type: "input_text", text: "{}" },
          ],
        },
      },
    ];
    expect(nativeCalls(events)).toMatchObject([
      { success: true, result: {}, operation: { kind: "patch", patch } },
    ]);
    expect(nativeCalls(events.slice(0, 2))).toEqual([]);
    expect(patchPaths(patch, cwd)).toEqual(["docs/note.md"]);
    expect(() => patchPaths(patch.replace("docs/note.md", "../foreign.md"), cwd)).toThrow(
      "escapes",
    );
  });

  it("fails live acceptance closed when current real native evidence is absent", () => {
    const scriptDir = join(temp, "scripts/js");
    mkdirSync(scriptDir, { recursive: true });
    const script = join(scriptDir, "check-scribe-parallel-live.mjs");
    writeFileSync(script, readFileSync(liveScript));
    const result = spawnSync("node", [script], { cwd: temp, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("A4 unavailable");
    expect(result.stdout).toBe("");
  });

  it.each(["BLOCKED", "changed-own", "wrong-root", "stale-record", "forged-final"])(
    "does not finalize %s evidence",
    async (kind) => {
      expect((await prepare()).status).toBe("prepared");
      produced();
      expect(complete("implementer", kind === "BLOCKED" ? "BLOCKED" : "DONE").status).toBe(
        "completed",
      );
      if (kind === "wrong-root") actor("scribe", { session_id: threads.reviewer });
      else actor("scribe");
      expect(beginParallel({ ...options(), runId }).status).toBe("ok");
      expect(completeParallel({ ...options(), runId, status: "DONE" }).status).toBe("completed");
      if (kind === "changed-own") writeFileSync(join(cwd, "a.ts"), "changed after DONE\n");
      if (kind === "stale-record") {
        const path = state(`parallel_${feature}_${runId}_scribe.json`);
        writeJson(path, { ...JSON.parse(readFileSync(path, "utf8")), runId: rootId });
      }
      handoff(kind === "forged-final" ? { markdownRequests: [] } : {});
      actor("implementer");
      expect(finalizeParallel(options()).status).toBe("error");
      actor("reviewer");
      expect(beginReview(options()).status).toBe("error");
    },
  );

  it("exercises successful CLI prepare, prior check, two role completions and serial join", async () => {
    const requestPath = join(cwd, ".navori/state/request.json");
    writeJson(requestPath, request);
    const run = (
      ...args: string[]
    ): { code: number | null; result: { status: string; runId?: string } } => {
      const child = spawnSync("bun", [cli, "handoff", ...args, "--json"], {
        cwd,
        encoding: "utf8",
        env: process.env,
      });
      expect(child.stderr).toBe("");
      return { code: child.status, result: JSON.parse(child.stdout) };
    };
    const prepared = run("prepare-parallel", feature, "--request", requestPath, "--target", "main");
    expect(prepared.code).toBe(0);
    runId = prepared.result.runId!;
    expect(run("check", feature, "--for", "scribe", "--parallel").result.status).toBe("ok");
    produced();
    expect(run("begin-parallel", feature, "--run", runId).code).toBe(0);
    expect(run("complete-parallel", feature, "--run", runId, "--status", "DONE").code).toBe(0);
    actor("scribe");
    expect(run("begin-parallel", feature, "--run", runId).code).toBe(0);
    expect(run("complete-parallel", feature, "--run", runId, "--status", "DONE").code).toBe(0);
    actor("implementer");
    handoff();
    expect(run("finalize-parallel", feature, "--target", "main").result.status).toBe("finalized");
    actor("reviewer");
    expect(beginReview(options()).status).toBe("begun");
  });
});
