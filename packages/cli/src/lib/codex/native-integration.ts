import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:http";
import {
  closeSync,
  openSync,
  writeSync,
  fsyncSync,
  ftruncateSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  copyFileSync,
  existsSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { readConfig } from "../config/config.ts";
import { join, dirname, relative, isAbsolute, delimiter } from "node:path";
import { projectCodexProfiles, type CodexProfileProjection } from "../assets/model-profile.ts";
import { getCoreRoot, readCliVersion } from "../render/bundled-assets.ts";
import { renderManagedFile } from "../../engines/shared/render-managed-file.ts";
import { extractManagedContent, removeManagedSection } from "../render/marker.ts";
import { codexHome } from "./home.ts";
import { codexHookHash, codexHookKey } from "./trust.ts";
import {
  codexHookCommand,
  type ResolvedCodexHook,
} from "../../engines/codex/hook-registrations.ts";
import { requestBrowserDecision, type NativeApprovalIdentity } from "./approval-controller.ts";
import { approvalSourceIsolationAvailable } from "./approval-ui.ts";
import { readProfileToolInventory, type ProfileToolInventory } from "./profile-tool-inventory.ts";
import {
  readNativeProfileView,
  nativeProfileCandidates,
  nativeProfileHookCalls,
  profileSelectionIntent,
  type NativeCatalogSnapshot,
  type NativeProfileCandidate,
} from "./host-observation.ts";
import {
  snapshotNativeApproval,
  revalidateNativeApproval,
  type NativeApprovalScope,
} from "./approval-route.ts";
import {
  ensureStateDirectory,
  resolveStateRoot,
  stateArtifactPath,
  writeStateFileAtomic,
} from "../primitives/state-root.ts";

const object = z.record(z.string(), z.unknown());
const messageSchema = z.object({
  id: z.union([z.string(), z.number().int()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});
const callbackSchema = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  callId: z.string().min(1),
  tool: z.literal("github_pr_create"),
  arguments: z.strictObject({ requestId: z.uuid() }),
});
const threadSchema = z.object({
  thread: z.object({ id: z.string().min(1) }),
  model: z.string().optional(),
  reasoningEffort: z.string().nullable().optional(),
  sandbox: z.object({ type: z.literal("readOnly"), networkAccess: z.literal(false) }),
  approvalPolicy: z.literal("never"),
  approvalsReviewer: z.literal("user"),
});
type RpcMessage = z.infer<typeof messageSchema>;
type RecordValue = Record<string, unknown>;
type PendingRpc = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type ProtocolBudget = {
  bytes: number;
  events: number;
  usedBytes: number;
  usedEvents: number;
  ledger?: { path: string; probe: string };
};
const protocolLedger = z.strictObject({
  probe: z.uuid(),
  bytes: z.number().int().nonnegative(),
  frames: z.number().int().nonnegative(),
});

/** A private metrics ledger enforces one aggregate budget across owned parent and hook catalog processes. */
function accountProtocol(
  budget: ProtocolBudget | undefined,
  bytes: number,
  frames: number,
): boolean {
  if (!budget) return true;
  if (!budget.ledger) {
    budget.usedBytes += bytes;
    budget.usedEvents += frames;
  } else {
    const { path, probe } = budget.ledger;
    let lock: number | undefined;
    try {
      // No retry: a concurrent/uncertain update fails closed rather than losing accounting.
      lock = openSync(`${path}.lock`, "wx", 0o600);
      if (realpathSync(path) !== path) return false;
      const value = protocolLedger.parse(JSON.parse(readFileSync(path, "utf8")) as unknown);
      if (value.probe !== probe) return false;
      value.bytes += bytes;
      value.frames += frames;
      writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
      budget.usedBytes = value.bytes;
      budget.usedEvents = value.frames;
    } catch {
      return false;
    } finally {
      if (lock !== undefined) {
        closeSync(lock);
        unlinkSync(`${path}.lock`);
      }
    }
  }
  return budget.usedBytes <= budget.bytes && budget.usedEvents <= budget.events;
}

/** Hook catalog children may account only to the owned private fixture ledger, never an arbitrary env path. */
function hookProtocolBudget(): ProtocolBudget | undefined {
  const probe = z.uuid().safeParse(process.env.NAVORI_CODEX_PROFILE_PROBE);
  if (!probe.success) return undefined;
  const root = process.env.NAVORI_CODEX_PROFILE_PROBE_ROOT;
  if (
    !root ||
    !root.startsWith(join(realpathSync(tmpdir()), "navori-profile-live-")) ||
    realpathSync(root) !== root ||
    (statSync(root).mode & 0o777) !== 0o700
  )
    throw new Error("owned-protocol-ledger-unverified");
  const path = join(root, "protocol-budget.json");
  const value = protocolLedger.parse(JSON.parse(readFileSync(path, "utf8")) as unknown);
  if (realpathSync(path) !== path || value.probe !== probe.data)
    throw new Error("owned-protocol-ledger-unverified");
  return {
    bytes: PROFILE_PROBE_BOUNDS.maxProtocolBytes,
    events: PROFILE_PROBE_BOUNDS.maxEvents,
    usedBytes: value.bytes,
    usedEvents: value.frames,
    ledger: { path, probe: probe.data },
  };
}

/** Diagnostics contain protocol types only, never prompts, credentials, bodies or raw stderr. */
export interface NativeIntegrationResult {
  readonly status: "pending" | "declined" | "completed" | "uncertain";
  readonly reason: string;
  readonly connection: string;
  readonly context?: string;
  readonly events: readonly string[];
}

const profileParentReport = z.strictObject({
  outcome: z.enum(["completed", "blocked"]),
  reason: z.enum([
    "none",
    "tool_unavailable",
    "role_unavailable",
    "workflow_prerequisite",
    "other",
  ]),
});
type ModelReportedProfileDiagnostic =
  | {
      source: "model-reported";
      status: "available";
      outcome: z.infer<typeof profileParentReport>["outcome"];
      reason: z.infer<typeof profileParentReport>["reason"];
    }
  | { source: "model-reported"; status: "unavailable" | "ambiguous" };

/** Parse only completed parent messages in the owned turn; model statements never attest native capability or selection. */
export function readModelReportedProfileDiagnostic(
  messages: readonly unknown[],
  principal: string,
  turn: string | null,
): ModelReportedProfileDiagnostic {
  const unavailable = { source: "model-reported", status: "unavailable" } as const;
  if (!turn) return unavailable;
  const completion = z.object({
    method: z.literal("item/completed"),
    params: z.object({
      threadId: z.literal(principal),
      turnId: z.literal(turn),
      item: z.object({
        type: z.literal("agentMessage"),
        text: z.string(),
        phase: z.literal("final_answer").nullish(),
      }),
    }),
  });
  const reports: z.infer<typeof profileParentReport>[] = [];
  let malformed = false;
  for (const message of messages) {
    const parsed = completion.safeParse(message);
    if (!parsed.success) continue;
    try {
      reports.push(profileParentReport.parse(JSON.parse(parsed.data.params.item.text) as unknown));
    } catch {
      malformed = true;
    }
  }
  if (!reports.length) return unavailable;
  if (
    malformed ||
    reports.some(
      (report) => report.outcome !== reports[0]!.outcome || report.reason !== reports[0]!.reason,
    )
  )
    return { source: "model-reported", status: "ambiguous" };
  return { source: "model-reported", status: "available", ...reports[0]! };
}

interface NativeProfilePhaseDiagnostic {
  modelReported: ModelReportedProfileDiagnostic;
  items: {
    collabAgentToolCall: number;
    subAgentActivity: number;
    agentMessage: number;
    other: number;
  };
  spawns: {
    attempted: number;
    completed: number;
    recognizedRoleReports: number;
    unknownRoleReports: number;
    missingIdentity: number;
  };
  activity: { missingIdentity: number; missingSelection: number };
  hooks: {
    runs: number;
    relevant: number;
    sourceMatched: number;
    completed: number;
    failed: number;
    running: number;
    blocked: number;
    stopped: number;
    failureStages: string[];
    otherStatus: number;
    missingIdentity: number;
    validContexts: number;
    contextEntries: number;
    missingContextRuns: number;
  };
  joinedCandidates: number;
}

/** Diagnostic counts only: never include arbitrary native text, IDs, role names, tool names or selection evidence. */
export function summarizeNativeProfilePhase(
  messages: readonly unknown[],
  roles: readonly string[],
  expected: {
    sourcePath: string;
    principal: string;
    joinedCandidates: number;
    validContexts: number;
    turn?: string | null;
  },
): NativeProfilePhaseDiagnostic {
  const summary: NativeProfilePhaseDiagnostic = {
    modelReported: readModelReportedProfileDiagnostic(
      messages,
      expected.principal,
      expected.turn ?? null,
    ),
    items: { collabAgentToolCall: 0, subAgentActivity: 0, agentMessage: 0, other: 0 },
    spawns: {
      attempted: 0,
      completed: 0,
      recognizedRoleReports: 0,
      unknownRoleReports: 0,
      missingIdentity: 0,
    },
    activity: { missingIdentity: 0, missingSelection: 0 },
    hooks: {
      runs: 0,
      relevant: 0,
      sourceMatched: 0,
      completed: 0,
      failed: 0,
      running: 0,
      blocked: 0,
      stopped: 0,
      failureStages: [],
      otherStatus: 0,
      missingIdentity: 0,
      validContexts: expected.validContexts,
      contextEntries: 0,
      missingContextRuns: 0,
    },
    joinedCandidates: expected.joinedCandidates,
  };
  const present = (value: unknown): boolean => typeof value === "string" && value.length > 0;
  for (const message of messages) {
    const event = object.safeParse(message).data;
    const params = object.safeParse(event?.params).data;
    if (!event || !params) continue;
    if (event.method === "thread/started") {
      const thread = object.safeParse(params.thread).data;
      if (thread && thread.id !== expected.principal) {
        if (typeof thread.agentRole === "string" && roles.includes(thread.agentRole))
          summary.spawns.recognizedRoleReports++;
        else summary.spawns.unknownRoleReports++;
      }
    }
    if (event.method === "item/started" || event.method === "item/completed") {
      const item = object.safeParse(params.item).data;
      if (!item) continue;
      if (
        item.type === "collabAgentToolCall" ||
        item.type === "subAgentActivity" ||
        item.type === "agentMessage"
      )
        summary.items[item.type]++;
      else summary.items.other++;
      if (item.type === "collabAgentToolCall" && item.tool === "spawnAgent") {
        if (event.method === "item/started") summary.spawns.attempted++;
        if (event.method === "item/completed" && item.status === "completed")
          summary.spawns.completed++;
        if (
          !present(item.id) ||
          !present(params.threadId) ||
          !present(item.senderThreadId) ||
          !Array.isArray(item.receiverThreadIds) ||
          !item.receiverThreadIds.length ||
          !item.receiverThreadIds.every(present)
        )
          summary.spawns.missingIdentity++;
      }
      if (item.type === "subAgentActivity") {
        if (!present(item.id) || !present(item.agentThreadId) || !present(item.agentPath))
          summary.activity.missingIdentity++;
        if (!present(item.model) || !present(item.reasoningEffort))
          summary.activity.missingSelection++;
      }
    }
    if (event.method === "hook/started" || event.method === "hook/completed") {
      const run = object.safeParse(params.run).data;
      summary.hooks.runs++;
      if (!run) {
        summary.hooks.missingIdentity++;
        continue;
      }
      if (run.eventName !== "preToolUse" || run.handlerType !== "command") continue;
      summary.hooks.relevant++;
      const contexts = Array.isArray(run.entries)
        ? run.entries.filter((entry: unknown) => object.safeParse(entry).data?.kind === "context")
            .length
        : 0;
      summary.hooks.contextEntries += contexts;
      if (event.method === "hook/completed" && !contexts) summary.hooks.missingContextRuns++;
      if (
        run.source === "project" &&
        run.sourcePath === expected.sourcePath &&
        params.threadId === expected.principal
      )
        summary.hooks.sourceMatched++;
      if (run.status === "completed") summary.hooks.completed++;
      else if (run.status === "failed") summary.hooks.failed++;
      else if (run.status === "running") summary.hooks.running++;
      else if (run.status === "blocked") summary.hooks.blocked++;
      else if (run.status === "stopped") summary.hooks.stopped++;
      else summary.hooks.otherStatus++;
      if (
        event.method === "hook/completed" &&
        run.source === "project" &&
        run.sourcePath === expected.sourcePath &&
        params.threadId === expected.principal &&
        Array.isArray(run.entries)
      ) {
        for (const entry of run.entries) {
          const text = object.safeParse(entry).data?.text;
          const stage =
            typeof text === "string"
              ? /\bprofile-hook-stage-(input|claim|role|catalog|selection|refresh|freshness)\b/.exec(
                  text,
                )?.[1]
              : undefined;
          if (stage && !summary.hooks.failureStages.includes(stage))
            summary.hooks.failureStages.push(stage);
        }
      }
      if (!present(run.id) || !present(params.threadId) || !present(run.sourcePath))
        summary.hooks.missingIdentity++;
    }
  }
  return summary;
}

/** Owned stdio transport with bounded messages and exact ID correlation (including ID zero). */
class NativeConnection {
  version = "0.162.1";
  readonly child: ChildProcessWithoutNullStreams;
  readonly events: string[] = [];
  private sequence = 0;
  private buffer = "";
  private closed = false;
  private readonly deadline?: number;
  private operationTimer?: ReturnType<typeof setTimeout>;
  private exitObserved = false;
  private readonly scopedProcessGroup: boolean;
  private exitAcknowledgement?: Promise<boolean>;
  private readonly requests = new Map<string | number, PendingRpc>();
  onMessage: (message: RpcMessage) => void = () => {};
  onClose: () => void = () => {};
  isOpen(): boolean {
    return !this.closed;
  }

  constructor(
    cwd: string,
    overrides: readonly string[],
    deadline?: number,
    private readonly limits?: ProtocolBudget,
    env?: NodeJS.ProcessEnv,
  ) {
    if (deadline !== undefined && Date.now() >= deadline)
      throw new Error("native-operation-timeout");
    this.deadline = deadline;
    this.scopedProcessGroup = env !== undefined;
    this.child = spawn(
      "codex",
      ["app-server", "--stdio", ...overrides.flatMap((value) => ["-c", value])],
      { cwd, stdio: "pipe", ...(env ? { env, detached: true } : {}) },
    );
    this.child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    this.child.stderr.on("data", () => {
      if (this.events.length < 256) this.events.push("native-stderr");
    });
    this.child.once("error", () => this.close());
    this.child.once("exit", () => {
      this.exitObserved = true;
      this.close();
    });
    if (deadline !== undefined)
      this.operationTimer = setTimeout(() => this.close(), Math.max(1, deadline - Date.now()));
  }

  /** Reject oversized/invalid protocol input without forwarding raw native payloads. */
  private receive(chunk: Buffer): void {
    if (!accountProtocol(this.limits, chunk.length, 0)) {
      this.close();
      return;
    }
    this.buffer += chunk.toString("utf8");
    if (Buffer.byteLength(this.buffer) > 1024 * 1024) {
      this.close();
      return;
    }
    let index: number;
    while ((index = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      let message: RpcMessage;
      try {
        message = messageSchema.parse(JSON.parse(line) as unknown);
      } catch {
        this.close();
        return;
      }
      if (!accountProtocol(this.limits, 0, 1)) {
        this.close();
        return;
      }
      if (message.id !== undefined && message.method === undefined) {
        const request = this.requests.get(message.id);
        if (request) {
          this.requests.delete(message.id);
          clearTimeout(request.timer);
          if (message.error !== undefined) request.reject(new Error("native-rpc-error"));
          else request.resolve(message.result);
        }
      } else {
        if (message.method && this.events.length < 256) this.events.push(message.method);
        this.onMessage(message);
      }
    }
  }

  /** Finite per-request deadlines; no retries or arbitrary command RPC is exposed. */
  rpc(method: string, params: RecordValue): Promise<unknown> {
    if (this.closed || Date.now() >= (this.deadline ?? Infinity)) {
      this.close();
      return Promise.reject(new Error("native-operation-timeout"));
    }
    const id = ++this.sequence;
    if (this.events.length < 256)
      this.events.push(`request:${method}:${id}:${Object.keys(params).join(",")}`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.requests.delete(id);
          reject(new Error("native-rpc-timeout"));
        },
        Math.min(15_000, Math.max(1, (this.deadline ?? Infinity) - Date.now())),
      );
      this.requests.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  send(message: RecordValue): void {
    const encoded = `${JSON.stringify(message)}\n`;
    if (!accountProtocol(this.limits, Buffer.byteLength(encoded), 1)) {
      this.close();
      return;
    }
    this.child.stdin.write(encoded);
  }
  /** Kill the owned process and reject every unresolved request on all terminal paths. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.operationTimer);
    if (this.scopedProcessGroup && this.child.pid) {
      try {
        process.kill(-this.child.pid, "SIGKILL");
      } catch {
        this.child.kill("SIGKILL");
      }
    } else this.child.kill(this.deadline === undefined ? "SIGTERM" : "SIGKILL");
    for (const request of this.requests.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("native-connection-closed"));
    }
    this.requests.clear();
    this.onClose();
  }

  /** A signal request is not cleanup evidence; wait for the owned process exit within the shared deadline. */
  async closeAcknowledged(deadline: number): Promise<boolean> {
    if (this.exitAcknowledgement) return this.exitAcknowledgement;
    this.close();
    if (this.exitObserved) return true;
    this.exitAcknowledgement = new Promise((resolve) => {
      const exit = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(
        () => {
          this.child.removeListener("exit", exit);
          resolve(false);
        },
        Math.max(1, Math.min(5_000, deadline - Date.now())),
      );
      this.child.once("exit", exit);
    });
    return this.exitAcknowledgement;
  }
}

/** Handshake must complete before subsequent messages; connections never attach to another session. */
async function initialize(connection: NativeConnection, profileOnly = false): Promise<void> {
  const response = z.object({ platformOs: z.literal("macos"), userAgent: z.string() }).parse(
    await connection.rpc("initialize", {
      clientInfo: { name: "navori_bounded_integration", version: "0.12.0" },
      capabilities: { experimentalApi: true },
    }),
  );
  // Ceiling: generic T6 remains 0.162.1; only the confined profile owner/hook catalog admits verified 0.163.0.
  const version = response.userAgent.match(/\/(0\.162\.1|0\.163\.0)(?:\s|$)/)?.[1];
  if (!version || (!profileOnly && version !== "0.162.1"))
    throw new Error("unverified-native-version");
  connection.version = version;
  connection.send({ method: "initialized" });
}

const nativeCatalogs = new WeakSet<NativeCatalogSnapshot>();

/** Accept only objects emitted by the owned native connection, never imported caller JSON. */
export function isOwnedNativeCatalog(value: NativeCatalogSnapshot): boolean {
  return nativeCatalogs.has(value);
}

/** Read a complete point-in-time native catalog without starting a thread, turn or effect. */
export async function queryNativeCatalog(
  cwd: string,
  deadline = Date.now() + 8_000,
): Promise<NativeCatalogSnapshot> {
  const budget = hookProtocolBudget();
  const inherited = z.coerce
    .number()
    .int()
    .positive()
    .safeParse(process.env.NAVORI_CODEX_PROFILE_PROBE_DEADLINE);
  const end = Math.min(
    deadline,
    Date.now() + 8_000,
    budget && inherited.success ? inherited.data : Infinity,
  );
  const connection = new NativeConnection(cwd, [], end, budget);
  let snapshot: NativeCatalogSnapshot;
  try {
    snapshot = await readConnectionCatalog(connection, cwd, "closed", false, Boolean(budget));
  } finally {
    if (budget) await connection.closeAcknowledged(end);
    else connection.close();
  }
  if (budget && !(await connection.closeAcknowledged(end)))
    throw new Error("hook-catalog-exit-unacknowledged");
  return snapshot;
}

/** Internal same-connection catalog query; only fixed native lifecycles can use the transport. */
async function readConnectionCatalog(
  connection: NativeConnection,
  cwd: string,
  lifecycle: NativeCatalogSnapshot["lifecycle"],
  initialized = false,
  profileOnly = false,
): Promise<NativeCatalogSnapshot> {
  const identity = randomUUID();
  const pageSchema = z.object({
    data: z.array(
      z.object({
        id: z.string().min(1),
        model: z.string().min(1),
        supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string().min(1) })),
      }),
    ),
    nextCursor: z.string().nullable().optional(),
  });
  try {
    if (!initialized) await initialize(connection, profileOnly);
    const queries: string[] = [];
    const models: NativeCatalogSnapshot["models"][number][] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      if (queries.length >= 100 || (cursor !== null && cursors.has(cursor)))
        throw new Error("native-catalog-pagination-incomplete");
      if (cursor !== null) cursors.add(cursor);
      const page = pageSchema.parse(await connection.rpc("model/list", { cursor, limit: 100 }));
      queries.push(
        connection.events
          .filter((event: string) => event.startsWith("request:model/list:"))
          .at(-1) ?? "unknown-query",
      );
      for (const row of page.data) {
        if (models.some((previous) => previous.model === row.model))
          throw new Error("native-catalog-duplicate-model");
        models.push(
          Object.freeze({
            id: row.id,
            model: row.model,
            efforts: Object.freeze(
              row.supportedReasoningEfforts.map((option) => option.reasoningEffort),
            ),
          }),
        );
      }
      cursor = page.nextCursor ?? null;
    } while (cursor !== null);
    if (!connection.isOpen() || models.length === 0) throw new Error("native-catalog-unavailable");
    const snapshot: NativeCatalogSnapshot = Object.freeze({
      source: "codex-app-server",
      checkout: cwd,
      version: connection.version,
      connection: identity,
      context: identity,
      checkedAt: new Date().toISOString(),
      queries: Object.freeze(queries),
      models: Object.freeze(models),
      lifecycle,
    });
    nativeCatalogs.add(snapshot);
    return snapshot;
  } catch {
    throw new Error("native-catalog-unavailable-or-incomplete");
  }
}

