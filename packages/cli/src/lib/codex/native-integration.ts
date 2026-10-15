import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:http";
import { closeSync, openSync, writeSync, fsyncSync, ftruncateSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { readConfig } from "../config/config.ts";
import { join } from "node:path";
import { requestBrowserDecision, type NativeApprovalIdentity } from "./approval-controller.ts";
import { approvalSourceIsolationAvailable } from "./approval-ui.ts";
import {
  readNativeProfileView,
  nativeProfileCandidates,
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

/** Diagnostics contain protocol types only, never prompts, credentials, bodies or raw stderr. */
export interface NativeIntegrationResult {
  readonly status: "pending" | "declined" | "completed" | "uncertain";
  readonly reason: string;
  readonly connection: string;
  readonly context?: string;
  readonly events: readonly string[];
}

/** Owned stdio transport with bounded messages and exact ID correlation (including ID zero). */
class NativeConnection {
  readonly child: ChildProcessWithoutNullStreams;
  readonly events: string[] = [];
  private sequence = 0;
  private buffer = "";
  private closed = false;
  private readonly deadline?: number;
  private operationTimer?: ReturnType<typeof setTimeout>;
  private exitObserved = false;
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
    private readonly limits?: {
      bytes: number;
      events: number;
      usedBytes: number;
      usedEvents: number;
    },
  ) {
    if (deadline !== undefined && Date.now() >= deadline)
      throw new Error("native-operation-timeout");
    this.deadline = deadline;
    this.child = spawn(
      "codex",
      ["app-server", "--stdio", ...overrides.flatMap((value) => ["-c", value])],
      { cwd, stdio: "pipe" },
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
    if (this.limits) this.limits.usedBytes += chunk.length;
    if (this.limits && this.limits.usedBytes > this.limits.bytes) {
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
      if (this.limits && ++this.limits.usedEvents > this.limits.events) {
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
    if (this.limits) this.limits.usedBytes += Buffer.byteLength(encoded);
    if (this.limits && this.limits.usedBytes > this.limits.bytes) {
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
    this.child.kill(this.deadline === undefined ? "SIGTERM" : "SIGKILL");
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
async function initialize(connection: NativeConnection): Promise<void> {
  const response = z.object({ platformOs: z.literal("macos"), userAgent: z.string() }).parse(
    await connection.rpc("initialize", {
      clientInfo: { name: "navori_bounded_integration", version: "0.12.0" },
      capabilities: { experimentalApi: true },
    }),
  );
  // Ceiling: verified CLI 0.162.1 only; admit a later protocol after fresh native isolation probes.
  if (!/\/0\.162\.1(?:\s|$)/.test(response.userAgent)) throw new Error("unverified-native-version");
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
  const connection = new NativeConnection(cwd, [], Math.min(deadline, Date.now() + 8_000));
  try {
    return await readConnectionCatalog(connection, cwd, "closed");
  } finally {
    connection.close();
  }
}

/** Internal same-connection catalog query; only fixed native lifecycles can use the transport. */
async function readConnectionCatalog(
  connection: NativeConnection,
  cwd: string,
  lifecycle: NativeCatalogSnapshot["lifecycle"],
  initialized = false,
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
    if (!initialized) await initialize(connection);
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
      version: "0.162.1",
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
