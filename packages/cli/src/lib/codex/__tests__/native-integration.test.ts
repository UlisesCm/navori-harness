import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  realpathSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import {
  runNativeIntegration,
  preflightNativeProfileProbe,
  runNativeProfileProbe as startNativeProfileProbe,
  PROFILE_PROBE_BOUNDS,
  summarizeNativeProfilePhase,
  readModelReportedProfileDiagnostic,
} from "../native-integration.ts";
import { NavoriConfigSchema } from "../../config/schema.ts";
import { renderManagedFile } from "../../../engines/shared/render-managed-file.ts";
import { getCoreRoot, readCliVersion } from "../../render/bundled-assets.ts";
import { injectManagedSection } from "../../render/marker.ts";
import { codexHookCommand } from "../../../engines/codex/hook-registrations.ts";
import { codexHookHash } from "../trust.ts";
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
const liveProcesses = new Set<ChildProcess>();
const liveRuns = new Set<ReturnType<typeof startNativeProfileProbe>>();

/** Keep ownership of asynchronous probes after a Vitest timeout so teardown cannot race their writes. */
function runNativeProfileProbe(target: string): ReturnType<typeof startNativeProfileProbe> {
  const run = startNativeProfileProbe(target);
  liveRuns.add(run);
  void run.then(
    () => liveRuns.delete(run),
    () => liveRuns.delete(run),
  );
  return run;
}
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
/** Stop only this test's owned processes and await asynchronous owner cleanup before deleting its target. */
async function drainLiveRuns(): Promise<void> {
  for (const child of liveProcesses) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
  await Promise.allSettled([...liveRuns]);
  await Promise.all(
    [...liveProcesses].map((child) => {
      if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
      return new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }),
  );
  liveProcesses.clear();
}
afterEach(async () => {
  vi.useRealTimers();
  await drainLiveRuns();
  vi.unstubAllEnvs();
  rmSync(cwd, { recursive: true, force: true });
});

