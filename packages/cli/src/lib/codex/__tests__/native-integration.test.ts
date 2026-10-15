import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runNativeIntegration, preflightNativeProfileProbe } from "../native-integration.ts";
import type { NativeApprovalScope } from "../approval-route.ts";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  snapshot: vi.fn(),
  revalidate: vi.fn(),
  decision: vi.fn(),
  root: vi.fn(),
  isolation: vi.fn<() => boolean>(),
}));
vi.mock(import("node:child_process"), () => ({ spawn: mocks.spawn, spawnSync: mocks.spawnSync }));
vi.mock(import("../approval-route.ts"), () => ({
  snapshotNativeApproval: mocks.snapshot,
  revalidateNativeApproval: mocks.revalidate,
}));
vi.mock(import("../approval-controller.ts"), () => ({ requestBrowserDecision: mocks.decision }));
vi.mock(import("../approval-ui.ts"), () => ({
  approvalSourceIsolationAvailable: mocks.isolation,
}));
vi.mock(import("../../primitives/state-root.ts"), async (original) => ({
  ...(await original()),
  resolveStateRoot: mocks.root,
}));

const requestId = "b771998e-155d-4213-af16-c3ae36ebc49e";
let cwd: string;
let scenario:
  | "valid"
  | "policy"
  | "network"
  | "mcp"
  | "wrong-context"
  | "missing-item"
  | "bad-version"
  | "replay"
  | "child-only"
  | "child-relay"
  | "closed-after-effect"
  | "closed" = "valid";
let responses: Array<Record<string, unknown>>;
let scopes: NativeApprovalScope;
let completionStatus: unknown;
let completionSuccess: unknown;

