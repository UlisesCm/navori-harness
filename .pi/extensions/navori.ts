// navori:managed-file id="pi-extension" hash="81ee707d93ce41f50fc5d2ffe894c0ad026ccef8333ff13a13112761aa4b6b41"
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { VERSION, defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";


function assertTrustedPiParent(ctx: { isProjectTrusted?: () => boolean }): void {
  let trusted = false;
  try {
    trusted = ctx.isProjectTrusted?.() === true;
  } catch {
    // A missing or failing Pi trust API is not permission to run a child.
  }
  if (!trusted) throw new Error("Navori Pi subagent requires a trusted parent project");
}

const piRuntimeChecks = (function(e,t,n){function r(e){let t=/^v?(\d+)\.(\d+)\.(\d+)(?:\+[\w.-]+)?$/.exec(e.trim());if(!t)return null;let n=Number(t[1]),r=Number(t[2]),i=Number(t[3]);return[n,r,i].every(Number.isSafeInteger)?[n,r,i]:null}function i(e,t){return e[0]===t[0]?e[1]===t[1]?e[2]>=t[2]:e[1]>t[1]:e[0]>t[0]}return{assert:(n,a=process.versions.node)=>{let o=r(a),s=r(t);if(!o||!s||!i(o,s))throw Error(`Navori's Pi engine requires Node.js ${t} or later; found ${a}.`);let c=r(n),l=r(e);if(!c||!l||!i(c,l))throw Error(`Navori's Pi engine requires @earendil-works/pi-coding-agent ${e} or later; found ${n}. Run pi --version and upgrade Pi.`)},unverified:e=>{let t=r(e);return n.filter(e=>{let n=r(e.verifiedFrom);return!t||!n||!i(t,n)}).map(e=>e.capability+` (verified from Pi `+e.verifiedFrom+`)`)}}})("0.87.1", "22.19.0", [{"capability":"child-mcp-off","verifiedFrom":"1.1.0"},{"capability":"child-model-selection","verifiedFrom":"1.1.0"},{"capability":"child-tool-allowlist","verifiedFrom":"1.1.0"}]);
const assertSupportedPiRuntime = piRuntimeChecks.assert;
const unverifiedPiCapabilities = piRuntimeChecks.unverified;


type Role = "scout" | "implementer" | "reviewer" | "scribe";
type RoleSpec = { name: Role; description: string; model?: string; tools: string[]; instructions: string };
type Controls = { planTiers: boolean; masterPlan: boolean; scribeOwnsMarkdown: boolean };
const ROLES = new Set<Role>(["scout", "implementer", "reviewer", "scribe"]);
const ROLE_TOOLS: Record<Role, ReadonlySet<string>> = {
  scout: new Set(["read", "grep", "find", "ls", "write"]),
  implementer: new Set(["read", "grep", "find", "ls", "bash", "edit", "write"]),
  reviewer: new Set(["read", "grep", "find", "ls", "bash", "write"]),
  // The scribe's own Bash runs its handoff preflight; the implementer's Markdown block is unaffected.
  scribe: new Set(["read", "grep", "find", "ls", "bash", "edit", "write"]),
};
const MAX_CHILDREN = 3;
const TIMEOUT_MS = 600_000;
const GRACE_MS = 5_000;
const MAX_OUTPUT_BYTES = 65_536;
const MAX_EVENT_BYTES = 8 * 1024 * 1024;
type ChildResult = { text: string; truncated: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function controls(cwd: string): Controls {
  const manifest: unknown = JSON.parse(readFileSync(join(cwd, ".pi/navori.json"), "utf8"));
  if (!isRecord(manifest) || !isRecord(manifest.controls)) {
    return { planTiers: false, masterPlan: false, scribeOwnsMarkdown: false };
  }
  const value = manifest.controls;
  if (typeof value.planTiers !== "boolean" || typeof value.masterPlan !== "boolean" ||
      typeof value.scribeOwnsMarkdown !== "boolean") throw new Error("Invalid Navori Pi controls");
  return { planTiers: value.planTiers, masterPlan: value.masterPlan,
    scribeOwnsMarkdown: value.scribeOwnsMarkdown };
}

function runNavori(cwd: string, args: string[], input: string, signal: AbortSignal): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("navori", args, { cwd, stdio: ["pipe", "pipe", "ignore"] });
    let stdout = "";
    let stopped = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    };
    const timeout = setTimeout(stop, 10_000);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout) > 65_536) stop();
    });
    child.on("error", (cause: Error) => reject(cause));
    child.on("close", (code: number | null) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      signal.removeEventListener("abort", stop);
      if (stopped || signal.aborted || Buffer.byteLength(stdout) > 65_536) reject(new Error("Navori control aborted, timed out, or oversized"));
      else resolve({ code, stdout });
    });
  });
}

