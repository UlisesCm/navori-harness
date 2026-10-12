/**
 * Spec 0048 D1/D2/D10: the hook bridge that lets Pi run the shared hook scripts, as a fragment of
 * `PI_EXTENSION_SOURCE`. It relies on the extension scope (`spawn`, `readFileSync`, `join`, `isRecord`,
 * `getShellConfig`) and declares nothing that collides with it. The fragment contains no backtick and no
 * placeholder so it can be spliced into the extension template as-is.
 *
 * Verdict contract (design.md "Contracts", F4/F5):
 *
 * | script outcome                                    | enforced (tool_call)     | advisory (tool_result) | lifecycle |
 * | ------------------------------------------------- | ------------------------ | ---------------------- | --------- |
 * | exit 0, no JSON                                   | allow                    | nothing                | nothing   |
 * | exit 2                                            | block, reason = stderr   | warning = stderr       | nothing   |
 * | JSON permissionDecision deny                      | block                    | nothing                | nothing   |
 * | JSON permissionDecision ask                       | ask                      | nothing                | nothing   |
 * | JSON permissionDecision allow / context / message | allow                    | warning = context      | nothing   |
 * | JSON unknown decision, updatedInput, continue=false | block                  | nothing                | nothing   |
 * | exit other than 0/2, signal, timeout, no spawn, no bash | block              | nothing                | nothing   |
 *
 * Only a stdout JSON object (with `hookSpecificOutput`, `systemMessage` or `continue`) is a verdict; any
 * other stdout is noise (the gate prints its whole run there) and nothing beyond 64 KiB of it is kept.
 * Stderr is kept as head + tail. Bash is resolved with `getShellConfig()` and no `shellPath`, so the project
 * can never choose the shell that evaluates the model's own commands; a missing bash, or the `sh` fallback,
 * blocks every `enforced` script with the action to take.
 */