/** Transport-attested native context selection; absent children/catalog/roles remain pending. */
export interface NativeProfileObservation {
  readonly connection: string;
  readonly context: string;
  readonly catalog: NativeCatalogSnapshot;
  readonly tree: string;
  readonly inventory: string;
  readonly principal: {
    readonly requestedModel: string;
    readonly requestedEffort: string;
    readonly selectedModel: string | null;
    readonly selectedEffort: string | null;
  };
  readonly children: readonly NativeProfileCandidate[];
  readonly pending: readonly string[];
  readonly lifecycle: "closed";
}

const nativeObservations = new WeakSet<NativeProfileObservation>();

/** Copied, decoded or caller-edited objects cannot certify native observation. */
export function isOwnedNativeObservation(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    nativeObservations.has(value as NativeProfileObservation)
  );
}

/** Start only a new exact principal context; do not dispatch unrelated top-level child roles or turns. */
export async function observeNativeProfiles(cwd: string): Promise<NativeProfileObservation> {
  const root = resolveStateRoot({ cwd, feature: "codex-profile" });
  const config = readConfig(join(root.cwd, "navori.config.json"));
  if (!config.engines.includes("codex") || config.harness?.codexIntegration !== true)
    throw new Error("project-opt-in-required");
  const connection = new NativeConnection(root.cwd, []);
  try {
    const catalog = await readConnectionCatalog(connection, root.cwd, "open");
    const view = await readNativeProfileView(root.cwd, catalog);
    const principal = view.rows.find((row) => row.scope === "principal");
    const model = principal?.model.wouldRender;
    const effort = principal?.effort.wouldRender;
    const advertised = catalog.models.find((row) => row.model === model);
    if (
      !principal ||
      principal.diagnostics.length ||
      !model ||
      !effort ||
      !advertised?.efforts.includes(effort)
    )
      throw new Error("native-principal-pair-unsupported; human-decision-required");
    const messages: unknown[] = [];
    let overflow = false;
    connection.onMessage = (message: RpcMessage): void => {
      if (messages.length < 4096) messages.push(message);
      else overflow = true;
    };
    const started = threadSchema.parse(
      await connection.rpc("thread/start", {
        cwd: root.cwd,
        ephemeral: true,
        sandbox: "read-only",
        approvalPolicy: "never",
        approvalsReviewer: "user",
        model,
        config: { model_reasoning_effort: effort },
      }),
    );
    const children = Object.freeze(
      overflow ? [] : nativeProfileCandidates(view.rows, started.thread.id, messages),
    );
    const selected = !overflow && started.model === model && started.reasoningEffort === effort;
    const pending = view.rows
      .filter((row) =>
        row.scope === "principal"
          ? !selected
          : !children.some((child) => child.nativeName === row.nativeName),
      )
      .map((row) => row.nativeName);
    const observation: NativeProfileObservation = Object.freeze({
      connection: catalog.connection,
      context: started.thread.id,
      catalog,
      tree: view.tree,
      inventory: view.inventory,
      principal: Object.freeze({
        requestedModel: model,
        requestedEffort: effort,
        selectedModel: started.model ?? null,
        selectedEffort: started.reasoningEffort ?? null,
      }),
      children,
      pending: Object.freeze(pending),
      lifecycle: "closed",
    });
    nativeObservations.add(observation);
    return observation;
  } finally {
    connection.close();
  }
}