/** Deterministic native protocol double; real human/native evidence remains separate acceptance. */
function childDouble(): EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: () => void;
} {
  const childFirst =
    scenario === "child-relay" ||
    scenario === "replay" ||
    scenario === "closed" ||
    scenario === "closed-after-effect";
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  const emit = (message: unknown): void => {
    child.stdout.write(`${JSON.stringify(message)}\n`);
  };
  child.stdin.on("data", (bytes: Buffer) => {
    const message = JSON.parse(bytes.toString()) as {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      result?: unknown;
    };
    if (message.method === undefined) {
      responses.push(message);
      return;
    }
    if (message.id === undefined) return;
    let result: unknown = {};
    if (message.method === "initialize")
      result = {
        platformOs: "macos",
        userAgent: scenario === "bad-version" ? "codex/0.100.0" : "codex_cli_rs/0.162.1",
      };
    if (message.method === "config/read")
      result = {
        config: {
          features: { plugins: false, apps: false },
          browser_use: {
            default_origin_policy: { access: scenario === "policy" ? "allow" : "deny" },
          },
          computer_use: { default_app_access: "deny" },
          mcp_servers: {},
        },
      };
    if (message.method === "command/exec")
      result = { exitCode: scenario === "network" ? 0 : 1, stdout: "", stderr: "EPERM" };
    if (message.method === "thread/start")
      result = {
        thread: { id: "native-main" },
        sandbox: { type: "readOnly", networkAccess: false },
        approvalPolicy: "never",
        approvalsReviewer: "user",
      };
    if (message.method === "mcpServerStatus/list")
      result = { data: [{ tools: scenario === "mcp" ? { browser: {} } : {} }], nextCursor: null };
    if (message.method === "turn/start") result = { turn: { id: "turn" } };
    queueMicrotask(() => {
      emit({ id: message.id, result });
      if (message.method === "turn/start") {
        const threadId =
          scenario === "wrong-context"
            ? "foreign"
            : scenario === "child-only" || childFirst
              ? "native-child"
              : "native-main";
        emit({
          method: "thread/started",
          params: { thread: { id: "native-child", parentThreadId: "native-main" } },
        });
        if (scenario !== "missing-item")
          emit({
            method: "item/started",
            params: {
              threadId,
              turnId: "turn",
              item: { type: "dynamicToolCall", tool: "github_pr_create", id: "call" },
            },
          });
        emit({
          id: 0,
          method: "item/tool/call",
          params: {
            threadId,
            turnId: "turn",
            callId: "call",
            tool: "github_pr_create",
            arguments: { requestId },
          },
        });
      }
    });
    // Trigger completion only after the held callback resolves, just like the native stream.
  });
  child.stdin.on("data", (bytes: Buffer) => {
    const message = JSON.parse(bytes.toString()) as { id?: number; method?: string };
    if (message.id === undefined || message.method !== undefined) return;
    queueMicrotask(() => {
      if (scenario === "closed-after-effect" && responses.length === 2) {
        child.emit("exit", 1);
        return;
      }
      if (childFirst && responses.length === 1) {
        emit({
          method: "item/started",
          params: {
            threadId: "native-main",
            turnId: "turn",
            item: { type: "dynamicToolCall", tool: "github_pr_create", id: "parent-call" },
          },
        });
        emit({
          id: 1,
          method: "item/tool/call",
          params: {
            threadId: "native-main",
            turnId: "turn",
            callId: "parent-call",
            tool: "github_pr_create",
            arguments: { requestId },
          },
        });
        if (scenario === "closed") child.emit("exit", 1);
      } else if (scenario === "replay" && responses.length === 2) {
        emit({
          id: 1,
          method: "item/tool/call",
          params: {
            threadId: "native-main",
            turnId: "turn",
            callId: "parent-call",
            tool: "github_pr_create",
            arguments: { requestId },
          },
        });
      } else {
        emit({
          method: "item/completed",
          params: {
            threadId:
              scenario === "wrong-context"
                ? "foreign"
                : scenario === "child-only"
                  ? "native-child"
                  : "native-main",
            turnId: "turn",
            item: {
              type: "dynamicToolCall",
              id: childFirst ? "parent-call" : "call",
              status: completionStatus,
              success: completionSuccess,
            },
          },
        });
        emit({
          method: "turn/completed",
          params: { threadId: "native-main", turn: { status: "completed" } },
        });
      }
    });
  });
  return child;
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-native-boundary-"));
  scenario = "child-relay";
  responses = [];
  completionStatus = "completed";
  completionSuccess = true;
  scopes = {
    pendingId: requestId,
    checkout: cwd,
    action: "github.pr.create",
    destination: "fixture",
    repository: "owner/repo",
    base: "main",
    head: "feat/test",
    localHead: "a".repeat(40),
    remoteBase: "b".repeat(40),
    remoteHead: "a".repeat(40),
    fingerprint: "c".repeat(64),
    title: "title",
    body: "body; $(cannot execute)",
    bodyDigest: "d".repeat(64),
    draft: true,
  };
  vi.clearAllMocks();
  mocks.isolation.mockReturnValue(true);
  mocks.spawn.mockImplementation(childDouble);
  mocks.spawnSync.mockReturnValue({ status: 0, stdout: "", stderr: "" });
  mocks.snapshot.mockReturnValue(scopes);
  mocks.revalidate.mockReturnValue(true);
  mocks.decision.mockResolvedValue("accept");
  mocks.root.mockReturnValue({
    cwd,
    dir: ".navori/state/handoffs",
    path: join(cwd, ".navori/state/handoffs"),
    kind: "explicit",
  });
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("fixed native publication boundary", () => {
  // Covers: R13, R16, R18
  it("fixed profile preflight never credits a returned kill without an owned exit acknowledgement", async () => {
    writeFileSync(
      join(cwd, "navori.config.json"),
      JSON.stringify({
        name: "fixture",
        preset: "custom",
        engines: ["codex"],
        harness: { codexIntegration: true },
      }),
    );
    const result = await preflightNativeProfileProbe(cwd);
    expect(result).toMatchObject({
      status: "pending",
      consumed: true,
      cleanup: "unverified",
      principalTurnsStarted: 0,
      childTurnsStarted: 0,
    });
    expect(result.pending).toContain("owned-process-exit-unacknowledged");
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(mocks.decision).not.toHaveBeenCalled();
  });
  // Covers: R6, R16
  it("keeps the direct production entry pending before native startup without source isolation", async () => {
    mocks.isolation.mockReturnValue(false);
    expect(await runNativeIntegration(cwd, requestId)).toMatchObject({
      status: "pending",
      reason: "human-source-isolation-unverified",
    });
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.snapshot).not.toHaveBeenCalled();
    expect(mocks.decision).not.toHaveBeenCalled();
    expect(mocks.spawnSync).not.toHaveBeenCalled();
  });
  // Covers: R6, R8
  it.each([false, null, "true", 1])(
    "keeps native completed with unsuccessful or malformed tool result %s uncertain",
    async (success: unknown) => {
      completionSuccess = success;
      expect((await runNativeIntegration(cwd, requestId)).status).toBe("uncertain");
      expect(mocks.spawnSync).toHaveBeenCalledTimes(1);
    },
  );
  // Covers: R6, R8
  it.each(["failed", "cancelled", "inProgress", "unknown", undefined, null, { forged: true }])(
    "keeps non-completed native status %s uncertain after the fixed effect",
    async (status: unknown) => {
      completionStatus = status;
      expect((await runNativeIntegration(cwd, requestId)).status).toBe("uncertain");
      expect(mocks.spawnSync).toHaveBeenCalledTimes(1);
      expect(
        JSON.parse(
          readFileSync(
            join(cwd, ".navori/state/handoffs", `approval_${requestId}.native-completion.json`),
            "utf8",
          ),
        ) as unknown,
      ).toMatchObject({ effectStatus: "completed", status: "uncertain" });
    },
  );
  // Covers: R6, R7
  it("rejects a parent-only action without an observed child pending origin", async () => {
    scenario = "valid";
    expect((await runNativeIntegration(cwd, requestId)).status).toBe("pending");
    expect(mocks.decision).not.toHaveBeenCalled();
    expect(mocks.spawnSync).not.toHaveBeenCalled();
  });
  // Covers: R6, R7, R16
  it("binds real child ID zero to the parent and burns before exact fixed gh argv without shell", async () => {
    const result = await runNativeIntegration(cwd, requestId);
    expect(result.status).toBe("completed");
    expect(mocks.decision).toHaveBeenCalledWith(
      {
        requestId: 1,
        threadId: "native-main",
        turnId: "turn",
        callId: "parent-call",
        action: "github.pr.create",
      },
      {
        ...scopes,
        nativeOrigin: {
          requestId: 0,
          threadId: "native-child",
          turnId: "turn",
          callId: "call",
          action: "github.pr.create",
        },
      },
      120_000,
      expect.any(AbortSignal),
    );
    expect(mocks.spawnSync).toHaveBeenCalledWith(
      "gh",
      [
        "pr",
        "create",
        "--repo",
        "owner/repo",
        "--base",
        "main",
        "--head",
        "feat/test",
        "--title",
        "title",
        "--body",
        "body; $(cannot execute)",
        "--draft",
      ],
      expect.objectContaining({ cwd, stdio: ["ignore", "pipe", "pipe"] }),
    );
    expect(
      readFileSync(
        join(cwd, ".navori/state/handoffs", `approval_${requestId}.native-attempt`),
        "utf8",
      ),
    ).toContain("burned-before-effect");
    expect(JSON.stringify(result)).not.toMatch(/credential|csrf|Bearer/);
  });
  // Covers: R6, R7
  it.each(["policy", "network", "mcp", "wrong-context", "missing-item", "bad-version"] as const)(
    "fails closed for %s without publication",
    async (failure) => {
      scenario = failure;
      expect((await runNativeIntegration(cwd, requestId)).status).toBe("pending");
      expect(mocks.decision).not.toHaveBeenCalled();
      expect(mocks.spawnSync).not.toHaveBeenCalled();
    },
  );
  // Covers: R6
  it.each(["decline", "pending"] as const)("does not execute on browser %s", async (decision) => {
    mocks.decision.mockResolvedValue(decision);
    expect((await runNativeIntegration(cwd, requestId)).status).toBe(
      decision === "decline" ? "declined" : "pending",
    );
    expect(mocks.spawnSync).not.toHaveBeenCalled();
  });
  // Covers: R6, R8
  it("invalidates changed reviewed scope immediately before the effect", async () => {
    mocks.revalidate.mockReturnValue(false);
    expect((await runNativeIntegration(cwd, requestId)).status).toBe("pending");
    expect(mocks.spawnSync).not.toHaveBeenCalled();
  });
  // Covers: R6
  it("rejects replay, duplicate callbacks and duplicate process consumption", async () => {
    scenario = "replay";
    expect((await runNativeIntegration(cwd, requestId)).status).toBe("completed");
    expect(mocks.decision).toHaveBeenCalledTimes(1);
    expect(mocks.spawnSync).toHaveBeenCalledTimes(1);
    scenario = "child-relay";
    responses = [];
    expect((await runNativeIntegration(cwd, requestId)).status).toBe("pending");
    expect(
      mocks.spawnSync.mock.calls.filter(
        (call: unknown[]) => Array.isArray(call[1]) && call[1][1] === "create",
      ),
    ).toHaveLength(1);
    expect(mocks.spawnSync).toHaveBeenLastCalledWith(
      "gh",
      expect.arrayContaining(["list", "--state", "all"]),
      expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
    );
  });
  // Covers: R6, R8
  it("records network/crash uncertainty without retrying the fixed effect", async () => {
    mocks.spawnSync.mockReturnValue({ status: 1, error: new Error("ambiguous network response") });
    expect((await runNativeIntegration(cwd, requestId)).status).toBe("uncertain");
    expect(mocks.spawnSync).toHaveBeenCalledTimes(1);
    expect(
      readFileSync(
        join(cwd, ".navori/state/handoffs", `approval_${requestId}.native-outcome.json`),
        "utf8",
      ),
    ).toContain("read-only-required; no retry");
  });
  // Covers: R6, R8
  it("closes the browser decision when native context ends before effect", async () => {
    scenario = "closed";
    expect((await runNativeIntegration(cwd, requestId)).status).toBe("pending");
    expect(mocks.spawnSync).not.toHaveBeenCalled();
    expect(mocks.decision).toHaveBeenCalledTimes(1);
    expect(mocks.decision.mock.calls[0]?.[3]).toMatchObject({ aborted: true });
  });
  // Covers: R6, R8
  it("keeps a closed native connection uncertain after the fixed effect", async () => {
    scenario = "closed-after-effect";
    expect((await runNativeIntegration(cwd, requestId)).status).toBe("uncertain");
    expect(mocks.spawnSync).toHaveBeenCalledTimes(1);
  });
  // Covers: R6, R16
  it("rechecks source isolation immediately before the fixed effect", async () => {
    mocks.decision.mockImplementation(async () => {
      mocks.isolation.mockReturnValue(false);
      return "accept";
    });
    expect((await runNativeIntegration(cwd, requestId)).status).toBe("pending");
    expect(mocks.spawnSync).not.toHaveBeenCalled();
  });
  // Covers: R6, R7
  it("returns child pending without promoting unobserved child policy into consent", async () => {
    scenario = "child-only";
    expect((await runNativeIntegration(cwd, requestId)).status).toBe("pending");
    expect(mocks.decision).not.toHaveBeenCalled();
    expect(mocks.spawnSync).not.toHaveBeenCalled();
  });
  // Covers: R6, R7
  it("requires a fresh native parent callback and keeps real child IDs in the one-use lineage", async () => {
    scenario = "child-relay";
    expect((await runNativeIntegration(cwd, requestId)).status).toBe("completed");
    expect(mocks.decision).toHaveBeenCalledTimes(1);
    expect(mocks.decision.mock.calls[0]?.[0]).toMatchObject({
      requestId: 1,
      threadId: "native-main",
      callId: "parent-call",
    });
    expect(mocks.decision.mock.calls[0]?.[1]).toMatchObject({
      nativeOrigin: { requestId: 0, threadId: "native-child", callId: "call" },
    });
    expect(
      readFileSync(
        join(cwd, ".navori/state/handoffs", `approval_${requestId}.native-completion.json`),
        "utf8",
      ),
    ).toContain("native-child");
  });
});