export const PI_BRIDGE_SOURCE = String.raw`
// ---- Navori hook bridge (spec 0048): runs the shared hook scripts under bash with a Claude-shaped payload.
type BridgeClass = "enforced" | "advisory" | "lifecycle";
type BridgeHook = { script: string; path: string; on: string; tools?: string[]; scope: string; class: BridgeClass;
  interactive: boolean; timeoutMs: number };
type BridgeVerdict = { kind: "allow" } | { kind: "block"; reason: string } | { kind: "ask"; reason: string } | { kind: "warn"; text: string };
type BridgeOutcome = { code: number | null; signal: string | null; timedOut: boolean; failed: boolean; aborted: boolean;
  json: Record<string, unknown> | undefined; stderr: string };
type BridgeCall = { event: string; hookEvent: string; toolName?: string; toolCallId?: string; input?: unknown; cwd: string;
  sessionId: string; hasUI: boolean };
type BridgeResult = { block?: string; asks: string[]; warnings: string[] };
const BRIDGE_STDOUT_CAP = 65_536;
const BRIDGE_STDERR_HALF = 2_048;
const BRIDGE_ADVISORY_CAP = 1_024;
const BRIDGE_KILL_GRACE_MS = 2_000;
const BRIDGE_DRAIN_MS = 250;
const BRIDGE_RENDER_ACTION = "run navori render --apply with the current Navori CLI";
const BRIDGE_TOOL_NAMES: Record<string, string> = { bash: "Bash", edit: "Edit", write: "Write" };
// Tools the bridge guards: an unreadable or incompatible manifest blocks these (fail-closed), never the read-only ones.
const BRIDGE_GUARDED_TOOLS = new Set(["bash", "edit", "write"]);
const BRIDGE_JSON_KEYS = ["hookSpecificOutput", "systemMessage", "continue"];

/** First half and last half of text when it exceeds max, so a long diagnostic keeps both its cause and its end. */
function bridgeCap(text: string, max: number): string {
  const clean = text.trim();
  if (clean.length <= max) return clean;
  const half = Math.floor(max / 2);
  return clean.slice(0, half) + "\n...[truncated]...\n" + clean.slice(clean.length - half);
}

function bridgeHook(raw: unknown): BridgeHook | undefined {
  if (!isRecord(raw) || typeof raw.script !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(raw.script)) return undefined;
  // A shared hook copy, or a plugin script (spec 0048 D13); never a path that climbs out of .pi/navori.
  if (raw.path !== ".pi/navori/hooks/" + raw.script + ".sh"
    && !(typeof raw.path === "string" && /^\.pi\/navori\/scripts\/[A-Za-z0-9_][A-Za-z0-9_.\/-]*$/.test(raw.path) && !raw.path.includes(".."))) return undefined;
  if (typeof raw.on !== "string" || !["tool_call", "tool_result", "agent_before_settle", "session_shutdown"].includes(raw.on)) return undefined;
  if (typeof raw.scope !== "string" || !["parent", "child", "all"].includes(raw.scope)) return undefined;
  if (raw.class !== "enforced" && raw.class !== "advisory" && raw.class !== "lifecycle") return undefined;
  if (typeof raw.interactive !== "boolean" || typeof raw.timeoutMs !== "number" || !(raw.timeoutMs > 0)) return undefined;
  if (raw.tools !== undefined && !(Array.isArray(raw.tools) && raw.tools.every((tool: unknown) => typeof tool === "string"))) return undefined;
  return { script: raw.script, path: raw.path, on: raw.on, tools: raw.tools as string[] | undefined, scope: raw.scope,
    class: raw.class, interactive: raw.interactive, timeoutMs: raw.timeoutMs };
}

/** The bridge bindings from the project manifest; any doubt means the extension cannot evaluate (fail-closed for guarded tools). */
function bridgeManifest(cwd: string): { ok: true; hooks: BridgeHook[] } | { ok: false; reason: string } {
  const cannot = (why: string): { ok: false; reason: string } => ({ ok: false, reason: "Navori cannot evaluate its Pi controls (" + why + "); " + BRIDGE_RENDER_ACTION + "." });
  let manifest: unknown;
  try { manifest = JSON.parse(readFileSync(join(cwd, ".pi/navori.json"), "utf8")); }
  catch { return cannot("the manifest is missing or unreadable"); }
  if (!isRecord(manifest) || manifest.schemaVersion !== 2 || !Array.isArray(manifest.hooks)) return cannot("the manifest schema is not the one this extension reads");
  const hooks = manifest.hooks.map(bridgeHook);
  if (hooks.some((hook) => hook === undefined)) return cannot("a hook binding is malformed");
  return { ok: true, hooks: hooks as BridgeHook[] };
}

/** Bash for the bridge: the SDK default, never a project shellPath; the sh fallback and WSL bash are not accepted. */
function bridgeShell(): { ok: true; shell: string } | { ok: false; reason: string } {
  const action = "Install Git for Windows (or bash) and make sure bash is on PATH, then restart Pi.";
  try {
    if (typeof getShellConfig !== "function") return { ok: false, reason: "Pi does not expose its shell resolution. " + action };
    const shell = String(getShellConfig().shell);
    const name = shell.replace(/\\/g, "/").split("/").pop()!.toLowerCase();
    if ((name !== "bash" && name !== "bash.exe") || /windows[\\/](?:system32|sysnative)[\\/]bash\.exe$/i.test(shell)) {
      return { ok: false, reason: "Navori hooks need bash and Pi resolved " + shell + ". " + action };
    }
    return { ok: true, shell };
  } catch { return { ok: false, reason: "Pi found no bash to run Navori hooks. " + action }; }
}

/** Claude-shaped payload: the subset of fields the shared scripts read (spec 0048 D2). */
function bridgePayload(call: BridgeCall): string {
  const child = process.env.NAVORI_PI_CHILD_DEPTH ? true : false;
  const role = (process.env.NAVORI_PI_CHILD_ROLE ?? "").replace(/[^A-Za-z0-9_-]/g, "");
  const input = isRecord(call.input) ? call.input : {};
  const toolInput: Record<string, unknown> = {};
  if (typeof input.command === "string") toolInput.command = input.command;
  if (typeof input.path === "string") toolInput.file_path = input.path.replace(/^@/, "");
  if (call.toolName === "write" && typeof input.content === "string") toolInput.content = input.content;
  return JSON.stringify({
    hook_event_name: call.hookEvent,
    ...(call.toolName ? { tool_name: BRIDGE_TOOL_NAMES[call.toolName] ?? call.toolName, tool_input: toolInput } : {}),
    ...(call.toolCallId ? { tool_use_id: call.toolCallId } : {}),
    ...(call.hookEvent === "Stop" ? { stop_hook_active: false } : {}),
    cwd: call.cwd,
    ...(call.sessionId ? { session_id: call.sessionId } : {}),
    // "default" only where a human can answer an ask; everywhere else the scripts must decide by themselves.
    permission_mode: !child && call.hasUI ? "default" : "dontAsk",
    ...(child ? { agent_id: "pi-" + (role || "child"), agent_type: role || "child" } : {}),
  });
}

/** A stdout JSON verdict: the whole output, else the last line that is a JSON object; anything else is noise. */
function bridgeJson(text: string): Record<string, unknown> | undefined {
  const parse = (candidate: string): Record<string, unknown> | undefined => {
    if (!candidate.startsWith("{")) return undefined;
    try {
      const value: unknown = JSON.parse(candidate);
      return isRecord(value) && BRIDGE_JSON_KEYS.some((key) => key in value) ? value : undefined;
    } catch { return undefined; }
  };
  const whole = text.trim();
  const direct = parse(whole);
  if (direct) return direct;
  const lines = whole.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("{")).reverse();
  for (const line of lines) {
    const found = parse(line);
    if (found) return found;
  }
  return undefined;
}

/** Run one script under bash in its own process group; always resolves, never rejects. */
function runBridgeScript(shell: string, cwd: string, hook: BridgeHook, payload: string, signal: AbortSignal): Promise<BridgeOutcome> {
  return new Promise((resolve) => {
    const base = { code: null, signal: null, timedOut: false, failed: false, aborted: false, json: undefined, stderr: "" };
    // The model-visible bash must never inherit Pi's IPC descriptor (spec 0048 D6).
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.NODE_CHANNEL_FD;
    delete env.NODE_CHANNEL_SERIALIZATION_MODE;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell, [join(cwd, hook.path).replace(/\\/g, "/")], { cwd, env, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    } catch { resolve({ ...base, failed: true }); return; }
    let out = Buffer.alloc(0);
    let errHead = Buffer.alloc(0);
    let errTail = Buffer.alloc(0);
    let errTotal = 0;
    let timedOut = false;
    let aborted = false;
    let done = false;
    let exit: { code: number | null; signal: string | null } | undefined;
    let drain: ReturnType<typeof setTimeout> | undefined;
    const kill = (sig: NodeJS.Signals): void => {
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch { /* Process or group already exited. */ }
    };
    const stop = (): void => {
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), BRIDGE_KILL_GRACE_MS).unref();
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, hook.timeoutMs);
    const onAbort = (): void => { aborted = true; stop(); };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    const finish = (failed: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (drain) clearTimeout(drain);
      signal.removeEventListener("abort", onAbort);
      const stderr = errTotal <= BRIDGE_STDERR_HALF ? errHead.toString("utf8")
        : errTotal <= 2 * BRIDGE_STDERR_HALF ? errHead.toString("utf8") + errTail.subarray(errTail.length - (errTotal - BRIDGE_STDERR_HALF)).toString("utf8")
        : errHead.toString("utf8") + "\n...[truncated]...\n" + errTail.toString("utf8");
      resolve({ code: exit?.code ?? null, signal: exit?.signal ?? null, timedOut, failed, aborted,
        json: bridgeJson(out.toString("utf8")), stderr: stderr.trim() });
    };
    child.stdin!.on("error", () => {});
    child.stdin!.end(payload);
    child.stdout!.on("data", (chunk: Buffer) => {
      if (out.length < BRIDGE_STDOUT_CAP) out = Buffer.concat([out, chunk.subarray(0, BRIDGE_STDOUT_CAP - out.length)]);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      errTotal += chunk.length;
      if (errHead.length < BRIDGE_STDERR_HALF) errHead = Buffer.concat([errHead, chunk.subarray(0, BRIDGE_STDERR_HALF - errHead.length)]);
      errTail = Buffer.concat([errTail, chunk]);
      if (errTail.length > BRIDGE_STDERR_HALF) errTail = errTail.subarray(errTail.length - BRIDGE_STDERR_HALF);
    });
    child.on("error", () => finish(true));
    // A script that leaves a background process holding its pipes must not hang the call: wait briefly after exit.
    child.on("exit", (code: number | null, sig: string | null) => { exit = { code, signal: sig }; drain = setTimeout(() => finish(false), BRIDGE_DRAIN_MS); });
    child.on("close", (code: number | null, sig: string | null) => { exit ??= { code, signal: sig }; finish(false); });
  });
}

/** Map one script outcome to a verdict by the table in the module doc (never throws). */
function bridgeVerdict(hook: BridgeHook, outcome: BridgeOutcome): BridgeVerdict {
  if (hook.class === "lifecycle" || outcome.aborted) return { kind: "allow" };
  const enforced = hook.class === "enforced";
  const failure = outcome.failed ? "it could not be started"
    : outcome.timedOut ? "it timed out after " + hook.timeoutMs + " ms"
    : outcome.signal ? "it was killed by " + outcome.signal
    : outcome.code !== 0 && outcome.code !== 2 ? "it exited with " + outcome.code : undefined;
  if (failure) {
    return enforced ? { kind: "block", reason: "Navori " + hook.script + " could not evaluate this call (" + failure + "), so it is blocked."
      + (outcome.stderr ? " Details: " + outcome.stderr : "") } : { kind: "allow" };
  }
  const json = outcome.json;
  const out = json && isRecord(json.hookSpecificOutput) ? json.hookSpecificOutput : {};
  if (outcome.code === 2) {
    if (enforced) return { kind: "block", reason: outcome.stderr || "Navori " + hook.script + " blocked this call." };
    return outcome.stderr ? { kind: "warn", text: bridgeCap(outcome.stderr, BRIDGE_ADVISORY_CAP) } : { kind: "allow" };
  }
  if (!json) return { kind: "allow" };
  if (!enforced) {
    const text = typeof out.additionalContext === "string" ? out.additionalContext : typeof json.systemMessage === "string" ? json.systemMessage : "";
    return text.trim() ? { kind: "warn", text: bridgeCap(text, BRIDGE_ADVISORY_CAP) } : { kind: "allow" };
  }
  const reason = typeof out.permissionDecisionReason === "string" && out.permissionDecisionReason.trim()
    ? out.permissionDecisionReason : "Navori " + hook.script + " returned a decision without a reason.";
  if (json.continue === false || "updatedInput" in out || "updatedInput" in json ||
      (json.hookSpecificOutput !== undefined && !isRecord(json.hookSpecificOutput))) {
    return { kind: "block", reason: "Navori " + hook.script + " returned a control this extension cannot honor, so the call is blocked." };
  }
  const decision = out.permissionDecision;
  if (decision === undefined || decision === "allow") return { kind: "allow" };
  if (decision === "deny") return { kind: "block", reason };
  if (decision === "ask") return { kind: "ask", reason };
  return { kind: "block", reason: "Navori " + hook.script + " returned an unknown decision, so the call is blocked." };
}

/**
 * Run every matching script concurrently; the first enforced block wins and kills the rest. Asks are collected
 * so the caller resolves them with ONE confirmation; advisory warnings are returned, never thrown.
 */
async function runBridge(hooks: BridgeHook[], call: BridgeCall, signal: AbortSignal | undefined): Promise<BridgeResult> {
  const child = process.env.NAVORI_PI_CHILD_DEPTH ? true : false;
  const selected = hooks.filter((hook) => hook.on === call.event && (hook.scope === "all" || hook.scope === (child ? "child" : "parent"))
    && (hook.tools === undefined || (call.toolName !== undefined && hook.tools.includes(call.toolName))));
  const result: BridgeResult = { asks: [], warnings: [] };
  if (!selected.length) return result;
  const shell = bridgeShell();
  if (!shell.ok) {
    if (selected.some((hook) => hook.class === "enforced")) result.block = shell.reason;
    return result;
  }
  const stop = new AbortController();
  const outer = (): void => stop.abort();
  signal?.addEventListener("abort", outer, { once: true });
  if (signal?.aborted) outer();
  const payload = bridgePayload(call);
  try {
    await Promise.all(selected.map(async (hook) => {
      const verdict = bridgeVerdict(hook, await runBridgeScript(shell.shell, call.cwd, hook, payload, stop.signal));
      if (verdict.kind === "block" && result.block === undefined) { result.block = verdict.reason; stop.abort(); }
      else if (verdict.kind === "ask") result.asks.push(verdict.reason);
      else if (verdict.kind === "warn") result.warnings.push(verdict.text);
    }));
  } finally { signal?.removeEventListener("abort", outer); }
  return result;
}

/** Advisory text after a tool result: manifest or script trouble is silent by contract (spec 0048 R15). */
async function bridgeAdvisories(event: { toolName: string; toolCallId: string; input: unknown }, ctx: { cwd: string; hasUI?: boolean;
    sessionManager?: { getSessionId?: () => string } }): Promise<string[]> {
  const manifest = bridgeManifest(ctx.cwd);
  if (!manifest.ok) return [];
  try {
    const result = await runBridge(manifest.hooks, { event: "tool_result", hookEvent: "PostToolUse", toolName: event.toolName,
      toolCallId: event.toolCallId, input: event.input, cwd: ctx.cwd, sessionId: ctx.sessionManager?.getSessionId?.() ?? "", hasUI: ctx.hasUI === true }, undefined);
    return result.warnings;
  } catch { return []; }
}
`;