/** Fixed prospective scenario bounds; no hard token/dollar ceiling is supported or claimed. */
export const PROFILE_PROBE_BOUNDS = Object.freeze({
  wallTimeMs: 180_000,
  maxEnabledChildRoles: 12,
  principalTurns: 1,
  maxSuccessfulSpawnPerRole: 1,
  maxChildTurnsPerRole: 1,
  maxConcurrentChildren: 1,
  maxProtocolBytes: 2_097_152,
  maxEvents: 2_048,
  retries: 0,
});

/** Closed preflight diagnostics cannot authenticate a hook, loaded child, live selection or cleanup beyond this owner. */
export interface NativeProfileProbePreflight {
  readonly status: "pending";
  readonly scenario: "enabled-child-profile-creation-0.162.1";
  readonly bounds: typeof PROFILE_PROBE_BOUNDS;
  readonly checkout: string;
  readonly consumed: boolean;
  readonly principalTurnsStarted: 0;
  readonly childTurnsStarted: 0;
  readonly loadedConfinement: "verified-config-only" | "unverified";
  readonly cleanup: "acknowledged-owned-exit" | "unverified" | "not-started";
  readonly inventory?: string;
  readonly tree?: string;
  readonly configuration?: string;
  readonly roles: readonly string[];
  readonly pending: readonly string[];
}

/**
 * Consume one fixed checkout/scenario attempt, inspect only new owned native config/catalog, then refuse before inference.
 * Ceiling: native0.162.1 lacks the verified pre-effect whole-attempt and per-call hook source rule;
 * admit a turn only after a supported native control and independent reviewed source binding exist.
 */
export async function preflightNativeProfileProbe(
  cwd: string,
): Promise<NativeProfileProbePreflight> {
  const root = resolveStateRoot({ cwd, feature: "codex-profile" });
  const scenario = "enabled-child-profile-creation-0.162.1" as const;
  const deadline = Date.now() + PROFILE_PROBE_BOUNDS.wallTimeMs;
  const pending: string[] = [];
  let connection: NativeConnection | undefined;
  let attemptFd: number | undefined;
  let consumed = false;
  let loadedConfinement: NativeProfileProbePreflight["loadedConfinement"] = "unverified";
  let cleanup: NativeProfileProbePreflight["cleanup"] = "not-started";
  let inventory: string | undefined;
  let tree: string | undefined;
  let configuration: string | undefined;
  let roles: string[] = [];
  try {
    const config = readConfig(join(root.cwd, "navori.config.json"));
    if (!config.engines.includes("codex") || config.harness?.codexIntegration !== true)
      throw new Error("project-opt-in-required");
    ensureStateDirectory(root);
    const key = createHash("sha256")
      .update(JSON.stringify([root.cwd, scenario]))
      .digest("hex");
    attemptFd = openSync(stateArtifactPath(root, `profile-probe-${key}.json`), "wx", 0o600);
    consumed = true;
    writeSync(
      attemptFd,
      JSON.stringify({
        scenario,
        checkout: root.cwd,
        application: "pending",
        status: "consumed-uncertain",
        bounds: PROFILE_PROBE_BOUNDS,
      }),
    );
    fsyncSync(attemptFd);
    const limits = {
      bytes: PROFILE_PROBE_BOUNDS.maxProtocolBytes,
      events: PROFILE_PROBE_BOUNDS.maxEvents,
      usedBytes: 0,
      usedEvents: 0,
    };
    connection = new NativeConnection(
      root.cwd,
      ["features.plugins=false", "features.apps=false"],
      deadline,
      limits,
    );
    await initialize(connection);
    const initial = z
      .object({ config: object })
      .parse(await connection.rpc("config/read", { cwd: root.cwd, includeLayers: false }));
    const overrides = confinementOverrides(initial.config);
    if (!(await connection.closeAcknowledged(deadline)))
      throw new Error("owned-process-exit-unacknowledged");
    connection = new NativeConnection(root.cwd, overrides, deadline, limits);
    await initialize(connection);
    const policy = z
      .object({ config: object })
      .parse(await connection.rpc("config/read", { cwd: root.cwd, includeLayers: false }));
    if (!validPolicy(policy.config)) throw new Error("loaded-native-confinement-unverified");
    loadedConfinement = "verified-config-only";
    const catalog = await readConnectionCatalog(connection, root.cwd, "open", true);
    const view = await readNativeProfileView(root.cwd, catalog, deadline);
    inventory = view.inventory;
    tree = view.tree;
    configuration = view.configuration;
    roles = view.rows.filter((row) => row.scope === "subagent").map((row) => row.nativeName);
    ftruncateSync(attemptFd, 0);
    writeSync(
      attemptFd,
      JSON.stringify({
        scenario,
        checkout: root.cwd,
        tree,
        configuration,
        inventory,
        catalog: {
          context: catalog.context,
          queries: catalog.queries,
          checkedAt: catalog.checkedAt,
        },
        roles,
        application: "pending",
        status: "consumed-uncertain",
        bounds: PROFILE_PROBE_BOUNDS,
      }),
      0,
      "utf8",
    );
    fsyncSync(attemptFd);
    if (roles.length === 0 || roles.length > PROFILE_PROBE_BOUNDS.maxEnabledChildRoles)
      throw new Error("enabled-role-count-outside-fixed-probe-bounds");
    for (const row of view.rows) {
      const model = row.model.wouldRender ?? (row.origin === "local" ? row.rendered?.model : null);
      const effort =
        row.effort.wouldRender ?? (row.origin === "local" ? row.rendered?.effort : null);
      if (
        row.diagnostics.length ||
        !model ||
        !effort ||
        !catalog.models.some((entry) => entry.model === model && entry.efforts.includes(effort))
      )
        throw new Error("current-role-pair-unsupported-ambiguous-or-missing");
    }
    // Expected gaps, not invented capabilities: normal hooks fail open and native HookRunSummary has no tool_use_id.
    pending.push(
      "native-pre-effect-whole-attempt-role-turn-rule-unavailable",
      "native-hook-run-per-call-source-correlation-unavailable",
      "normal-hook-trust-and-shell-tool-confinement-unverified",
      "loaded-child-residency-and-inherited-policy-unverified",
    );
    // No thread/start, turn/start, thread/read, arbitrary command, prompt or permission response exists in this route.
  } catch (error) {
    const known = [
      "project-opt-in-required",
      "owned-process-exit-unacknowledged",
      "loaded-native-confinement-unverified",
      "enabled-role-count-outside-fixed-probe-bounds",
      "current-role-pair-unsupported-ambiguous-or-missing",
      "unverified-native-version",
      "native-catalog-unavailable-or-incomplete",
      "unsupported-native-config-key",
      "native-profile-inputs-changed",
    ];
    pending.push(
      error instanceof Error && known.includes(error.message)
        ? error.message
        : !consumed && error instanceof Error && "code" in error && error.code === "EEXIST"
          ? "fixed-probe-attempt-already-consumed"
          : "fixed-probe-preflight-unavailable",
    );
  } finally {
    if (connection)
      cleanup = (await connection.closeAcknowledged(deadline))
        ? "acknowledged-owned-exit"
        : "unverified";
    if (cleanup === "unverified") pending.push("owned-process-exit-unacknowledged");
    if (attemptFd !== undefined) closeSync(attemptFd);
  }
  return Object.freeze({
    status: "pending",
    scenario,
    bounds: PROFILE_PROBE_BOUNDS,
    checkout: root.cwd,
    consumed,
    principalTurnsStarted: 0,
    childTurnsStarted: 0,
    loadedConfinement,
    cleanup,
    inventory,
    tree,
    configuration,
    roles: Object.freeze(roles),
    pending: Object.freeze(pending),
  });
}

const LIVE_PROFILE_SCENARIO = "target-snapshot-profile-dispatch-refresh-v1-v2-autoattach";
const LIVE_RESTRICTIONS = [
  "shell_tool",
  "apps",
  "plugins",
  "browser_use",
  "computer_use",
  "memories",
  "request_permissions_tool",
  "image_generation",
  "skill_mcp_dependency_install",
  "remote_plugin",
  "worktrees",
] as const;