async function checkDispatch(cwd: string, role: Role, task: string,
    feature: string | undefined, signal: AbortSignal): Promise<void> {
  if (role === "implementer" && controls(cwd).planTiers) {
    const payload = JSON.stringify({ cwd, tool_input: { agent_type: role, message: task } });
    let result;
    try { result = await runNavori(cwd, ["plan", "gate"], payload, signal); }
    catch { throw new Error("Navori plan gate unavailable; subagent blocked"); }
    if (result.code !== 0) throw new Error("Navori plan gate blocked the implementer");
  }
  if (role === "reviewer" || role === "scribe") {
    if (!feature || !/^[a-z0-9][a-z0-9_-]*$/.test(feature)) {
      throw new Error("Navori " + role + " requires an explicit Navori feature slug for handoff check");
    }
    let result;
    try { result = await runNavori(cwd, ["handoff", "check", feature,
      "--for", role === "scribe" ? "scribe" : "orchestrator", "--cwd", cwd, "--dir", ".navori/state/handoffs", "--json"],
      "", signal); }
    catch { throw new Error("Navori handoff check unavailable; " + role + " blocked"); }
    let parsed: unknown;
    try { parsed = JSON.parse(result.stdout); } catch { throw new Error("Invalid Navori handoff check JSON; " + role + " blocked"); }
    if (result.code !== 0 || !isRecord(parsed) || parsed.status !== "ok" ||
        parsed.feature !== feature) throw new Error("Navori handoff check did not pass; " + role + " blocked");
  }
}

function enabledRoles(cwd: string): unknown[] {
  const manifest: unknown = JSON.parse(readFileSync(join(cwd, ".pi/navori.json"), "utf8"));
  return isRecord(manifest) && Array.isArray(manifest.agents) ? manifest.agents : [];
}

/** Refuse before any child starts when the project forbids Markdown without enabling its producer. */
function assertMarkdownProducer(cwd: string, role: Role): void {
  const owned = controls(cwd).scribeOwnsMarkdown;
  if (role === "scribe" && !owned) {
    throw new Error("Navori scribe is admitted only when harness.scribeOwnsMarkdown is enabled");
  }
  if (role === "implementer" && owned && !enabledRoles(cwd).includes("scribe")) {
    throw new Error("Markdown is owned by the scribe but the scribe role is not enabled; enable harness.scribe or disable harness.scribeOwnsMarkdown, then run navori render");
  }
}