/** Real subprocess/stdio fixture exercises the fixed owner and production hook without native inference or real credentials. */
async function liveOwnerFixture(
  mode = "valid",
  agentDefaults: Record<string, unknown> = {},
): Promise<string> {
  const native = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const state = await vi.importActual<typeof import("../../primitives/state-root.ts")>(
    "../../primitives/state-root.ts",
  );
  mocks.spawn.mockImplementation((...args: Parameters<typeof native.spawn>) => {
    const child = native.spawn(...args);
    liveProcesses.add(child);
    return child;
  });
  mocks.spawnSync.mockImplementation(native.spawnSync);
  mocks.root.mockImplementation(state.resolveStateRoot);
  cwd = realpathSync(cwd);
  native.spawnSync("git", ["init", "-q", cwd]);
  const commands = join(cwd, "commands");
  const auth = join(cwd, "auth-home");
  for (const path of [commands, auth, join(cwd, ".codex/agents"), join(cwd, ".codex/hooks")])
    mkdirSync(path, { recursive: true });
  writeFileSync(join(auth, "auth.json"), "{}", { mode: 0o600 });
  const config = NavoriConfigSchema.parse({
    name: "fixture",
    preset: "custom",
    engines: ["codex"],
    harness: {
      implementer: false,
      reviewer: false,
      scout: false,
      auditor: false,
      publisher: false,
      scribe: false,
    },
    models: { orchestrator: "opus", codexMap: { opus: "gpt-6.1-sol" } },
    effort: { orchestrator: "medium" },
  });
  writeFileSync(join(cwd, "navori.config.json"), JSON.stringify(config));
  writeFileSync(
    join(cwd, ".codex/config.toml"),
    injectManagedSection(
      "",
      "codex-config-base",
      'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "medium"\n[features]\nhooks = true\nmulti_agent = true\n',
      { source: "@navori/core", version: readCliVersion() },
      "shell",
    ).output + '\n[mcp_servers.target_only]\ncommand = "never-launch-target-mcp"\n',
  );
  writeFileSync(
    join(cwd, ".codex/agents/architect.toml"),
    '# navori:managed start id="architect-codex-base" hash="00000000" version="0.12.1" source="@navori/core"\nname = "architect"\ndescription = "Fixture inherited role"\ndeveloper_instructions = "No effects."\n',
  );
  writeFileSync(
    join(cwd, ".codex/agents/local.toml"),
    'name = "local"\ndescription = "Fixture pinned role"\ndeveloper_instructions = "No effects."\nmodel = "gpt-6.1-sol"\nmodel_reasoning_effort = "medium"\n',
  );
  writeFileSync(
    join(cwd, ".codex/hooks/model-advisor.sh"),
    renderManagedFile({
      assetPath: join(getCoreRoot(), "core-assets/hooks/model-advisor.sh"),
      existingContent: null,
      managedId: "model-advisor-base",
      meta: { source: "@navori/core", version: readCliVersion() },
      config,
      engine: "codex",
    }).content,
  );
  const hook = {
    script: "model-advisor",
    event: "PreToolUse",
    matcher: "^(Agent|spawn_agent)$",
    args: "codex-pretool-profile",
    timeout: 15,
    statusMessage: "navori: future child profile",
  };
  const command = codexHookCommand(hook);
  const hash = codexHookHash(hook, command);
  const trace = join(cwd, "trace");
  const script = join(commands, "rpc.cjs");
  writeFileSync(
    script,
    `
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const mode=${JSON.stringify(mode)},trace=${JSON.stringify(trace)};
const disabled=['shell_tool','apps','plugins','browser_use','computer_use','memories','request_permissions_tool','image_generation','skill_mcp_dependency_install','remote_plugin','worktrees'];
const emit=m=>process.stdout.write(JSON.stringify(m)+'\\n');
let phase=0;
const privateConfig=fs.readFileSync(path.join(process.env.CODEX_HOME,'config.toml'),'utf8');
const agentsSection=privateConfig.split('[agents]')[1]?.split('[')[0]??'';
const agentsEnabled=agentsSection.split(String.fromCharCode(10)).some(line=>line.split('=').map(part=>part.trim()).join('=')==='enabled=true');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);if(r.id===undefined)return;
 if(r.method==='turn/start')fs.appendFileSync(trace,JSON.stringify({schema:true,outputSchema:r.params.outputSchema,fixedMessage:r.params.input[0].text})+String.fromCharCode(10));
 fs.appendFileSync(trace,JSON.stringify({method:r.method,cwd:process.cwd()})+'\\n');
 let result={};
 if(r.method==='initialize')result={platformOs:'macos',userAgent:'codex/0.162.1'};
 if(r.method==='experimentalFeature/list')result={data:[...disabled.filter(n=>mode!=='unknown-key'||n!=='shell_tool').map(name=>({name,enabled:false,stage:'stable'})),...['hooks','multi_agent'].map(name=>({name,enabled:true,stage:'stable'}))],nextCursor:null};
 if(r.method==='config/read'){
   const agents={enabled:agentsEnabled,max_concurrent_threads_per_session:null,max_depth:null,default_subagent_model:null,default_subagent_reasoning_effort:null,job_max_runtime_seconds:null,interrupt_message:null,...${JSON.stringify(agentDefaults)}};
   if(mode==='agents-missing')delete agents.enabled;
   if(mode==='agents-false')agents.enabled=false;
   if(mode==='defaults')agents.default={model:'unknown'};
   result={config:{sandbox_mode:mode==='policy'?'danger-full-access':'read-only',approval_policy:'never',web_search:'disabled',features:Object.fromEntries(disabled.map(n=>[n,false])),mcp_servers:fs.readFileSync(path.join(process.cwd(),'.codex/config.toml'),'utf8').includes('mcp_servers')?{target_only:{command:'never-launch-target-mcp'}}:{},agents}};
   fs.appendFileSync(trace,JSON.stringify({loadedAgentsEnabled:agents.enabled??null})+String.fromCharCode(10));
 }
 if(r.method==='hooks/list')result={data:[{cwd:process.cwd(),errors:[],warnings:[],hooks:[{enabled:true,trustStatus:'trusted',source:'project',sourcePath:path.join(process.cwd(),'.codex/config.toml'),currentHash:mode==='hook'?'foreign':${JSON.stringify(hash)},eventName:'preToolUse',handlerType:'command',command:${JSON.stringify(command)}}]}]};
 if(r.method==='model/list'){
   result={data:[{id:'gpt-6.1-sol',model:'gpt-6.1-sol',supportedReasoningEfforts:[{reasoningEffort:'medium'},{reasoningEffort:'high'}]}],nextCursor:null};
   if(mode==='bytes')result.padding='x'.repeat(750000);
   if(mode==='frames')for(let i=0;i<2049;i++)emit({method:'unexpected/event',params:{}});
 }
 if(r.method==='thread/start')result={thread:{id:'native-main'},model:'gpt-6.1-sol',reasoningEffort:'medium',sandbox:{type:'readOnly',networkAccess:false},approvalPolicy:'never',approvalsReviewer:'user'};
 if(r.method==='turn/start')result={turn:{id:'turn-'+(++phase)}};
 emit({id:r.id,result});
 if(r.method!=='turn/start')return;
 if(mode==='timeout')return;
 if(mode==='self-report'){
   emit({method:'item/completed',params:{threadId:'native-main',turnId:'turn-'+phase,item:{type:'agentMessage',phase:'final_answer',text:JSON.stringify({outcome:'completed',reason:'none'})}}});
   emit({method:'turn/completed',params:{threadId:'native-main',turn:{status:'completed'}}});return;
 }
 const roles=JSON.parse(r.params.input[0].text.match(/agent_type in (\\[[^\\]]*\\])/)[1]);
 if(mode==='repeated-role'&&phase===1)roles[1]=roles[0];
 let deferred;
 for(const [index,role]of roles.entries()){
   const call='call-'+phase+'-'+index,child='child-'+phase+'-'+index;
   const input={agent_type:role,message:'PROFILE_PROBE_OK'};
   const hook=cp.spawnSync('/bin/bash',[path.join(process.cwd(),'.codex/hooks/model-advisor.sh'),'codex-pretool-profile'],{input:JSON.stringify({cwd:process.cwd(),session_id:'native-main',tool_use_id:call,tool_name:'spawn_agent',tool_input:input}),encoding:'utf8',timeout:12000,env:process.env});
   let wire;try{wire=JSON.parse(hook.stdout);}catch{wire={};}
   const output=wire.hookSpecificOutput;
   if(output?.permissionDecision!=='allow'){emit({method:'turn/completed',params:{threadId:'native-main',turn:{status:'failed'}}});return;}
   emit({method:'hook/completed',params:{threadId:'native-main',run:{id:'hook-'+call,source:'project',sourcePath:mode==='source'?'/foreign/config.toml':path.join(process.cwd(),'.codex/config.toml'),eventName:'preToolUse',handlerType:'command',executionMode:'sync',status:'completed',entries:output.additionalContext?[{kind:'context',text:output.additionalContext}]:[]}}});
   const updated=output.updatedInput;
   const text=fs.readFileSync(path.join(process.cwd(),'.codex/agents',role+'.toml'),'utf8');
   const model=text.match(/^model\\s*=\\s*"([^"]+)"/m)?.[1]??'gpt-6.1-sol';
   const effort=text.match(/^model_reasoning_effort\\s*=\\s*"([^"]+)"/m)?.[1]??'medium';
   emit({method:'thread/started',params:{thread:{id:child,parentThreadId:'native-main',agentRole:role}}});
   emit({method:'item/started',params:{threadId:'native-main',item:{type:'collabAgentToolCall',id:call,tool:'spawnAgent',senderThreadId:'native-main',receiverThreadIds:[child],status:'inProgress'}}});
   emit({method:'item/completed',params:{threadId:'native-main',item:{type:'collabAgentToolCall',id:call,tool:'spawnAgent',senderThreadId:'native-main',receiverThreadIds:[child],model:updated.model??null,reasoningEffort:updated.reasoning_effort??null,status:'completed'}}});
   emit({method:'item/started',params:{threadId:'native-main',item:{type:'subAgentActivity',id:'activity-'+call,kind:'started',agentThreadId:child,agentPath:'native-main/'+child,model,reasoningEffort:effort}}});
   const close={method:'item/completed',params:{threadId:mode==='foreign-close'?'foreign':'native-main',item:{type:'collabAgentToolCall',id:'close-'+call,tool:'closeAgent',status:'completed',senderThreadId:'native-main',receiverThreadIds:[child],agentsStates:{[child]:{status:'shutdown'}}}}};
   if(mode==='parallel'&&index===0)deferred=close;else if(mode!=='cleanup')emit(close);
 }
 if(deferred)emit(deferred);
 emit({method:'item/completed',params:{threadId:'native-main',turnId:'turn-'+phase,item:{type:'agentMessage',phase:'final_answer',text:JSON.stringify({outcome:'completed',reason:'none'})}}});
 if(mode==='changed-target')fs.appendFileSync(${JSON.stringify(join(cwd, ".codex/agents/local.toml"))},'\\n# changed during native observation\\n');
 emit({method:'turn/completed',params:{threadId:'native-main',turn:{status:'completed'}}});
});
`,
  );
  writeFileSync(
    join(commands, "codex"),
    `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`,
    { mode: 0o700 },
  );
  vi.stubEnv("PATH", `${commands}${delimiter}${process.env.PATH}`);
  vi.stubEnv("CODEX_HOME", auth);
  return trace;
}