/** Current target snapshot exercised only in an opted-in disposable checkout, never the caller's session. */
export interface NativeLiveProfileProbe {
  readonly status: "completed" | "pending";
  readonly scenario: typeof LIVE_PROFILE_SCENARIO;
  readonly target: string;
  readonly targetIntegration: boolean;
  readonly execution?: string;
  readonly identity?: string;
  readonly consumed: boolean;
  readonly principalTurnRequests: number;
  readonly principal?: {
    readonly context: string;
    readonly model: string;
    readonly effort: string;
  };
  readonly children: readonly NativeProfileCandidate[];
  readonly refresh: "verified" | "pending";
  readonly refreshChild?: NativeProfileCandidate;
  readonly events: readonly string[];
  readonly diagnostics: readonly NativeProfilePhaseDiagnostic[];
  readonly toolInventory?: ProfileToolInventory;
  readonly cleanup: "acknowledged" | "unverified" | "not-started";
  readonly bounds: typeof PROFILE_PROBE_BOUNDS;
  readonly protocol: { bytes: number; frames: number };
  readonly phases: {
    readonly baselinePrincipalTurns: number;
    readonly refreshPrincipalTurns: 1;
    readonly extraRefreshDispatches: 1;
  };
  readonly pending: readonly string[];
}

/** Bind only relevant current target/implementation inputs; report/spec prose and fixture names are not inputs. */
function liveProfileSnapshot(cwd: string): {
  identity: string;
  rows: CodexProfileProjection[];
  paths: string[];
} {
  const config = readConfig(join(cwd, "navori.config.json"));
  if (!config.engines.includes("codex")) throw new Error("codex-engine-required");
  const rows = projectCodexProfiles(cwd, config, { catalogPath: null });
  const roleFile = z.strictObject({
    name: z.string().min(1),
    description: z.string(),
    developer_instructions: z.string(),
    model: z.string().min(1).optional(),
    model_reasoning_effort: z.string().min(1).optional(),
  });
  for (const row of rows.filter((entry) => entry.scope === "subagent")) {
    const parsed = roleFile.safeParse(parseToml(readFileSync(join(cwd, row.path), "utf8")));
    if (!parsed.success || parsed.data.name !== row.nativeName)
      throw new Error("native-role-overrides-or-instructions-unverified");
  }
  const expectedHook = renderManagedFile({
    assetPath: join(getCoreRoot(), "core-assets/hooks/model-advisor.sh"),
    existingContent: null,
    managedId: "model-advisor-base",
    meta: { source: "@navori/core", version: readCliVersion() },
    config,
    engine: "codex",
  }).content;
  const actualHook = readFileSync(join(cwd, ".codex/hooks/model-advisor.sh"), "utf8");
  if (
    extractManagedContent(actualHook, "model-advisor-base", "shell") !==
      extractManagedContent(expectedHook, "model-advisor-base", "shell") ||
    removeManagedSection(actualHook, "model-advisor-base", "shell").trim() !==
      removeManagedSection(expectedHook, "model-advisor-base", "shell").trim()
  )
    throw new Error("native-profile-hook-source-not-current");
  const paths = [
    ...new Set([
      "navori.config.json",
      ".codex/hooks/model-advisor.sh",
      ...rows.map((row) => row.path),
      ...(existsSync(join(cwd, "AGENTS.md")) ? ["AGENTS.md"] : []),
    ]),
  ].sort();
  const hash = createHash("sha256").update(JSON.stringify([cwd, LIVE_PROFILE_SCENARIO]));
  for (const path of paths) {
    const absolute = realpathSync(join(cwd, path));
    const rel = relative(cwd, absolute);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith("../"))
      throw new Error("profile-input-escapes-target");
    hash.update(path).update(readFileSync(absolute));
  }
  const implementation = new Set([fileURLToPath(import.meta.url)]);
  if (import.meta.url.endsWith(".ts"))
    for (const path of [
      "host-observation.ts",
      "profile-dispatch.ts",
      "profile-tool-inventory.ts",
      "../../commands/codex-profile.ts",
    ])
      implementation.add(fileURLToPath(new URL(path, import.meta.url)));
  for (const path of implementation) hash.update(path).update(readFileSync(path));
  return { identity: hash.digest("hex"), rows, paths };
}

/** Only recognized loaded features establish restriction support; arbitrary config echoes do not. */
async function verifyLiveProfileAdmission(
  connection: NativeConnection,
  cwd: string,
  hook: { command: string; hash: string; sourcePath: string },
  v2: boolean,
): Promise<void> {
  const features = z
    .object({
      data: z.array(z.object({ name: z.string(), enabled: z.boolean(), stage: z.string() })),
      nextCursor: z.null().optional(),
    })
    .parse(await connection.rpc("experimentalFeature/list", { limit: 200 }));
  if (
    LIVE_RESTRICTIONS.some(
      (name) =>
        !features.data.some(
          (entry) =>
            entry.name === name &&
            entry.enabled === false &&
            !["removed", "deprecated"].includes(entry.stage),
        ),
    )
  )
    throw new Error("recognized-native-restrictions-unverified");
  if (
    !["hooks", "multi_agent"].every((name) =>
      features.data.some(
        (entry) => entry.name === name && entry.enabled && entry.stage === "stable",
      ),
    )
  )
    throw new Error("recognized-native-dispatch-unverified");
  const policy = z
    .object({ config: object })
    .parse(await connection.rpc("config/read", { cwd, includeLayers: false })).config;
  const loaded = object.parse(policy.features);
  if (v2 && policy.thread_unload_delay_secs !== 2)
    throw new Error("loaded-native-unload-delay-unverified");
  const defaults = object.safeParse(policy.agents).data;
  if (defaults?.enabled !== true) throw new Error("loaded-native-agents-enabled-unverified");
  const nativeDefaults = z.strictObject({
    enabled: z.literal(true),
    max_concurrent_threads_per_session: z.int().nonnegative().nullish(),
    max_depth: z.int().nonnegative().nullish(),
    default_subagent_model: z.null().optional(),
    default_subagent_reasoning_effort: z.null().optional(),
    job_max_runtime_seconds: z.int().nonnegative().nullish(),
    interrupt_message: z.boolean().nullish(),
  });
  if (!nativeDefaults.safeParse(defaults).success)
    throw new Error("native-default-inheritance-unverified");
  if (
    policy.sandbox_mode !== "read-only" ||
    policy.approval_policy !== "never" ||
    policy.web_search !== "disabled" ||
    LIVE_RESTRICTIONS.some((name) => loaded[name] !== false) ||
    Object.keys(object.parse(policy.mcp_servers ?? {})).length !== 0
  )
    throw new Error("loaded-native-restrictions-unverified");
  const hooks = z
    .object({
      data: z.array(
        z.object({
          cwd: z.string(),
          errors: z.array(z.unknown()),
          warnings: z.array(z.string()),
          hooks: z.array(
            z.object({
              enabled: z.boolean(),
              trustStatus: z.string(),
              source: z.string(),
              sourcePath: z.string(),
              currentHash: z.string(),
              eventName: z.string(),
              handlerType: z.string(),
              command: z.string().optional(),
            }),
          ),
        }),
      ),
    })
    .parse(await connection.rpc("hooks/list", { cwds: [cwd] }));
  const entry = hooks.data.length === 1 ? hooks.data[0] : undefined;
  const actual = entry?.hooks.length === 1 ? entry.hooks[0] : undefined;
  if (
    entry?.cwd !== cwd ||
    entry.errors.length ||
    entry.warnings.length ||
    !actual ||
    !actual.enabled ||
    actual.trustStatus !== "trusted" ||
    actual.source !== "project" ||
    actual.sourcePath !== hook.sourcePath ||
    actual.currentHash !== hook.hash ||
    actual.command !== hook.command ||
    actual.eventName !== "preToolUse" ||
    actual.handlerType !== "command"
  )
    throw new Error("exact-native-hook-registration-unverified");
}