function roleSpec(cwd: string, role: Role): RoleSpec {
  if (!enabledRoles(cwd).includes(role)) {
    throw new Error("Navori Pi role is not enabled: " + role);
  }
  const raw = readFileSync(join(cwd, ".pi/agents", role + ".md"), "utf8");
  const match = /^---\n(?:#[^\n]*\n)?([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!match) throw new Error("Invalid Pi role definition: " + role);
  const fields = new Map<string, unknown>();
  for (const line of match[1].split("\n")) {
    const field = /^([a-z]+): (.+)$/.exec(line);
    if (!field) throw new Error("Invalid Pi role field: " + role);
    fields.set(field[1], JSON.parse(field[2]));
  }
  const tools = fields.get("tools");
  const mcpTools = Array.isArray(tools) ? tools.filter((tool: unknown) => typeof tool === "string" && /^mcp(?:$|[_:-])/i.test(tool)) : [];
  if (mcpTools.length) {
    throw new Error("Navori Pi role " + role + " requires MCP tools (" + mcpTools.join(", ") +
      ") and is unavailable: E1 children run with --no-mcp. Remove them from its role file or wait for MCP-in-children support.");
  }
  if (fields.get("name") !== role || typeof fields.get("description") !== "string" ||
      !Array.isArray(tools) || !tools.every((tool: unknown) => typeof tool === "string" && ROLE_TOOLS[role].has(tool))) {
    throw new Error("Unknown or missing Pi role tool mapping: " + role);
  }
  const model = fields.get("model");
  if (model !== undefined && typeof model !== "string") throw new Error("Invalid Pi role model: " + role);
  return { name: role, description: fields.get("description") as string, model: model as string | undefined,
    tools: tools as string[], instructions: match[2].trim() };
}

type ModelContext = { model?: { provider?: unknown; id?: unknown }; modelRegistry?: { getAvailable?: () => Array<{ provider: string; id: string }> } };

/** Resolve the exact provider/model a child runs on: role override wins, else the parent's identity. Never credentials. */
function resolveModel(role: RoleSpec, ctx: ModelContext): string {
  let effective = role.model;
  if (effective === undefined) {
    const parent = ctx.model;
    if (!parent || typeof parent.provider !== "string" || typeof parent.id !== "string" || !parent.provider || !parent.id) {
      throw new Error("Navori cannot determine the parent Pi model for role " + role.name + "; select one with /model or set an explicit model for the role");
    }
    effective = parent.provider + "/" + parent.id;
  }
  const slash = effective.indexOf("/");
  const registry = ctx.modelRegistry;
  if (slash > 0 && registry && typeof registry.getAvailable === "function") {
    const provider = effective.slice(0, slash);
    const id = effective.slice(slash + 1);
    const bare = id.replace(/:[^:]*$/, "");
    const available = registry.getAvailable().some((model) => model.provider === provider && (model.id === id || model.id === bare));
    if (!available) throw new Error("Pi model " + effective + " is not available for role " + role.name + "; check /login and /model");
  }
  return effective;
}

/** Parse bounded raw-byte records, retaining only the latest complete assistant snapshot. */
function childParser(): { feed: (chunk: Buffer) => void; finish: () => ChildResult } {
  let pending = Buffer.alloc(0);
  let pendingBytes = 0;
  let result: ChildResult = { text: "", truncated: false };
  let settled = false;
  const record = (raw: Buffer): void => {
    const line = raw.toString("utf8").replace(/\r$/, "");
    if (!line.trim()) return;
    let event: unknown;
    try { event = JSON.parse(line); } catch { throw new Error("Invalid Pi child JSONL event"); }
    if (!isRecord(event)) throw new Error("Invalid Pi child JSONL event");
    if (event.type === "agent_settled") {
      if (event.aborted === true) throw new Error("Pi child agent_settled aborted");
      settled = true;
    }
    if (event.type !== "message_end" || !isRecord(event.message) || event.message.role !== "assistant") return;
    const blocks = event.message.content;
    if (!Array.isArray(blocks)) return;
    let bytes = Buffer.alloc(0);
    let total = 0;
    let count = 0;
    for (const block of blocks) {
      if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
      const part = Buffer.from((count++ ? "\n" : "") + block.text, "utf8");
      total += part.length;
      const remaining = MAX_OUTPUT_BYTES - bytes.length;
      if (remaining > 0) bytes = Buffer.concat([bytes, part.subarray(0, remaining)]);
    }
    // A cutoff inside a multibyte character must drop the entire partial character.
    if (total > MAX_OUTPUT_BYTES) {
      let end = bytes.length;
      let start = end - 1;
      while (start >= 0 && (bytes[start] & 0xc0) === 0x80) start--;
      if (start >= 0) {
        const lead = bytes[start];
        const width = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
        if (end - start < width) end = start;
      }
      bytes = bytes.subarray(0, end);
    }
    result = { text: bytes.toString("utf8"), truncated: total > MAX_OUTPUT_BYTES };
  };
  return {
    feed(chunk: Buffer): void {
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(10, start);
        const end = newline < 0 ? chunk.length : newline;
        const size = end - start;
        if (pendingBytes + size > MAX_EVENT_BYTES) throw new Error("Pi child exceeded output limit: event record");
        if (pendingBytes + size > pending.length) {
          const capacity = Math.min(MAX_EVENT_BYTES, Math.max(pendingBytes + size, pending.length * 2, 4096));
          const grown = Buffer.alloc(capacity);
          pending.copy(grown, 0, 0, pendingBytes);
          pending = grown;
        }
        chunk.copy(pending, pendingBytes, start, end);
        pendingBytes += size;
        if (newline < 0) return;
        record(pending.subarray(0, pendingBytes));
        pendingBytes = 0;
        start = newline + 1;
      }
    },
    finish(): ChildResult {
      if (pendingBytes) record(pending.subarray(0, pendingBytes));
      pending = Buffer.alloc(0);
      pendingBytes = 0;
      if (!settled) throw new Error("Pi child stopped before agent_settled");
      return result;
    },
  };
}