describe("fixed live profile owner boundaries, no inference", () => {
  // Covers: R12, R13, R14, R16, R18
  it("rejects repeated authenticated roles despite matching dispatch, candidate and hook counts", async () => {
    await liveOwnerFixture("repeated-role");
    const result = await runNativeProfileProbe(cwd);
    expect(result).toMatchObject({
      status: "pending",
      principalTurnRequests: 1,
      children: [],
      refresh: "pending",
      pending: ["native-profile-selection-or-hook-call-unverified"],
    });
    expect(result.diagnostics[0]).toMatchObject({
      spawns: { attempted: 2, completed: 2, recognizedRoleReports: 2 },
      hooks: { validContexts: 2 },
      joinedCandidates: 2,
    });
  }, 20000);
  // Covers: R13, R16, R18
  it.each([null, "true"])(
    "rejects a non-boolean enabled control %s before a turn",
    async (enabled) => {
      const trace = await liveOwnerFixture("valid", { enabled });
      expect(await runNativeProfileProbe(cwd)).toMatchObject({
        status: "pending",
        principalTurnRequests: 0,
        cleanup: "acknowledged",
        pending: ["loaded-native-agents-enabled-unverified"],
      });
      expect(readFileSync(trace, "utf8")).not.toContain("turn/start");
    },
  );
  // Covers: R12, R13, R16, R18
  it.each([
    { default_subagent_model: "gpt-6.1-sol" },
    { default_subagent_reasoning_effort: "medium" },
    { default_subagent_model: {} },
    { unknown_default: null },
    { max_threads: 1 },
    { max_concurrent_threads_per_session: "1" },
    { max_depth: -1 },
    { job_max_runtime_seconds: 1.5 },
    { interrupt_message: "true" },
  ])(
    "rejects non-null selection defaults and malformed normalized native defaults %#",
    async (defaults) => {
      const trace = await liveOwnerFixture("valid", defaults);
      expect(await runNativeProfileProbe(cwd)).toMatchObject({
        status: "pending",
        principalTurnRequests: 0,
        cleanup: "acknowledged",
        pending: ["native-default-inheritance-unverified"],
      });
      expect(readFileSync(trace, "utf8")).not.toContain("turn/start");
    },
  );
  // Covers: R13, R16, R18
  it("accepts typed operational limits and interrupt control without allowing a prohibited sandbox", async () => {
    const trace = await liveOwnerFixture("policy", {
      max_concurrent_threads_per_session: 1,
      max_depth: 0,
      job_max_runtime_seconds: 30,
      interrupt_message: true,
    });
    expect(await runNativeProfileProbe(cwd)).toMatchObject({
      status: "pending",
      principalTurnRequests: 0,
      cleanup: "acknowledged",
      pending: ["loaded-native-restrictions-unverified"],
    });
    expect(readFileSync(trace, "utf8")).not.toContain("turn/start");
  });
  // Covers: R13, R16, R18
  it("parses only strict final reports from the exact parent and current turn without leaking content", () => {
    const event = (
      text: string,
      threadId = "parent",
      turnId = "current",
      phase = "final_answer",
    ) => ({
      method: "item/completed",
      params: { threadId, turnId, item: { type: "agentMessage", text, phase } },
    });
    const valid = JSON.stringify({ outcome: "blocked", reason: "workflow_prerequisite" });
    expect(readModelReportedProfileDiagnostic([event(valid)], "parent", "current")).toEqual({
      source: "model-reported",
      status: "available",
      outcome: "blocked",
      reason: "workflow_prerequisite",
    });
    for (const messages of [
      [],
      [event(valid, "foreign")],
      [event(valid, "parent", "old")],
      [event(valid, "parent", "current", "commentary")],
      [event("SECRET_BAD_JSON")],
      [event(JSON.stringify({ outcome: "blocked", reason: "SECRET_REASON" }))],
      [event(JSON.stringify({ outcome: "completed", reason: "none", secret: "SECRET_EXTRA" }))],
    ]) {
      expect(readModelReportedProfileDiagnostic(messages, "parent", "current")).toEqual({
        source: "model-reported",
        status: "unavailable",
      });
    }
    for (const messages of [
      [event(valid), event('{"outcome":"completed","reason":"none"}')],
      [event(valid), event("SECRET_BAD_JSON")],
    ]) {
      const result = readModelReportedProfileDiagnostic(messages, "parent", "current");
      expect(result).toEqual({ source: "model-reported", status: "ambiguous" });
      expect(JSON.stringify(result)).not.toContain("SECRET");
    }
    expect(readModelReportedProfileDiagnostic([event(valid)], "parent", null)).toEqual({
      source: "model-reported",
      status: "unavailable",
    });
  });
  // Covers: R13, R16, R18
  it("keeps a completed model self-report without native spawns pending", async () => {
    const trace = await liveOwnerFixture("self-report");
    const result = await runNativeProfileProbe(cwd);
    expect(result).toMatchObject({
      status: "pending",
      children: [],
      pending: ["native-profile-selection-or-hook-call-unverified"],
      diagnostics: [
        {
          modelReported: {
            source: "model-reported",
            status: "available",
            outcome: "completed",
            reason: "none",
          },
          joinedCandidates: 0,
          spawns: { attempted: 0, completed: 0 },
        },
      ],
    });
    expect(readFileSync(trace, "utf8").match(/turn\/start/g)).toHaveLength(1);
  });
  // Covers: R13, R16, R18
  it("reports only fixed diagnostic counts and redacts arbitrary native content", () => {
    const secret = "SECRET_PROMPT_TOKEN";
    const diagnostic = summarizeNativeProfilePhase(
      [
        { method: "thread/started", params: { thread: { id: "child", agentRole: "architect" } } },
        { method: "thread/started", params: { thread: { id: "foreign", agentRole: secret } } },
        {
          method: "item/started",
          params: {
            item: {
              type: "collabAgentToolCall",
              tool: "spawnAgent",
              id: "call",
              arguments: secret,
            },
          },
        },
        {
          method: "item/completed",
          params: {
            threadId: "parent",
            item: {
              type: "collabAgentToolCall",
              tool: "spawnAgent",
              status: "completed",
              id: "call",
              senderThreadId: "parent",
              receiverThreadIds: ["child"],
            },
          },
        },
        { method: "item/started", params: { item: { type: "subAgentActivity", text: secret } } },
        {
          method: "item/completed",
          params: { item: { type: "arbitrary-item", tool: "arbitrary-tool", message: secret } },
        },
        {
          method: "hook/completed",
          params: {
            threadId: "parent",
            run: {
              id: "hook",
              eventName: "preToolUse",
              handlerType: "command",
              status: "completed",
              source: "project",
              sourcePath: "/owned",
              entries: [{ kind: "context", text: secret }],
            },
          },
        },
        {
          method: "hook/completed",
          params: {
            run: {
              eventName: "preToolUse",
              handlerType: "command",
              status: secret,
              sourcePath: secret,
              error: secret,
            },
          },
        },
        { method: "arbitrary-method", params: { text: secret } },
      ],
      ["architect"],
      { sourcePath: "/owned", principal: "parent", joinedCandidates: 0, validContexts: 0 },
    );
    expect(diagnostic).toEqual({
      modelReported: { source: "model-reported", status: "unavailable" },
      items: { collabAgentToolCall: 2, subAgentActivity: 1, agentMessage: 0, other: 1 },
      spawns: {
        attempted: 1,
        completed: 1,
        recognizedRoleReports: 1,
        unknownRoleReports: 1,
        missingIdentity: 1,
      },
      activity: { missingIdentity: 1, missingSelection: 1 },
      hooks: {
        runs: 2,
        relevant: 2,
        sourceMatched: 1,
        completed: 1,
        failed: 0,
        otherStatus: 1,
        missingIdentity: 1,
        validContexts: 0,
        contextEntries: 1,
        missingContextRuns: 1,
      },
      joinedCandidates: 0,
    });
    const wire = JSON.stringify(diagnostic);
    for (const value of [
      secret,
      "arbitrary-item",
      "arbitrary-tool",
      "arbitrary-method",
      "architect",
      "/owned",
      "child",
    ])
      expect(wire).not.toContain(value);
  });
  // Covers: R13, R16, R18
  it("drains an interrupted asynchronous owner before test fixture deletion", async () => {
    const trace = await liveOwnerFixture("timeout");
    const run = runNativeProfileProbe(cwd);
    for (let count = 0; count < 200; count++) {
      if (existsSync(trace) && readFileSync(trace, "utf8").includes("turn/start")) break;
      await delay(10);
    }
    expect(readFileSync(trace, "utf8")).toContain("turn/start");
    await drainLiveRuns();
    expect(await run).toMatchObject({ status: "pending", cleanup: "unverified" });
    expect(liveRuns.size).toBe(0);
    rmSync(cwd, { recursive: true, force: true });
    await delay(30);
    expect(existsSync(cwd)).toBe(false);
  });
  // Covers: R13, R16, R18
  it("rejects an unknown native selection key before starting any fixture process", async () => {
    const trace = await liveOwnerFixture();
    const file = join(cwd, ".codex/config.toml");
    writeFileSync(file, 'unknown_selection_default = "unverified"\n' + readFileSync(file, "utf8"));
    expect(await runNativeProfileProbe(cwd)).toMatchObject({
      status: "pending",
      principalTurnRequests: 0,
      cleanup: "not-started",
    });
    expect(existsSync(trace)).toBe(false);
  });
  // Covers: R12, R13, R14, R15, R16, R18
  it("authenticates inherited and pinned children, refreshes a distinct next dispatch and rejects replay across new fixture paths", async () => {
    const trace = await liveOwnerFixture();
    const before = readFileSync(join(cwd, "navori.config.json"));
    const nativeBefore = readFileSync(join(cwd, ".codex/config.toml"));
    const result = await runNativeProfileProbe(cwd);
    expect(result, JSON.stringify(result)).toMatchObject({
      status: "completed",
      targetIntegration: false,
      consumed: true,
      principalTurnRequests: 2,
      refresh: "verified",
      cleanup: "acknowledged",
      pending: [],
    });
    expect(result.children).toHaveLength(2);
    expect(result.children.find((row) => row.nativeName === "architect")).toMatchObject({
      model: "gpt-6.1-sol",
      effort: "medium",
      intent: { model: { kind: "inherit" }, effort: { kind: "inherit" } },
    });
    expect(result.refreshChild).toMatchObject({ nativeName: "local", effort: "high" });
    expect(result.protocol.bytes).toBeGreaterThan(1000);
    expect(result.protocol.frames).toBeGreaterThan(20);
    expect(readFileSync(join(cwd, "navori.config.json"))).toEqual(before);
    expect(readFileSync(join(cwd, ".codex/config.toml"))).toEqual(nativeBefore);
    expect(nativeBefore.toString()).toContain("mcp_servers.target_only");
    expect(existsSync(result.execution!)).toBe(false);
    expect(readFileSync(join(cwd, "auth-home/auth.json"), "utf8")).toBe("{}");
    const recorded = readFileSync(trace, "utf8");
    const controls = recorded
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { loadedAgentsEnabled?: boolean | null })
      .filter((entry) => Object.hasOwn(entry, "loadedAgentsEnabled"));
    expect(controls.length).toBeGreaterThan(0);
    expect(controls.every((entry) => entry.loadedAgentsEnabled === true)).toBe(true);
    const turns = recorded
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as { schema?: boolean; outputSchema?: unknown; fixedMessage?: string },
      )
      .filter((entry) => entry.schema);
    expect(turns).toHaveLength(2);
    for (const turn of turns) {
      expect(turn.outputSchema).toEqual({
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
      });
      expect(turn.fixedMessage).toContain(
        "Return only the final JSON report required by outputSchema",
      );
    }
    expect(result.diagnostics.map((phase) => phase.modelReported)).toEqual(
      [0, 1].map(() => ({
        source: "model-reported",
        status: "available",
        outcome: "completed",
        reason: "none",
      })),
    );
    expect(await runNativeProfileProbe(cwd)).toMatchObject({
      status: "pending",
      consumed: false,
      pending: ["fixed-live-probe-attempt-already-consumed"],
    });
    expect(readFileSync(trace, "utf8")).toBe(recorded);
  }, 20000);
  // Covers: R13, R14, R16, R18
  it("admits a new relevant snapshot with a distinct fixture after a consumed refusal", async () => {
    await liveOwnerFixture("policy");
    const result = await runNativeProfileProbe(cwd);
    expect(result.status).toBe("pending");
    expect(result.consumed).toBe(true);
    const script = join(cwd, "commands/rpc.cjs");
    writeFileSync(
      script,
      readFileSync(script, "utf8").replace('const mode="policy"', 'const mode="valid"'),
    );
    writeFileSync(
      join(cwd, ".codex/agents/local.toml"),
      readFileSync(join(cwd, ".codex/agents/local.toml"), "utf8") + "\n# new relevant snapshot\n",
    );
    const changed = await runNativeProfileProbe(cwd);
    expect(changed.status, JSON.stringify(changed)).toBe("completed");
    expect(changed.identity).not.toBe(result.identity);
    expect(changed.execution).not.toBe(result.execution);
  }, 20000);
  // Covers: R13, R15, R16, R18
  it("ends a stalled attempt at the common deadline, retaining uncertain child cleanup and no retry", async () => {
    const trace = await liveOwnerFixture("timeout");
    vi.useFakeTimers();
    const run = runNativeProfileProbe(cwd);
    for (let count = 0; count < 200; count++) {
      if (existsSync(trace) && readFileSync(trace, "utf8").includes("turn/start")) break;
      await delay(10);
    }
    expect(readFileSync(trace, "utf8")).toContain("turn/start");
    await vi.advanceTimersByTimeAsync(PROFILE_PROBE_BOUNDS.wallTimeMs);
    await delay(30);
    const result = await run;
    expect(result).toMatchObject({
      status: "pending",
      consumed: true,
      principalTurnRequests: 1,
      cleanup: "unverified",
    });
    expect(result.pending).toContain("native-profile-connection-closed");
    expect(readFileSync(trace, "utf8").match(/turn\/start/g)).toHaveLength(1);
  });
  // Covers: R13, R14, R16, R18
  it.each([
    "unknown-key",
    "policy",
    "hook",
    "frames",
    "defaults",
    "agents-missing",
    "agents-false",
  ])(
    "refuses %s before a native turn and acknowledges its owned process exit",
    async (mode: string) => {
      const trace = await liveOwnerFixture(mode);
      const result = await runNativeProfileProbe(cwd);
      expect(result).toMatchObject({
        status: "pending",
        consumed: true,
        principalTurnRequests: 0,
        cleanup: "acknowledged",
      });
      expect(readFileSync(trace, "utf8")).not.toContain("turn/start");
      if (mode === "agents-missing" || mode === "agents-false")
        expect(result.pending).toContain("loaded-native-agents-enabled-unverified");
    },
  );
  // Covers: R12, R13, R14, R16, R18
  it.each(["source", "cleanup", "changed-target", "bytes", "parallel", "foreign-close"])(
    "keeps %s evidence pending without retrying inference",
    async (mode: string) => {
      const trace = await liveOwnerFixture(mode);
      const result = await runNativeProfileProbe(cwd);
      expect(result.status, JSON.stringify(result)).toBe("pending");
      expect(result.principalTurnRequests).toBeLessThanOrEqual(2);
      if (mode === "cleanup") expect(result.cleanup).toBe("unverified");
      if (mode === "source")
        expect(result.diagnostics[0]).toMatchObject({
          spawns: { attempted: 2, completed: 2, recognizedRoleReports: 2 },
          hooks: { relevant: 2, sourceMatched: 0, validContexts: 0 },
          joinedCandidates: 2,
        });
      if (mode === "parallel")
        expect(result.pending).toContain("unexpected-native-profile-dispatch");
      if (mode === "foreign-close")
        expect(result.pending).toContain("unexpected-native-child-control");
      if (mode === "changed-target") {
        expect(result.pending).toContain("target-profile-inputs-changed");
        expect(result.principalTurnRequests).toBe(1);
        expect(result.cleanup).toBe("acknowledged");
        expect(readFileSync(trace, "utf8").match(/turn\/start/g)).toHaveLength(1);
      }
      if (mode === "bytes") {
        expect(result.protocol.bytes).toBeGreaterThan(PROFILE_PROBE_BOUNDS.maxProtocolBytes);
        expect(result.pending).toContain("aggregate-protocol-budget-unverified-or-exceeded");
      }
    },
    15000,
  );
  // Covers: R12, R16, R18
  it.each(["override", "malformed", "duplicate"])(
    "does not reinterpret a %s native profile as inherited",
    async (mode: string) => {
      await liveOwnerFixture();
      const file = join(cwd, ".codex/agents/architect.toml");
      if (mode === "override")
        writeFileSync(file, readFileSync(file, "utf8") + '\nsandbox_mode = "danger-full-access"\n');
      if (mode === "malformed")
        writeFileSync(file, readFileSync(file, "utf8") + "\nmodel = true\n");
      if (mode === "duplicate")
        writeFileSync(
          join(cwd, ".codex/agents/local.toml"),
          readFileSync(file, "utf8").replace("architect-codex-base", "duplicate-codex-base"),
        );
      expect(await runNativeProfileProbe(cwd)).toMatchObject({
        status: "pending",
        consumed: false,
        principalTurnRequests: 0,
        cleanup: "not-started",
      });
    },
  );
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