/** Drive only one fixed no-effect turn; any foreign tool/request, extra spawn or missing completion fails closed. */
async function runProfileProbePhase(
  connection: NativeConnection,
  principal: string,
  roles: readonly string[],
  deadline: number,
  observe: (messages: readonly unknown[], turn: string | null) => void,
  v2 = false,
): Promise<unknown[]> {
  const messages: unknown[] = [];
  let turn: string | null = null;
  let failed = false;
  let finish: (error?: Error) => void = () => {};
  const completed = new Promise<void>((resolve, reject) => {
    finish = (error?: Error): void => {
      if (error) {
        failed = true;
        reject(error);
      } else if (!failed) resolve();
    };
  });
  void completed.catch(() => {});
  const timer = setTimeout(
    () => finish(new Error("native-profile-phase-timeout")),
    Math.max(1, deadline - Date.now()),
  );
  const spawns = new Set<string>();
  const active = new Set<string>();
  const receivers = new Map<string, string>();
  const childTurns = new Map<string, string>();
  const terminalChildren = new Set<string>();
  const waitCalls = new Set<string>();
  let pendingWait: string | undefined;
  let parentTerminal: string | undefined;
  let unsubscribeRequested = false;
  let unsubscribeAcknowledged = false;
  let childClosed = false;
  let activityTurn: string | undefined;
  let activitySnapshot: string | undefined;
  const activityIdentity = (params: RecordValue): string => {
    const item = object.parse(params.item);
    // Native start/completion envelopes carry different lifecycle timestamps.
    return JSON.stringify([
      params.threadId,
      params.turnId,
      item.type,
      item.id,
      item.kind,
      item.agentThreadId,
      item.agentPath,
      item.model,
      item.reasoningEffort,
    ]);
  };
  const completeV2 = (): void => {
    if (unsubscribeAcknowledged && childClosed) finish();
  };
  /** Only the proven idle child may be unsubscribed; native eviction acknowledgement completes the phase. */
  const closeV2 = (): void => {
    if (!v2 || failed || !turn || parentTerminal !== turn) return;
    if (pendingWait) {
      finish(new Error("unexpected-native-child-turn-or-control"));
      return;
    }
    if (!receivers.size) {
      finish(new Error("native-profile-dispatch-missing"));
      return;
    }
    if (activityTurn !== turn || receivers.size !== 1 || unsubscribeRequested) return;
    const child = [...receivers.keys()][0]!;
    if (!terminalChildren.has(child)) return;
    unsubscribeRequested = true;
    void connection
      .rpc("thread/unsubscribe", { threadId: child })
      .then((response: unknown) => {
        if (!z.object({ status: z.literal("unsubscribed") }).safeParse(response).success)
          throw new Error("native-child-unsubscribe-unverified");
        unsubscribeAcknowledged = true;
        completeV2();
      })
      .catch((error: unknown) =>
        finish(error instanceof Error ? error : new Error("native-child-unsubscribe-unverified")),
      );
  };
  connection.onClose = (): void => finish(new Error("native-profile-connection-closed"));
  connection.onMessage = (message: RpcMessage): void => {
    messages.push(message);
    if (failed) return;
    if (message.id !== undefined && message.method !== undefined) {
      connection.send({
        id: message.id,
        error: { code: -32601, message: "Fixed profile probe denies effects" },
      });
      finish(new Error("unexpected-native-effect-request"));
      return;
    }
    const params = object.safeParse(message.params);
    if (!params.success) return;
    const item = object.safeParse(params.data.item);
    if (v2 && item.success && item.data.type === "collabAgentToolCall") {
      const value = item.data;
      const states = object.safeParse(value.agentsStates);
      // V2 wait_agent observes the mailbox; its native receivers/states are empty.
      if (
        value.tool !== "wait" ||
        params.data.threadId !== principal ||
        params.data.turnId !== activityTurn ||
        value.senderThreadId !== principal ||
        receivers.size !== 1 ||
        unsubscribeRequested ||
        typeof value.id !== "string" ||
        !value.id ||
        !Array.isArray(value.receiverThreadIds) ||
        value.receiverThreadIds.length !== 0 ||
        !states.success ||
        Object.keys(states.data).length !== 0 ||
        value.prompt != null ||
        value.model != null ||
        value.reasoningEffort != null
      ) {
        finish(new Error("unexpected-native-child-turn-or-control"));
        return;
      }
      if (
        message.method === "item/started" &&
        value.status === "inProgress" &&
        !pendingWait &&
        !waitCalls.has(value.id)
      ) {
        waitCalls.add(value.id);
        pendingWait = value.id;
      } else if (
        message.method === "item/completed" &&
        value.status === "completed" &&
        pendingWait === value.id
      ) {
        pendingWait = undefined;
      } else finish(new Error("unexpected-native-child-turn-or-control"));
      return;
    }
    if (
      v2 &&
      item.success &&
      item.data.type === "subAgentActivity" &&
      item.data.kind !== "started"
    ) {
      // Native kinds are started/interacted/interrupted/completed; only no-input completion is permitted.
      if (
        item.data.kind !== "completed" ||
        params.data.threadId !== principal ||
        params.data.turnId !== activityTurn ||
        !receivers.has(String(item.data.agentThreadId)) ||
        item.data.model != null ||
        item.data.reasoningEffort != null
      )
        finish(new Error("unexpected-native-child-turn-or-control"));
    }
    if (
      v2 &&
      item.success &&
      item.data.type === "subAgentActivity" &&
      item.data.kind === "started"
    ) {
      const value = item.data;
      if (message.method === "item/completed") {
        if (activitySnapshot !== activityIdentity(params.data))
          finish(new Error("native-profile-activity-conflict"));
      } else if (
        message.method !== "item/started" ||
        params.data.threadId !== principal ||
        typeof params.data.turnId !== "string" ||
        typeof value.id !== "string" ||
        typeof value.agentThreadId !== "string" ||
        receivers.size ||
        spawns.has(value.id)
      ) {
        finish(new Error("unexpected-native-profile-dispatch"));
        return;
      } else {
        activityTurn = params.data.turnId;
        activitySnapshot = activityIdentity(params.data);
        spawns.add(value.id);
        receivers.set(value.agentThreadId, value.id);
        closeV2();
      }
    }
    if (v2 && (message.method === "turn/started" || message.method === "turn/completed")) {
      const nativeTurn = z
        .object({ id: z.string().min(1), status: z.string().optional() })
        .safeParse(params.data.turn);
      if (!nativeTurn.success || typeof params.data.threadId !== "string") {
        finish(new Error("native-profile-turn-identity-unverified"));
        return;
      }
      const context = params.data.threadId;
      if (context === principal) {
        if (message.method === "turn/completed") {
          if (nativeTurn.data.status !== "completed")
            finish(new Error("native-profile-turn-incomplete"));
          else parentTerminal = nativeTurn.data.id;
        }
      } else if (message.method === "turn/started") {
        if (childTurns.has(context)) finish(new Error("unexpected-native-child-turn-or-control"));
        childTurns.set(context, nativeTurn.data.id);
      } else if (
        nativeTurn.data.status !== "completed" ||
        childTurns.get(context) !== nativeTurn.data.id ||
        terminalChildren.has(context)
      ) {
        finish(new Error("native-child-terminal-unverified"));
      } else terminalChildren.add(context);
      if (
        childTurns.size > 1 ||
        (receivers.size && [...childTurns.keys()].some((id) => !receivers.has(id)))
      )
        finish(new Error("unexpected-native-child-turn-or-control"));
      closeV2();
    }
    if (v2 && message.method === "thread/closed") {
      if (!unsubscribeRequested || !receivers.has(String(params.data.threadId)) || childClosed)
        finish(new Error("native-child-shutdown-unverified"));
      else {
        childClosed = true;
        completeV2();
      }
    }
    if (item.success && message.method === "item/started") {
      const value = item.data;
      if (
        value.type === "collabAgentToolCall" &&
        value.tool === "spawnAgent" &&
        typeof value.id === "string"
      ) {
        spawns.add(value.id);
        active.add(value.id);
        if (
          params.data.threadId !== principal ||
          spawns.size > roles.length ||
          active.size > PROFILE_PROBE_BOUNDS.maxConcurrentChildren
        )
          finish(new Error("unexpected-native-profile-dispatch"));
      } else if (
        value.type === "collabAgentToolCall" &&
        !["wait", "closeAgent", "listAgents"].includes(String(value.tool))
      ) {
        finish(new Error("unexpected-native-child-turn-or-control"));
      } else if (
        [
          "commandExecution",
          "fileChange",
          "mcpToolCall",
          "dynamicToolCall",
          "webSearch",
          "imageGeneration",
        ].includes(String(value.type))
      )
        finish(new Error("unexpected-native-effect-attempt"));
    }
    if (
      item.success &&
      message.method === "item/completed" &&
      item.data.type === "collabAgentToolCall"
    ) {
      const value = item.data;
      if (params.data.threadId !== principal) finish(new Error("unexpected-native-child-control"));
      if (
        value.tool === "spawnAgent" &&
        value.status === "completed" &&
        typeof value.id === "string" &&
        Array.isArray(value.receiverThreadIds)
      )
        for (const context of value.receiverThreadIds)
          if (typeof context === "string") receivers.set(context, value.id);
      if (value.tool === "closeAgent" && value.status === "completed") {
        const states = object.safeParse(value.agentsStates);
        if (states.success)
          for (const [context, state] of Object.entries(states.data))
            if (object.safeParse(state).data?.status === "shutdown")
              active.delete(receivers.get(context) ?? "");
      }
    }
    if (!v2 && message.method === "turn/completed" && params.data.threadId === principal) {
      const turn = z.object({ status: z.literal("completed") }).safeParse(params.data.turn);
      finish(turn.success ? undefined : new Error("native-profile-turn-incomplete"));
    }
  };
  try {
    const started = await connection.rpc("turn/start", {
      threadId: principal,
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["outcome", "reason"],
        properties: {
          outcome: { type: "string", enum: ["completed", "blocked"] },
          reason: {
            type: "string",
            enum: [
              "none",
              "tool_unavailable",
              "role_unavailable",
              "workflow_prerequisite",
              "other",
            ],
          },
        },
      },
      input: [
        {
          type: "text",
          text: `This is the fixed native profile diagnostic. Sequentially spawn exactly one native child of each exact agent_type in ${JSON.stringify(roles)}. Preserve each role's configured instructions and profile: do not override model or effort in the spawn. Give each child only this no-effect task: reply PROFILE_PROBE_OK and do not use tools or delegate. ${v2 ? "Use the native spawn_agent with agent_type, a unique task_name, and fork_turns set to none: this ephemeral diagnostic parent has no durable history to fork. Wait for this sole child to finish, then finish your turn; the host owns child shutdown. Do not send messages, followups, interrupts, or other control calls." : "Wait for each child to finish and close it with close_agent before starting the next."} Do not create other children, resume children, use shell, edit files, browse, or request permissions. Return only the final JSON report required by outputSchema: outcome completed with reason none if you executed this exact scenario; otherwise outcome blocked with reason tool_unavailable, role_unavailable, workflow_prerequisite or other. This report is your diagnostic statement only; do not include explanations, tool names, role names or other text.`,
        },
      ],
    });
    turn = z.object({ turn: z.object({ id: z.string().min(1) }) }).parse(started).turn.id;
    if (v2) closeV2();
    await completed;
    return messages;
  } finally {
    observe(messages, turn);
    clearTimeout(timer);
    connection.onMessage = (): void => {};
    connection.onClose = (): void => {};
  }
}

/** Require native shutdown per exact child; an app-server signal alone never proves child cleanup. */
function nativeProfileChildrenClosed(
  messages: readonly unknown[],
  children: readonly NativeProfileCandidate[],
): boolean {
  const closed = new Set<string>();
  const schema = z.object({
    method: z.literal("item/completed"),
    params: z.object({
      threadId: z.string(),
      item: z.object({
        type: z.literal("collabAgentToolCall"),
        tool: z.literal("closeAgent"),
        status: z.literal("completed"),
        senderThreadId: z.string(),
        receiverThreadIds: z.array(z.string()),
        agentsStates: z.record(z.string(), z.object({ status: z.literal("shutdown") })),
      }),
    }),
  });
  for (const message of messages) {
    const parsed = schema.safeParse(message);
    if (parsed.success) {
      const { threadId, item } = parsed.data.params;
      if (threadId !== item.senderThreadId) continue;
      for (const context of Object.keys(item.agentsStates))
        if (
          item.receiverThreadIds.includes(context) &&
          children.some((child) => child.context === context && child.parent === threadId)
        )
          closed.add(context);
    }
  }
  return children.every((child) => closed.has(child.context));
}

/**
 * One authorized target snapshot, isolated native fixture and named refresh subphase. Missing admission/evidence stays pending.
 * Operational bounds detect excess dispatch/output; no hard inference-token or pre-effect model-turn cap is claimed.
 */