/** Run one child with bounded incremental parsing and unchanged cancellation deadlines. */
function runChild(cwd: string, role: RoleSpec, model: string, task: string, parentSignal: AbortSignal): Promise<ChildResult> {
  // --no-mcp: ambient MCP must be unreachable from E1 children; --model is always explicit (omitting it is not inheriting).
  const args = ["--mode", "json", "--no-session", "--approve", "--no-mcp", "--model", model];
  if (role.tools.length) args.push("--tools", role.tools.join(","));
  else args.push("--no-tools");
  args.push("--", role.instructions + "\n\nTask: " + task);
  return new Promise<ChildResult>((resolve, reject) => {
    const child = spawn("pi", args, { cwd, env: { ...process.env, NAVORI_PI_CHILD_DEPTH: "1", NAVORI_PI_CHILD_ROLE: role.name },
      detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    const parser = childParser();
    let parseError: unknown;
    let stopping = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    // Kill the whole process group so descendants of the leader are cleaned up too.
    const kill = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { /* Process or group already exited. */ }
    };
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      kill("SIGTERM");
      // Not cleared when the leader closes: descendants may outlive it and still need SIGKILL.
      killTimer = setTimeout(() => kill("SIGKILL"), GRACE_MS);
    };
    const timeout = setTimeout(stop, TIMEOUT_MS);
    const abort = (): void => stop();
    const release = (): void => {
      clearTimeout(timeout);
      parentSignal.removeEventListener("abort", abort);
    };
    parentSignal.addEventListener("abort", abort, { once: true });
    if (parentSignal.aborted) stop();
    child.stdout.on("data", (chunk: Buffer) => {
      if (stopping) return;
      try { parser.feed(chunk); } catch (cause) { parseError = cause; stop(); }
    });
    child.stderr.resume();
    child.on("error", (cause: Error) => {
      // A spawn failure has no process or group to escalate against.
      if (!child.pid) { stopping = true; if (killTimer) clearTimeout(killTimer); }
      else stop();
      release();
      reject(cause);
    });
    child.on("close", (code: number | null) => {
      release();
      if (parseError) reject(parseError);
      else if (stopping) reject(new Error("Pi child cancelled, timed out, or exceeded output limit"));
      else if (code !== 0) reject(new Error("Pi child exited " + code + "; inspect Pi auth with /login openai-codex"));
      else { try { resolve(parser.finish()); } catch (cause) { reject(cause); } }
    });
  });
}

export default function (pi: ExtensionAPI): void {
  try {
    assertSupportedPiRuntime(VERSION);
  } catch (cause) {
    process.stderr.write((cause instanceof Error ? cause.message : "Unsupported Pi runtime") + "\n");
    return;
  }
  pi.on("tool_call", async (event, ctx) => {
    if (!controls(ctx.cwd).scribeOwnsMarkdown || process.env.NAVORI_PI_CHILD_ROLE !== "implementer") return;
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    const input: unknown = event.input;
    if (!isRecord(input) || typeof input.path !== "string") return;
    if (/\.mdx?$/i.test(input.path)) {
      return { block: true, reason: "Navori scribe owns Markdown; direct Pi edit/write blocked. Bash is outside this advisory boundary." };
    }
  });
  if (process.env.NAVORI_PI_CHILD_DEPTH) return;
  pi.on("before_agent_start", async (event, ctx) => {
    if (!controls(ctx.cwd).masterPlan) return;
    try {
      const result = await pi.exec("navori", ["master", "status", "--line"], { cwd: ctx.cwd, timeout: 10_000 });
      const line = result.stdout.trim();
      if (result.code === 0 && line && !/[\r\n]/.test(line) && line.length <= 600) {
        return { systemPrompt: event.systemPrompt + "\n\n" + line };
      }
    } catch { /* Advisory only; the user's prompt must continue. */ }
  });
  let active = 0;
  pi.registerTool(defineTool({
    name: "navori_subagent",
    label: "Navori subagent",
    description: "Run a bounded Navori scout, implementer, reviewer, or scribe child in this trusted project.",
    parameters: Type.Object({ role: Type.Union([Type.Literal("scout"), Type.Literal("implementer"), Type.Literal("reviewer"), Type.Literal("scribe")]),
      task: Type.String({ minLength: 1 }), feature: Type.Optional(Type.String()) }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      assertTrustedPiParent(ctx);
      if (!ROLES.has(params.role)) throw new Error("Unsupported Navori Pi role");
      const unverified = unverifiedPiCapabilities(VERSION);
      if (unverified.length) throw new Error("Pi " + VERSION + " is not verified for Navori children: " + unverified.join(", ") + "; upgrade Pi");
      if (active >= MAX_CHILDREN) throw new Error("Navori Pi child concurrency limit reached (3)");
      assertMarkdownProducer(ctx.cwd, params.role);
      const spec = roleSpec(ctx.cwd, params.role);
      const model = resolveModel(spec, ctx);
      active++;
      try {
        if (params.role !== "scout") await checkDispatch(ctx.cwd, params.role, params.task, params.feature, signal);
        const result = await runChild(ctx.cwd, spec, model, params.task, signal);
        return { content: [{ type: "text", text: result.text }], details: { role: params.role, truncated: result.truncated } };
      } finally { active--; }
    },
  }));
}
