import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { lstatSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import {
  advanceLiveTask,
  collectAuditArgs,
  collectLiveRun,
  launchLiveRun,
  liveEnvironment,
  LIVE_TASKS,
  prepareLiveRun,
  readLiveRun,
  qualifyLiveReport,
} from "../live.ts";
import { LiveOptionsSchema, type LiveRun } from "../live.schema.ts";
import { benchmarkByEngine } from "../../audit/engine-benchmark.ts";

let root: string;

function run(cwd: string, program: string, args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(program, args, {
    cwd,
    env: liveEnvironment(root, "claude", readLiveRun(root).run.engines.claude.sessionId),
    timeout: 30_000,
    encoding: "utf8",
  });
}

describe.runIf(process.platform !== "win32")("live benchmark preparation", (): void => {
  beforeAll((): void => {
    root = prepareLiveRun().root;
  }, 60_000);
  afterAll((): void => {
    if (root) rmSync(root, { recursive: true, force: true });
  });
  // Covers: R2 (0053)
  it("prepares both real Git checkouts and keeps the no-credentials result inconclusive", (): void => {
    const state = readLiveRun(root).run;
    expect(state.engines.claude.launched).toBe(false);
    expect(state.engines.pi.launched).toBe(false);
    expect(collectLiveRun(root)).toMatchObject({ result: "inconclusive" });
    for (const engine of ["claude", "pi"] as const) {
      const cwd = join(root, engine);
      expect(readdirSync(join(cwd, "src/filler"))).toHaveLength(60);
      expect(run(cwd, "git", ["status", "--porcelain"]).stdout).toBe("");
      expect(run(cwd, "node", ["--test"]).status).toBe(0);
      expect(lstatSync(join(cwd, ".pi/extensions/navori.ts")).isFile()).toBe(true);
      const config = JSON.parse(readFileSync(join(cwd, "navori.config.json"), "utf8")) as unknown;
      expect(config).toMatchObject({
        harness: { planTiers: true, scribeOwnsMarkdown: true },
        plugins: { tgrep: { enabled: true } },
      });
    }
    expect(run(join(root, "claude"), "git", ["rev-parse", "HEAD"]).stdout).toEqual(
      run(join(root, "pi"), "git", ["rev-parse", "HEAD"]).stdout,
    );
  });

  // Covers: R2 (0053)
  it("uses a local-only gh and records no free-text PR body", (): void => {
    const cwd = join(root, "claude");
    writeFileSync(join(cwd, "probe.txt"), "local fixture\n");
    expect(run(cwd, "git", ["add", "probe.txt"]).status).toBe(0);
    expect(run(cwd, "git", ["commit", "-m", "Local fixture probe"]).status).toBe(0);
    const gh = join(root, "claude-bin/gh");
    const before = run(cwd, "git", [
      "--git-dir",
      join(root, "remote.git"),
      "rev-parse",
      "refs/heads/claude/benchmark",
    ]);
    const auth = run(cwd, gh, ["auth", "status"]);
    expect(auth.status).toBe(0);
    expect(String(auth.stdout)).toContain("local benchmark");
    expect(
      run(cwd, "git", [
        "--git-dir",
        join(root, "remote.git"),
        "rev-parse",
        "refs/heads/claude/benchmark",
      ]).stdout,
    ).toEqual(before.stdout);
    expect(run(cwd, gh, ["auth", "token"]).status).toBe(64);
    expect(run(cwd, gh, ["issue", "list"]).status).toBe(64);
    expect(
      run(cwd, gh, ["pr", "create", "--repo", "unrelated/example", "--body", "PRIVATE_BODY_TOKEN"])
        .status,
    ).toBe(0);
    const log = readFileSync(join(root, "claude-pr-attempts.jsonl"), "utf8");
    expect(log).not.toContain("PRIVATE_BODY_TOKEN");
    expect(JSON.parse(log)).toMatchObject({
      event: "local-pr-create",
      ref: "refs/heads/claude/benchmark",
    });
    const local = run(cwd, "git", ["rev-parse", "HEAD"]);
    const bare = run(cwd, "git", [
      "--git-dir",
      join(root, "remote.git"),
      "rev-parse",
      "refs/heads/claude/benchmark",
    ]);
    expect(bare.stdout).toEqual(local.stdout);
  });

  // Covers: R2 (0053)
  it("activates the red pagination test in tracked bytes only at task 2", (): void => {
    const cwd = join(root, "pi");
    expect(run(cwd, "node", ["--test", "test/paginate.test.js"]).status).toBe(0);
    expect(() => advanceLiveTask(root, "pi", 3)).toThrow("one task");
    expect(advanceLiveTask(root, "pi", 2)).toBe(LIVE_TASKS[1]);
    expect(run(cwd, "node", ["--test", "test/paginate.test.js"]).status).toBe(1);
    const diff = run(cwd, "git", ["diff", "--name-only"]);
    expect(String(diff.stdout)).toContain("test/paginate.test.js");
    expect(collectLiveRun(root)).toMatchObject({ result: "inconclusive" });
  });

  // Covers: R2 (0053)
  it("refuses live access without opt-in and inside CI", async (): Promise<void> => {
    vi.stubEnv("NAVORI_LIVE_BENCH", "");
    try {
      await expect(launchLiveRun(root, "claude", "sonnet")).rejects.toThrow("NAVORI_LIVE_BENCH");
    } finally {
      vi.unstubAllEnvs();
    }
    vi.stubEnv("NAVORI_LIVE_BENCH", "1");
    vi.stubEnv("CI", "true");
    try {
      await expect(launchLiveRun(root, "claude", "sonnet")).rejects.toThrow("outside CI");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // Covers: R2 (0053)
  it("refuses headless execution even with the opt-in flag", (): void => {
    const env: NodeJS.ProcessEnv = { ...process.env, NAVORI_LIVE_BENCH: "1" };
    delete env.CI;
    const result = spawnSync(
      process.execPath,
      [
        resolve(import.meta.dirname, "../../../../../../scripts/bench/run-live.ts"),
        "launch",
        "--root",
        root,
        "--engine",
        "claude",
        "--model",
        "sonnet",
      ],
      { env, encoding: "utf8", timeout: 10_000 },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("operator's own interactive terminal");
  });

  // Covers: R2 (0053)
  it("rejects ambiguous or permission-shaped model arguments before any launch", (): void => {
    for (const model of ["--dangerously-skip-permissions", "sonnet --print", ""]) {
      expect(
        LiveOptionsSchema.safeParse({ action: "launch", root, engine: "claude", model }).success,
      ).toBe(false);
    }
    expect(
      LiveOptionsSchema.safeParse({ action: "launch", root, engine: "pi", model: "sonnet" })
        .success,
    ).toBe(false);
    expect(
      LiveOptionsSchema.safeParse({ action: "launch", root, engine: "claude", model: "sonnet" })
        .success,
    ).toBe(true);
    expect(LiveOptionsSchema.safeParse({ action: "collect", root, model: "sonnet" }).success).toBe(
      false,
    );
  });

  // Covers: R2 (0053)
  it("does not pass an outer host's session or Git repository into the benchmark parent", (): void => {
    vi.stubEnv("CLAUDE_CODE_CHILD_SESSION", "1");
    vi.stubEnv("CODEX_THREAD_ID", "outer");
    vi.stubEnv("NAVORI_AUDIT_AGENT_ID", "outer-agent");
    vi.stubEnv("GIT_DIR", "/outside/repository");
    try {
      const env = liveEnvironment(root, "pi", readLiveRun(root).run.engines.pi.sessionId);
      for (const key of [
        "CLAUDE_CODE_CHILD_SESSION",
        "CODEX_THREAD_ID",
        "NAVORI_AUDIT_AGENT_ID",
        "GIT_DIR",
      ])
        expect(env[key]).toBeUndefined();
      expect(env.NAVORI_AUDIT_HOST).toBe("pi");
      expect(env.NAVORI_AUDITS_ROOT).toBe(join(root, "audits"));
      expect(env.GIT_CONFIG_GLOBAL).toBe(join(root, "gitconfig"));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // Covers: R2 (0053)
  it("collect's audit invocation passes the real audit flag validation", (): void => {
    const result = run(root, "node", collectAuditArgs(root));
    expect(result.status).toBe(0);
    const report = JSON.parse(String(result.stdout)) as { engines?: unknown };
    expect(Array.isArray(report.engines)).toBe(true);
  });

  // Covers: R2 (0053)
  it("cannot turn completed local labels and audit headers into a pass without native sources", (): void => {
    const file = join(root, "run.json");
    const original = readFileSync(file, "utf8");
    const state: LiveRun = readLiveRun(root).run;
    try {
      for (const engine of ["claude", "pi"] as const) {
        state.engines[engine] = {
          ...state.engines[engine],
          task: 5,
          launched: true,
          model: "fixture/model",
          version: "fixture",
        };
        const directory = join(root, "audits", engine);
        mkdirSync(directory, { mode: 0o700 });
        writeFileSync(
          join(directory, `session-${state.engines[engine].sessionId}.log`),
          JSON.stringify({
            event: "start",
            host: engine,
            sessionId: state.engines[engine].sessionId,
            cwd: join(root, engine),
            repo: engine,
            ts: new Date().toISOString(),
          }) + "\n",
          { mode: 0o600 },
        );
      }
      writeFileSync(file, JSON.stringify(state));
      expect(collectLiveRun(root)).toMatchObject({ result: "inconclusive" });
    } finally {
      writeFileSync(file, original);
      for (const engine of ["claude", "pi"] as const)
        rmSync(join(root, "audits", engine), { recursive: true, force: true });
    }
  });

  // Covers: R2 (0053)
  it.each(["pass", "fail", "inconclusive"] as const)(
    "retains observed metrics and qualifies an incomplete %s report",
    (result): void => {
      const sample = benchmarkByEngine([], { state: "unavailable", reason: "not-requested" });
      sample.result = result;
      sample.engines[0]!.sessions = 2;
      const report = qualifyLiveReport(sample, false);
      expect(report.result).toBe(result === "fail" ? "fail" : "inconclusive");
      expect(report.engines[0]?.sessions).toBe(2);
      expect(report.comparisonVerification).toBe("unverified");
      expect(report.inconclusiveReasons).toContain("five-task-set-incomplete");
    },
  );
});