export async function runNativeProfileProbe(
  cwd: string,
  options: { readonly captureToolInventory?: boolean } = {},
): Promise<NativeLiveProfileProbe> {
  const root = resolveStateRoot({ cwd, feature: "codex-profile" });
  const deadline = Date.now() + PROFILE_PROBE_BOUNDS.wallTimeMs;
  const operationDeadline = deadline - 10_000;
  const limits: ProtocolBudget = {
    bytes: PROFILE_PROBE_BOUNDS.maxProtocolBytes,
    events: PROFILE_PROBE_BOUNDS.maxEvents,
    usedBytes: 0,
    usedEvents: 0,
  };
  const pending: string[] = [];
  let consumed = false;
  let temporary: string | undefined;
  let traceDirectory: string | undefined;
  let toolInventory: ProfileToolInventory | undefined;
  const observedTurns: string[] = [];
  let execution: string | undefined;
  let identity: string | undefined;
  let connection: NativeConnection | undefined;
  let cleanup: NativeLiveProfileProbe["cleanup"] = "not-started";
  let refresh: NativeLiveProfileProbe["refresh"] = "pending";
  let targetIntegration = false;
  let principalTurnRequests = 0;
  let baselinePrincipalTurns = 1;
  let v2 = false;
  let principalSelection: NativeLiveProfileProbe["principal"];
  let refreshChild: NativeProfileCandidate | undefined;
  let allPhasesClosed = true;
  const children: NativeProfileCandidate[] = [];
  const diagnostics: NativeProfilePhaseDiagnostic[] = [];
  try {
    const snapshot = liveProfileSnapshot(root.cwd);
    identity = snapshot.identity;
    const config = readConfig(join(root.cwd, "navori.config.json"));
    targetIntegration = config.harness?.codexIntegration === true;
    const roles = snapshot.rows.filter((row) => row.scope === "subagent");
    if (!roles.length || roles.length > PROFILE_PROBE_BOUNDS.maxEnabledChildRoles)
      throw new Error("enabled-role-count-outside-fixed-probe-bounds");
    for (const row of snapshot.rows) {
      const intent = profileSelectionIntent(row);
      if (
        row.scope === "principal" &&
        (intent.model.kind !== "set" || intent.effort.kind !== "set")
      )
        throw new Error("current-principal-pair-missing");
    }
    ensureStateDirectory(root);
    const fd = openSync(
      stateArtifactPath(root, `profile-probe-live-${identity}.json`),
      "wx",
      0o600,
    );
    consumed = true;
    try {
      writeSync(
        fd,
        JSON.stringify({
          scenario: LIVE_PROFILE_SCENARIO,
          target: root.cwd,
          identity,
          status: "consumed-uncertain",
        }),
      );
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    temporary = realpathSync(mkdtempSync(join(tmpdir(), "navori-profile-live-")));
    const probe = randomUUID();
    const ledgerPath = join(temporary, "protocol-budget.json");
    writeFileSync(ledgerPath, JSON.stringify({ probe, bytes: 0, frames: 0 }), { mode: 0o600 });
    limits.ledger = { path: ledgerPath, probe };
    execution = join(temporary, "checkout");
    const home = join(temporary, "codex-home");
    const bin = join(temporary, "bin");
    for (const path of [execution, home, bin]) mkdirSync(path, { mode: 0o700 });
    if (options.captureToolInventory) {
      traceDirectory = join(home, "private-request-traces");
      mkdirSync(traceDirectory, { mode: 0o700 });
    }
    for (const path of snapshot.paths) {
      mkdirSync(dirname(join(execution, path)), { recursive: true });
      copyFileSync(join(root.cwd, path), join(execution, path));
    }
    writeFileSync(
      join(execution, "navori.config.json"),
      JSON.stringify({ ...config, harness: { ...config.harness, codexIntegration: true } }),
    );
    const nativePath = join(execution, ".codex/config.toml");
    const original = readFileSync(nativePath, "utf8");
    const nativeConfig = parseToml(original);
    if (
      Object.keys(nativeConfig).some(
        (key) =>
          ![
            "sandbox_mode",
            "approval_policy",
            "approvals_reviewer",
            "model",
            "model_reasoning_effort",
            "features",
            "hooks",
            "project_doc_max_bytes",
            "developer_instructions",
            "mcp_servers",
          ].includes(key),
      )
    )
      throw new Error("native-principal-overrides-unverified");
    delete nativeConfig.hooks;
    delete nativeConfig.mcp_servers;
    const hook: ResolvedCodexHook = {
      script: "model-advisor",
      event: "PreToolUse",
      matcher: "^(Agent|spawn_agent|collaborationspawn_agent)$",
      args: "codex-pretool-profile",
      timeout: 15,
      statusMessage: "navori: future child profile",
    };
    const command = codexHookCommand(hook);
    const hash = codexHookHash(hook, command);
    nativeConfig.hooks = {
      PreToolUse: [
        {
          matcher: hook.matcher!,
          hooks: [
            { type: "command", command, timeout: hook.timeout, statusMessage: hook.statusMessage! },
          ],
        },
      ],
    };
    const start = original.match(/^# navori:managed start id="codex-config-base".*$/m)?.[0];
    const end = original.match(/^# navori:managed end id="codex-config-base".*$/m)?.[0];
    if (!start || !end) throw new Error("target-native-config-ownership-unverified");
    writeFileSync(nativePath, `${start}\n${stringifyToml(nativeConfig)}\n${end}\n`);
    writeFileSync(
      join(home, "config.toml"),
      stringifyToml({
        thread_unload_delay_secs: 2,
        projects: { [execution]: { trust_level: "trusted" } },
        agents: { enabled: true },
        hooks: {
          state: {
            [codexHookKey(nativePath, "PreToolUse", 0, 0)]: {
              trusted_hash: hash,
            },
          },
        },
      }),
      { mode: 0o600 },
    );
    const auth = join(codexHome(), "auth.json");
    if (!existsSync(auth)) throw new Error("isolated-native-auth-source-unavailable");
    copyFileSync(auth, join(home, "auth.json"));
    const entry = import.meta.url.endsWith(".ts")
      ? fileURLToPath(new URL("../../index.ts", import.meta.url))
      : fileURLToPath(import.meta.url);
    const installedBinary = (name: string): string => {
      const found = spawnSync("which", [name], {
        encoding: "utf8",
        timeout: Math.max(1, operationDeadline - Date.now()),
      });
      if (found.status !== 0 || !found.stdout.trim())
        throw new Error("installed-native-dependency-unavailable");
      return realpathSync(found.stdout.trim());
    };
    const runtime = import.meta.url.endsWith(".ts") ? installedBinary("bun") : process.execPath;
    const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
    writeFileSync(join(bin, "navori"), `#!/bin/sh\nexec ${quote(runtime)} ${quote(entry)} "$@"\n`, {
      mode: 0o700,
    });
    // The owner may run in Bun; the stdin-based hook supervisor requires Node itself.
    symlinkSync(installedBinary("node"), join(bin, "node"));
    symlinkSync(installedBinary("codex"), join(bin, "codex"));
    if (
      spawnSync("git", ["init", "-q", execution], {
        timeout: Math.max(1, operationDeadline - Date.now()),
        stdio: "ignore",
      }).status !== 0
    )
      throw new Error("isolated-native-checkout-unavailable");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CODEX_HOME: home,
      ...(traceDirectory ? { CODEX_ROLLOUT_TRACE_ROOT: traceDirectory } : {}),
      NAVORI_CODEX_PROFILE_PROBE: probe,
      NAVORI_CODEX_PROFILE_PROBE_ROOT: temporary,
      NAVORI_CODEX_PROFILE_PROBE_DEADLINE: String(operationDeadline),
      NAVORI_AUDITS_ROOT: join(temporary, "audit-disabled"),
      PATH: `${bin}${delimiter}/usr/bin${delimiter}/bin`,
    };
    const overrides = [
      ...LIVE_RESTRICTIONS.map((name) => `features.${name}=false`),
      'sandbox_mode="read-only"',
      'approval_policy="never"',
      'approvals_reviewer="user"',
      'web_search="disabled"',
    ];
    connection = new NativeConnection(execution, overrides, operationDeadline, limits, env);
    cleanup = "unverified";
    await initialize(connection, true);
    v2 = connection.version === "0.163.0";
    await verifyLiveProfileAdmission(
      connection,
      execution,
      {
        command,
        hash,
        sourcePath: nativePath,
      },
      v2,
    );
    const catalog = await readConnectionCatalog(connection, execution, "open", true);
    if (v2) {
      const cache = z
        .object({
          client_version: z.literal("0.163.0"),
          models: z.array(z.object({ slug: z.string(), multi_agent_version: z.string() })),
        })
        .parse(JSON.parse(readFileSync(join(home, "models_cache.json"), "utf8")) as unknown);
      if (
        !cache.models.some(
          (model) =>
            model.slug ===
              snapshot.rows.find((row) => row.scope === "principal")?.model.wouldRender &&
            model.multi_agent_version === "v2",
        )
      )
        throw new Error("native-v2-principal-registry-unverified");
    }
    const view = await readNativeProfileView(execution, catalog, operationDeadline);
    const comparable = (rows: readonly CodexProfileProjection[]): string =>
      JSON.stringify(
        rows.map((row) => ({
          name: row.nativeName,
          model: row.model.wouldRender,
          effort: row.effort.wouldRender,
          diagnostics: row.diagnostics,
        })),
      );
    if (comparable(view.rows) !== comparable(snapshot.rows))
      throw new Error("fixture-profile-projection-mismatch");
    for (const path of snapshot.paths.filter(
      (path) => !["navori.config.json", ".codex/config.toml"].includes(path),
    ))
      if (!readFileSync(join(execution, path)).equals(readFileSync(join(root.cwd, path))))
        throw new Error("fixture-profile-inputs-mismatch");
    if (liveProfileSnapshot(root.cwd).identity !== identity)
      throw new Error("target-profile-inputs-changed");
    for (const row of view.rows) {
      const intent = profileSelectionIntent(row);
      if (
        !catalog.models.some(
          (model) =>
            (intent.model.kind === "inherit" || model.model === intent.model.value) &&
            (intent.effort.kind === "inherit" || model.efforts.includes(intent.effort.value)),
        )
      )
        throw new Error("current-role-intent-not-in-native-catalog");
    }
    const principal = view.rows.find((row) => row.scope === "principal")!;
    const started = threadSchema.parse(
      await connection.rpc("thread/start", {
        cwd: execution,
        ephemeral: true,
        sandbox: "read-only",
        approvalPolicy: "never",
        approvalsReviewer: "user",
        model: principal.model.wouldRender,
        config: { model_reasoning_effort: principal.effort.wouldRender },
      }),
    );
    if (
      started.model !== principal.model.wouldRender ||
      started.reasoningEffort !== principal.effort.wouldRender
    )
      throw new Error("principal-effective-profile-mismatch");
    principalSelection = {
      context: started.thread.id,
      model: started.model!,
      effort: started.reasoningEffort!,
    };
    const accept = (
      messages: unknown[],
      rows: readonly CodexProfileProjection[],
      phase: { configuration: string; inventory: string },
    ): NativeProfileCandidate[] => {
      const parentTurns = messages.flatMap((message) => {
        const parsed = z
          .object({
            method: z.literal("turn/completed"),
            params: z.object({
              threadId: z.literal(started.thread.id),
              turn: z.object({
                id: z.string(),
                status: z.literal("completed"),
              }),
            }),
          })
          .safeParse(message);
        return parsed.success ? [parsed.data.params.turn.id] : [];
      });
      if (v2 && parentTurns.length !== 1)
        throw new Error("native-profile-turn-identity-unverified");
      const calls = nativeProfileHookCalls(messages, {
        probe,
        checkout: execution!,
        sourcePath: nativePath,
        principal: started.thread.id,
        ...(v2 ? { turn: parentTurns[0]! } : {}),
      });
      const selected = nativeProfileCandidates(rows, started.thread.id, messages, {
        context: started.thread.id,
        model: started.model!,
        effort: started.reasoningEffort!,
        // Every fixed parent turn omits pair overrides; fixture role/default keys were checked before startup.
        unchanged: true,
        defaultsKnown: true,
        ...(v2 ? { v2: { turn: parentTurns[0]!, hooks: calls } } : {}),
      });
      const spawns = new Set<string>();
      for (const message of messages) {
        const spawn = z
          .object({
            method: z.literal(v2 ? "item/started" : "item/completed"),
            params: z.object({
              item: z.object({
                type: z.literal(v2 ? "subAgentActivity" : "collabAgentToolCall"),
                ...(v2 ? { kind: z.literal("started") } : { tool: z.literal("spawnAgent") }),
                id: z.string(),
              }),
            }),
          })
          .safeParse(message);
        if (spawn.success) spawns.add(spawn.data.params.item.id);
      }
      if (
        selected.length !== rows.length ||
        spawns.size !== rows.length ||
        new Set(selected.map((child) => child.call)).size !== selected.length ||
        new Set(selected.map((child) => child.context)).size !== selected.length ||
        rows.some(
          (row) => selected.filter((child) => child.nativeName === row.nativeName).length !== 1,
        ) ||
        selected.some(
          (child) =>
            !calls.some(
              (call) =>
                call.call === child.call &&
                call.role === child.nativeName &&
                call.configuration === phase.configuration &&
                call.inventory === phase.inventory &&
                call.catalog ===
                  createHash("sha256").update(JSON.stringify(catalog.models)).digest("hex") &&
                JSON.stringify({ model: call.model, effort: call.effort }) ===
                  JSON.stringify(child.intent),
            ),
        )
      )
        throw new Error("native-profile-selection-or-hook-call-unverified");
      if (
        selected.some(
          (child) =>
            !catalog.models.some(
              (model) => model.model === child.model && model.efforts.includes(child.effort),
            ),
        )
      )
        throw new Error("native-child-pair-not-in-current-catalog");
      if (!v2 && !nativeProfileChildrenClosed(messages, selected))
        throw new Error("native-child-shutdown-unverified");
      return selected;
    };
    const observe =
      (rows: readonly CodexProfileProjection[]) =>
      (messages: readonly unknown[], turn: string | null): void => {
        if (turn) observedTurns.push(turn);
        diagnostics.push(
          summarizeNativeProfilePhase(
            messages,
            rows.map((row) => row.nativeName),
            {
              sourcePath: nativePath,
              principal: started.thread.id,
              turn,
              joinedCandidates: nativeProfileCandidates(rows, started.thread.id, messages, {
                context: started.thread.id,
                model: started.model!,
                effort: started.reasoningEffort!,
                unchanged: true,
                defaultsKnown: true,
                ...(v2 && turn
                  ? {
                      v2: {
                        turn,
                        hooks: nativeProfileHookCalls(messages, {
                          probe,
                          checkout: execution!,
                          sourcePath: nativePath,
                          principal: started.thread.id,
                          turn,
                        }),
                      },
                    }
                  : {}),
              }).length,
              validContexts: nativeProfileHookCalls(messages, {
                probe,
                checkout: execution!,
                sourcePath: nativePath,
                principal: started.thread.id,
              }).length,
            },
          ),
        );
      };
    baselinePrincipalTurns = v2 ? roles.length : 1;
    for (const phaseRoles of v2 ? roles.map((role) => [role]) : [roles]) {
      principalTurnRequests++;
      allPhasesClosed = false;
      const phaseChildren = accept(
        await runProfileProbePhase(
          connection,
          started.thread.id,
          phaseRoles.map((row) => row.nativeName),
          operationDeadline,
          observe(phaseRoles),
          v2,
        ),
        phaseRoles,
        view,
      );
      if (
        children.some((old) =>
          phaseChildren.some(
            (next) =>
              old.context === next.context ||
              old.call === next.call ||
              old.agentPath === next.agentPath,
          ),
        )
      )
        throw new Error("refresh-native-context-reused");
      children.push(...phaseChildren);
      allPhasesClosed = true;
    }
    const changed = roles.find(
      (row) =>
        profileSelectionIntent(row).model.kind === "set" &&
        profileSelectionIntent(row).effort.kind === "set",
    );
    if (!changed) throw new Error("supported-pinned-refresh-role-unavailable");
    const option = z
      .enum(["low", "medium", "high", "xhigh", "max"])
      .parse(
        catalog.models
          .find((model) => model.model === changed.model.wouldRender)
          ?.efforts.find(
            (effort) =>
              effort !== changed.effort.wouldRender &&
              ["low", "medium", "high", "xhigh", "max"].includes(effort),
          ),
      );
    const fixtureConfig = readConfig(join(execution, "navori.config.json"));
    fixtureConfig.models = {
      ...fixtureConfig.models,
      codexProfiles: {
        ...fixtureConfig.models?.codexProfiles,
        [changed.nativeName]: {
          ...fixtureConfig.models?.codexProfiles?.[changed.nativeName],
          effort: option,
        },
      },
    };
    writeFileSync(join(execution, "navori.config.json"), JSON.stringify(fixtureConfig));
    const originalRole = readFileSync(join(execution, changed.path), "utf8");
    // Only a fixture pin changes; instructions, names and every baseline target file stay intact.
    writeFileSync(
      join(execution, changed.path),
      originalRole.replace(
        /^model_reasoning_effort\s*=.*$/m,
        `model_reasoning_effort = ${JSON.stringify(option)}`,
      ),
    );
    const refreshView = await readNativeProfileView(execution, catalog, operationDeadline);
    const refreshed = refreshView.rows.find((row) => row.nativeName === changed.nativeName)!;
    if (
      refreshed.effort.wouldRender !== option ||
      readFileSync(join(execution, changed.path), "utf8") === originalRole
    )
      throw new Error("fixture-refresh-pair-unverified");
    if (liveProfileSnapshot(root.cwd).identity !== identity)
      throw new Error("target-profile-inputs-changed");
    principalTurnRequests++;
    allPhasesClosed = false;
    const next = accept(
      await runProfileProbePhase(
        connection,
        started.thread.id,
        [changed.nativeName],
        operationDeadline,
        observe([refreshed]),
        v2,
      ),
      [refreshed],
      refreshView,
    );
    allPhasesClosed = true;
    if (
      children.some((child) => child.context === next[0]?.context || child.call === next[0]?.call)
    )
      throw new Error("refresh-native-context-reused");
    refresh = "verified";
    refreshChild = next[0];
    await verifyLiveProfileAdmission(
      connection,
      execution,
      {
        command,
        hash,
        sourcePath: nativePath,
      },
      v2,
    );
    if (liveProfileSnapshot(root.cwd).identity !== identity)
      throw new Error("target-profile-inputs-changed");
  } catch (error) {
    pending.push(
      error instanceof Error && "code" in error && error.code === "EEXIST"
        ? "fixed-live-probe-attempt-already-consumed"
        : error instanceof Error && /^[a-z0-9-]+$/.test(error.message)
          ? error.message
          : "fixed-live-profile-probe-unavailable",
    );
  } finally {
    if (connection) {
      const acknowledged = await connection.closeAcknowledged(deadline);
      cleanup = acknowledged && allPhasesClosed ? "acknowledged" : "unverified";
      if (!acknowledged) pending.push("owned-process-exit-unacknowledged");
    }
    if (!accountProtocol(limits, 0, 0))
      pending.push("aggregate-protocol-budget-unverified-or-exceeded");
    if (traceDirectory)
      toolInventory = principalSelection
        ? readProfileToolInventory(traceDirectory, principalSelection.context, observedTurns)
        : { status: "unavailable", reason: "missing" };
    // These paths are created by this owner outside the target and global home.
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
  return Object.freeze({
    status: pending.length ? "pending" : "completed",
    scenario: LIVE_PROFILE_SCENARIO,
    target: root.cwd,
    targetIntegration,
    execution,
    identity,
    consumed,
    principalTurnRequests,
    principal: principalSelection,
    children: Object.freeze(children),
    refresh,
    refreshChild,
    events: Object.freeze(connection?.events.slice() ?? []),
    diagnostics: Object.freeze(diagnostics),
    ...(toolInventory ? { toolInventory } : {}),
    cleanup,
    bounds: PROFILE_PROBE_BOUNDS,
    protocol: { bytes: limits.usedBytes, frames: limits.usedEvents },
    phases: {
      baselinePrincipalTurns,
      refreshPrincipalTurns: 1,
      extraRefreshDispatches: 1,
    } as const,
    pending: Object.freeze(pending),
  });
}

/** Deny every inherited MCP server and browser/OS override in the new scoped process only. */
function confinementOverrides(config: RecordValue): string[] {
  const values = [
    "features.plugins=false",
    "features.apps=false",
    "apps._default.enabled=false",
    'browser_use.default_origin_policy.access="deny"',
    'computer_use.default_app_access="deny"',
    'sandbox_mode="read-only"',
    'approval_policy="never"',
    'approvals_reviewer="user"',
  ];
  const servers = object.parse(config.mcp_servers ?? {});
  for (const name of Object.keys(servers)) {
    // CLI -c splits dotted paths literally; quoted/dotted names need another verified host surface.
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error("unsupported-native-config-key");
    values.push(`mcp_servers.${name}.enabled=false`);
  }
  return values;
}

/** Validate actual loaded policy rather than caller/env/TTY assertions of confinement. */
function validPolicy(config: RecordValue): boolean {
  const features = object.parse(config.features ?? {});
  const browsers = object.parse(config.browser_use ?? {});
  const computers = object.parse(config.computer_use ?? {});
  const servers = object.parse(config.mcp_servers ?? {});
  return (
    features.plugins === false &&
    features.apps === false &&
    object.parse(browsers.default_origin_policy ?? {}).access === "deny" &&
    computers.default_app_access === "deny" &&
    Object.values(servers).every((server) => object.parse(server).enabled === false) &&
    Object.values(object.parse(browsers.origins ?? {})).every(
      (entry) => object.parse(entry).access === "deny",
    ) &&
    ["macos", "windows"].every((platform) => {
      const settings = object.parse(computers[platform] ?? {});
      return ["bundle_ids", "aumids", "exes"].every((key) =>
        Object.values(object.parse(settings[key] ?? {})).every((value) => value === "deny"),
      );
    })
  );
}

/** Real sandbox probes verify controller network access and bootstrap are blocked before any turn. */
async function verifySandbox(connection: NativeConnection, cwd: string): Promise<boolean> {
  const server = createServer((_request, response) => {
    response.end("probe");
  });
  let hits = 0;
  server.on("request", () => {
    hits++;
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") return false;
    const base = {
      cwd,
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      timeoutMs: 3_000,
      outputBytesCap: 2_048,
    };
    const network = z.object({ exitCode: z.number() }).parse(
      await connection.rpc("command/exec", {
        ...base,
        command: [
          "node",
          "-e",
          `require('node:http').get('http://127.0.0.1:${address.port}',()=>process.exit(0)).on('error',()=>process.exit(1))`,
        ],
      }),
    );
    const bootstrap = z
      .object({ exitCode: z.number(), stdout: z.string(), stderr: z.string() })
      .parse(
        await connection.rpc("command/exec", {
          ...base,
          command: [
            "node",
            "-e",
            "require('node:http').createServer().on('error',e=>{process.stderr.write(e.code);process.exit(1)}).listen(0,'127.0.0.1',()=>process.exit(0))",
          ],
        }),
      );
    return (
      network.exitCode !== 0 &&
      hits === 0 &&
      bootstrap.exitCode !== 0 &&
      bootstrap.stderr === "EPERM"
    );
  } finally {
    server.close();
    server.closeAllConnections();
  }
}

/** Exclusively burn the exact pending action before the fixed effect; uncertain attempts cannot retry. */
function publishOnce(
  scope: NativeApprovalScope,
  identity: NativeApprovalIdentity,
  connection: string,
  origin: NativeApprovalIdentity,
): "completed" | "uncertain" | "pending" {
  if (!approvalSourceIsolationAvailable() || !revalidateNativeApproval(scope)) return "pending";
  const root = resolveStateRoot({
    cwd: scope.checkout,
    feature: "codex-native-approval",
    dir: ".navori/state/handoffs",
  });
  ensureStateDirectory(root);
  const digest = createHash("sha256").update(JSON.stringify(scope)).digest("hex");
  let fd: number;
  try {
    fd = openSync(
      stateArtifactPath(root, `approval_${scope.pendingId}.native-attempt`),
      "wx",
      0o600,
    );
  } catch {
    // A consumed/uncertain attempt is reconciled read-only, never replayed or silently reauthorized.
    const query = spawnSync(
      "gh",
      [
        "pr",
        "list",
        "--repo",
        scope.repository,
        "--state",
        "all",
        "--base",
        scope.base,
        "--head",
        scope.head,
        "--json",
        "baseRefName,headRefName,headRefOid,title,body,isDraft",
      ],
      {
        cwd: scope.checkout,
        timeout: 15_000,
        encoding: "utf8",
        maxBuffer: 65_536,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    try {
      const candidates = z
        .array(
          z.object({
            baseRefName: z.string(),
            headRefName: z.string(),
            headRefOid: z.string(),
            title: z.string(),
            body: z.string(),
            isDraft: z.boolean(),
          }),
        )
        .parse(JSON.parse(query.stdout) as unknown);
      const matches = candidates.filter(
        (candidate) =>
          candidate.baseRefName === scope.base &&
          candidate.headRefName === scope.head &&
          candidate.headRefOid === scope.remoteHead &&
          candidate.title === scope.title &&
          createHash("sha256").update(candidate.body).digest("hex") === scope.bodyDigest &&
          candidate.isDraft === scope.draft,
      ).length;
      writeStateFileAtomic(
        root,
        `approval_${scope.pendingId}.native-reconciliation.json`,
        JSON.stringify({
          connection,
          identity,
          scopeDigest: digest,
          matches,
          status: "read-only; no retry or authorization inferred",
        }),
      );
    } catch {
      /* Missing/ambiguous remote evidence cannot restore a consumed attempt. */
    }
    return "pending";
  }
  try {
    writeSync(
      fd,
      JSON.stringify({
        connection,
        identity,
        origin,
        scopeDigest: digest,
        status: "burned-before-effect",
      }),
    );
  } finally {
    closeSync(fd);
  }
  if (!revalidateNativeApproval(scope)) return "pending";
  const args = [
    "pr",
    "create",
    "--repo",
    scope.repository,
    "--base",
    scope.base,
    "--head",
    scope.head,
    "--title",
    scope.title,
    "--body",
    scope.body,
  ];
  if (scope.draft) args.push("--draft");
  try {
    const effect = spawnSync("gh", args, {
      cwd: scope.checkout,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 65_536,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const status = !effect.error && effect.status === 0 ? "completed" : "uncertain";
    writeStateFileAtomic(
      root,
      `approval_${scope.pendingId}.native-outcome.json`,
      JSON.stringify({
        connection,
        identity,
        origin,
        scopeDigest: digest,
        status,
        reconciliation: status === "uncertain" ? "read-only-required; no retry" : "not-required",
      }),
    );
    return status;
  } catch {
    return "uncertain";
  }
}

/** New confined native context only; CLI input never resolves the held human decision. */
export async function runNativeIntegration(
  cwd: string,
  requestId: string,
  probeOnly = false,
): Promise<NativeIntegrationResult> {
  const connectionId = randomUUID();
  let connection: NativeConnection | undefined;
  let context: string | undefined;
  const result = (
    status: NativeIntegrationResult["status"],
    reason: string,
  ): NativeIntegrationResult => ({
    status,
    reason,
    connection: connectionId,
    context,
    events: connection?.events ?? [],
  });
  if (!probeOnly && !approvalSourceIsolationAvailable())
    return result("pending", "human-source-isolation-unverified");
  try {
    const scope = snapshotNativeApproval(requestId, cwd);
    connection = new NativeConnection(scope.checkout, [
      "features.plugins=false",
      "features.apps=false",
    ]);
    await initialize(connection);
    const initial = z
      .object({ config: object })
      .parse(await connection.rpc("config/read", { cwd: scope.checkout, includeLayers: false }));
    const overrides = confinementOverrides(initial.config);
    connection.close();
    connection = new NativeConnection(scope.checkout, overrides);
    await initialize(connection);
    const policy = z
      .object({ config: object })
      .parse(await connection.rpc("config/read", { cwd: scope.checkout, includeLayers: false }));
    if (!validPolicy(policy.config) || !(await verifySandbox(connection, scope.checkout)))
      return result("pending", "host-isolation-unverified");
    const native = connection;
    const started = threadSchema.parse(
      await native.rpc("thread/start", {
        cwd: scope.checkout,
        ephemeral: true,
        sandbox: "read-only",
        approvalPolicy: "never",
        approvalsReviewer: "user",
        dynamicTools: [
          {
            type: "function",
            name: "github_pr_create",
            description: "Request one fixed PR publication; host human approval is mandatory.",
            inputSchema: {
              type: "object",
              properties: { requestId: { type: "string", const: requestId } },
              required: ["requestId"],
              additionalProperties: false,
            },
          },
        ],
      }),
    );
    context = started.thread.id;
    native.events.push(
      `selected-context:${started.model ?? "unknown"}:${started.reasoningEffort ?? "unknown"}`,
    );
    const inventory = z
      .object({ data: z.array(z.object({ tools: object })), nextCursor: z.string().nullable() })
      .parse(
        await native.rpc("mcpServerStatus/list", {
          threadId: context,
          limit: 100,
          detail: "toolsAndAuthOnly",
        }),
      );
    if (
      inventory.nextCursor !== null ||
      inventory.data.some((server) => Object.keys(server.tools).length !== 0)
    )
      return result("pending", "native-tool-isolation-unverified");
    native.events.push(
      `verified-isolation:readOnly:network=false:MCP-tools=0:pages=1:browser=deny:computer=deny:plugins=false:apps=false`,
    );
    if (probeOnly) return result("pending", "native-context-probed-without-action");
    const threads = new Set([context]);
    const outstanding = new Map<string, string>();
    let consumed = false;
    let finish: (value: NativeIntegrationResult) => void = () => {};
    const completed = new Promise<NativeIntegrationResult>((resolve) => {
      finish = resolve;
    });
    const cancellation = new AbortController();
    let effectResult: NativeIntegrationResult | undefined;
    let effectIdentity: NativeApprovalIdentity | undefined;
    native.onClose = () => {
      cancellation.abort();
      finish(
        result(
          effectResult?.status === "completed" || effectResult?.status === "uncertain"
            ? "uncertain"
            : "pending",
          "native-context-closed",
        ),
      );
    };
    let pendingOrigin: NativeApprovalIdentity | undefined;
    const handledCalls = new Set<string>();
    /** Only native messages from this private connection supply request/lineage identity. */
    const handle = async (message: RpcMessage): Promise<void> => {
      const params = object.safeParse(message.params);
      if (!params.success) return;
      if (message.method === "thread/started") {
        const child = z
          .object({ thread: z.object({ id: z.string(), parentThreadId: z.string().nullable() }) })
          .safeParse(message.params);
        if (
          child.success &&
          child.data.thread.parentThreadId &&
          threads.has(child.data.thread.parentThreadId)
        )
          threads.add(child.data.thread.id);
      }
      const item = object.safeParse(params.data.item);
      if (
        message.method === "item/started" &&
        item.success &&
        item.data.type === "dynamicToolCall" &&
        item.data.tool === "github_pr_create" &&
        typeof item.data.id === "string" &&
        typeof params.data.threadId === "string" &&
        threads.has(params.data.threadId)
      )
        outstanding.set(item.data.id, `${params.data.threadId}:${String(params.data.turnId)}`);
      if (message.method === "item/tool/call" && message.id !== undefined) {
        const callback = callbackSchema.safeParse(message.params);
        let outcome = result("pending", "native-request-unverified");
        if (
          !consumed &&
          callback.success &&
          callback.data.arguments.requestId === requestId &&
          threads.has(callback.data.threadId) &&
          outstanding.get(callback.data.callId) ===
            `${callback.data.threadId}:${callback.data.turnId}` &&
          !handledCalls.has(callback.data.callId)
        ) {
          const identity: NativeApprovalIdentity = {
            requestId: message.id,
            threadId: callback.data.threadId,
            turnId: callback.data.turnId,
            callId: callback.data.callId,
            action: "github.pr.create",
          };
          handledCalls.add(callback.data.callId);
          if (callback.data.threadId !== context || !pendingOrigin) {
            const fromChild = callback.data.threadId !== context;
            if (fromChild) pendingOrigin ??= identity;
            native.send({
              id: message.id,
              result: {
                contentItems: [
                  {
                    type: "inputText",
                    text: JSON.stringify({
                      status: "pending",
                      reason: fromChild
                        ? "child-action-needs-confined-parent"
                        : "child-origin-unverified",
                      requestId,
                    }),
                  },
                ],
                success: false,
              },
            });
            return;
          }
          consumed = true;
          const decision = await requestBrowserDecision(
            identity,
            { ...scope, nativeOrigin: pendingOrigin },
            120_000,
            cancellation.signal,
          );
          outcome =
            decision === "accept" && native.isOpen() && !cancellation.signal.aborted
              ? result(
                  publishOnce(scope, identity, connectionId, pendingOrigin),
                  "one-request-browser-decision",
                )
              : result(
                  decision === "decline" ? "declined" : "pending",
                  "browser-decision-not-accepted",
                );
          effectResult = outcome;
          effectIdentity = identity;
        }
        native.send({
          id: message.id,
          result: {
            contentItems: [{ type: "inputText", text: JSON.stringify(outcome) }],
            success: outcome.status === "completed",
          },
        });
      } else if (message.id !== undefined && message.method !== undefined) {
        // Shell escalation, policy/session acceptance and arbitrary incoming requests are never granted.
        native.send({
          id: message.id,
          error: { code: -32601, message: "Unsupported protected integration request" },
        });
      }
      if (
        message.method === "item/completed" &&
        item.success &&
        item.data.type === "dynamicToolCall" &&
        effectResult &&
        effectIdentity &&
        item.data.id === effectIdentity.callId &&
        params.data.threadId === effectIdentity.threadId &&
        params.data.turnId === effectIdentity.turnId
      ) {
        const nativeStatus = z
          .object({
            status: z.enum(["inProgress", "completed", "failed"]),
            success: z.boolean().optional(),
          })
          .safeParse(item.data);
        const outcome =
          effectResult.status === "completed" &&
          (!nativeStatus.success ||
            nativeStatus.data.status !== "completed" ||
            nativeStatus.data.success === false)
            ? result("uncertain", "native-completion-unverified")
            : effectResult;
        const root = resolveStateRoot({
          cwd: scope.checkout,
          feature: "codex-native-approval",
          dir: ".navori/state/handoffs",
        });
        writeStateFileAtomic(
          root,
          `approval_${scope.pendingId}.native-completion.json`,
          JSON.stringify({
            connection: connectionId,
            identity: effectIdentity,
            origin: pendingOrigin,
            itemId: item.data.id,
            nativeStatus: nativeStatus.success ? nativeStatus.data.status : "unknown",
            nativeSuccess: nativeStatus.success ? nativeStatus.data.success : undefined,
            effectStatus: effectResult.status,
            status: outcome.status,
          }),
        );
        finish(outcome);
      }
      if (message.method === "turn/completed" && params.data.threadId === context)
        finish(
          effectResult?.status === "completed"
            ? result("uncertain", "native-completion-unverified")
            : (effectResult ?? result("pending", "no-applicable-native-action")),
        );
    };
    native.onMessage = (message) => {
      void handle(message).catch(() =>
        finish(
          result(
            effectResult?.status === "completed" || effectResult?.status === "uncertain"
              ? "uncertain"
              : "pending",
            "native-action-unavailable",
          ),
        ),
      );
    };
    const timer = setTimeout(() => {
      cancellation.abort();
      finish(
        result(
          effectResult?.status === "completed" || effectResult?.status === "uncertain"
            ? "uncertain"
            : "pending",
          "native-action-deadline",
        ),
      );
    }, 180_000);
    try {
      await native.rpc("turn/start", {
        threadId: context,
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        input: [
          {
            type: "text",
            text: `Delegate pending publication ${requestId} to a native publisher subagent. The child must request github_pr_create with that requestId and return pending. Then you, the principal, must request github_pr_create with the same requestId so the host human can review the immutable scope. Do not execute publication through shell, API, browser or other tools.`,
          },
        ],
      });
      return await completed;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return result("pending", "native-integration-unavailable");
  } finally {
    connection?.close();
  }
}
