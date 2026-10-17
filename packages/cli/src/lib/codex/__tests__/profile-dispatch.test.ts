import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import {
  prepareCodexProfile,
  claimCodexProfile,
  consumeCodexProfileHook,
} from "../profile-dispatch.ts";
import {
  queryNativeCatalog,
  isOwnedNativeCatalog,
  preflightNativeProfileProbe,
} from "../native-integration.ts";

let directory: string;
let cwd: string;
let commands: string;
const input = { name: "orchestrator", action: "new-task" };
const modulePath = fileURLToPath(new URL("../profile-dispatch.ts", import.meta.url));

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "navori-fresh-profile-")));
  cwd = join(directory, "project");
  commands = join(directory, "commands");
  mkdirSync(cwd);
  mkdirSync(commands);
  execFileSync("git", ["init", "-q"], { cwd });
  writeFileSync(join(cwd, ".gitignore"), ".navori/\n");
  writeFileSync(
    join(cwd, "navori.config.json"),
    JSON.stringify({
      name: "fixture",
      preset: "custom",
      engines: ["codex"],
      harness: { codexIntegration: true },
      models: { orchestrator: "opus", codexMap: { opus: "gpt-6.1-sol" } },
      effort: { orchestrator: "medium" },
    }),
  );
  const script = join(commands, "rpc.cjs");
  writeFileSync(
    script,
    `const readline=require('node:readline');readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return;const result=r.method==='initialize'?{platformOs:'macos',userAgent:'codex/0.162.1'}:{data:[{id:'gpt-6.1-sol',model:'gpt-6.1-sol',supportedReasoningEfforts:[{reasoningEffort:'medium'}]}],nextCursor:null};process.stdout.write(JSON.stringify({id:r.id,result})+'\\n');});`,
  );
  writeFileSync(join(commands, "codex"), `#!/bin/sh\nexec '${process.execPath}' '${script}'\n`, {
    mode: 0o755,
  });
  vi.stubEnv("PATH", `${commands}${delimiter}${process.env.PATH}`);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

/** Real separate processes race the production exclusive file claimant against the same fixed RPC fixture. */
function claimProcess(id: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const code = `import {claimCodexProfile} from ${JSON.stringify(modulePath)};try{await claimCodexProfile(${JSON.stringify(cwd)},${JSON.stringify(id)},${JSON.stringify(input)});}catch{process.exitCode=1;}`;
    const child = spawn("bun", ["-e", code], { cwd, env: process.env, stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", resolve);
  });
}

/** Real owned pipes/processes exercise fixed preflight only; this fixture never performs native inference. */
function fixedProbeFixture(mode = "valid", count = 1): string {
  const config = JSON.parse(readFileSync(join(cwd, "navori.config.json"), "utf8")) as {
    harness: Record<string, boolean>;
    models: Record<string, unknown>;
    effort: Record<string, unknown>;
  };
  for (const role of ["implementer", "reviewer", "scout", "auditor", "publisher", "scribe"])
    config.harness[role] = false;
  config.models.architect = "opus";
  config.effort.architect = "medium";
  writeFileSync(join(cwd, "navori.config.json"), JSON.stringify(config));
  mkdirSync(join(cwd, ".codex/agents"), { recursive: true });
  for (let index = 0; index < count; index++)
    writeFileSync(
      join(cwd, `.codex/agents/local${index}.toml`),
      `name = "local${index}"\nmodel = "gpt-6.1-sol"\nmodel_reasoning_effort = "medium"\n`,
    );
  const trace = join(directory, "probe-methods");
  writeFileSync(
    join(commands, "rpc.cjs"),
    `
const fs=require('node:fs'); const mode=${JSON.stringify(mode)};
const confined=process.argv.includes('mcp_servers.fixture.enabled=false');
fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({argv:process.argv.slice(2)})+'\\n');
let initialized=false;
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line); if(r.id===undefined)return;
 fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({method:r.method})+'\\n');
 let result={};
 if(r.method==='initialize'){if(initialized){process.stdout.write(JSON.stringify({id:r.id,error:{message:'duplicate-initialize'}})+'\\n');return;} initialized=true;result={platformOs:'macos',userAgent:'codex/0.162.1'};}
 if(r.method==='config/read')result={config:{features:{plugins:false,apps:false},browser_use:{default_origin_policy:{access:mode==='policy'?'allow':'deny'}},computer_use:{default_app_access:'deny'},mcp_servers:{fixture:{enabled:!confined}}}};
 if(r.method==='model/list')result={data:[{id:'gpt-6.1-sol',model:'gpt-6.1-sol',supportedReasoningEfforts:[{reasoningEffort:'medium'}]}],nextCursor:null};
 if(mode==='bytes'&&['config/read','model/list'].includes(r.method))result.padding='x'.repeat(750*1024);
 if(mode==='events'&&r.method==='model/list')for(let i=0;i<2049;i++)process.stdout.write(JSON.stringify({method:'unexpected/event',params:{}})+'\\n');
 process.stdout.write(JSON.stringify({id:r.id,result})+'\\n');
});`,
  );
  writeFileSync(
    join(commands, "codex"),
    `#!/bin/sh\nexec '${process.execPath}' '${join(commands, "rpc.cjs")}' "$@"\n`,
    { mode: 0o755 },
  );
  return trace;
}

describe("fixed profile preflight refuses unsupported native constraints", () => {
  // Covers: R13, R14, R16, R18
  it("binds current native inputs and consumes the whole scenario, without granting hook source or starting a turn", async () => {
    const trace = fixedProbeFixture();
    const result = await preflightNativeProfileProbe(cwd);
    expect(result).toMatchObject({
      status: "pending",
      consumed: true,
      loadedConfinement: "verified-config-only",
      cleanup: "acknowledged-owned-exit",
      roles: ["architect", "local0"],
      principalTurnsStarted: 0,
      childTurnsStarted: 0,
    });
    expect(result.pending).toContain("native-pre-effect-whole-attempt-role-turn-rule-unavailable");
    expect(result.pending).toContain("native-hook-run-per-call-source-correlation-unavailable");
    expect(result.inventory).toMatch(/^[a-f0-9]{64}$/);
    const before = readFileSync(trace, "utf8");
    expect(before).toContain("mcp_servers.fixture.enabled=false");
    expect(before).not.toContain("hooks.enabled=false");
    expect(before).not.toContain("turn/start");
    expect(before).not.toContain("thread/start");
    expect(before).not.toContain("thread/read");
    expect(await preflightNativeProfileProbe(cwd)).toMatchObject({
      consumed: false,
      cleanup: "not-started",
      pending: ["fixed-probe-attempt-already-consumed"],
    });
    expect(readFileSync(trace, "utf8")).toBe(before);
  });
  // Covers: R13, R16, R18
  it.each(["policy", "bytes", "events", "roles"])(
    "rejects %s before any principal or child inference and acknowledges actual exit",
    async (mode: string) => {
      const trace = fixedProbeFixture(mode, mode === "roles" ? 13 : 1);
      const result = await preflightNativeProfileProbe(cwd);
      expect(result).toMatchObject({
        status: "pending",
        consumed: true,
        principalTurnsStarted: 0,
        childTurnsStarted: 0,
        cleanup: "acknowledged-owned-exit",
      });
      expect(result.pending.length).toBeGreaterThan(0);
      if (mode === "policy")
        expect(result.pending).toContain("loaded-native-confinement-unverified");
      if (mode === "roles")
        expect(result.pending).toContain("enabled-role-count-outside-fixed-probe-bounds");
      expect(readFileSync(trace, "utf8")).not.toContain("turn/start");
      expect(readFileSync(trace, "utf8")).not.toContain("thread/start");
    },
  );
  // Covers: R13, R18
  it("opt-out starts no process and consumes no scenario", async () => {
    const trace = fixedProbeFixture();
    const path = join(cwd, "navori.config.json");
    const config = JSON.parse(readFileSync(path, "utf8")) as {
      harness: { codexIntegration: boolean };
    };
    config.harness.codexIntegration = false;
    writeFileSync(path, JSON.stringify(config));
    expect(await preflightNativeProfileProbe(cwd)).toMatchObject({
      consumed: false,
      cleanup: "not-started",
      pending: ["project-opt-in-required"],
    });
    expect(() => readFileSync(trace)).toThrow();
  });
});

describe("fresh metadata prepare/claim", () => {
  // Covers: R13, R14, R16, R18
  it("rewrites only the requested pair and burns the call despite another UUID/action/role", async () => {
    mkdirSync(join(cwd, ".codex/agents"), { recursive: true });
    writeFileSync(
      join(cwd, ".codex/agents/local.toml"),
      'name = "local"\nmodel = "gpt-6.1-sol"\nmodel_reasoning_effort = "medium"\n',
    );
    const payload = {
      cwd,
      session_id: "session",
      tool_use_id: "call",
      tool_name: "spawn_agent",
      tool_input: {
        agent_type: "local",
        message: { encrypted: "opaque", values: [null, "ñ"] },
        model: "old",
        reasoning_effort: "low",
        other: false,
      },
    };
    expect(await consumeCodexProfileHook(payload)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { ...payload.tool_input, model: "gpt-6.1-sol", reasoning_effort: "medium" },
      },
    });
    expect(
      await consumeCodexProfileHook({
        ...payload,
        preparation: "new-uuid",
        tool_input: { agent_type: "reviewer", message: "changed" },
      }),
    ).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  });
  // Covers: R13, R18
  it("no opt-in performs no query/attempt; malformed role remains consumed after repair", async () => {
    const path = join(cwd, "navori.config.json");
    const config = JSON.parse(readFileSync(path, "utf8")) as {
      harness: { codexIntegration: boolean };
    };
    config.harness.codexIntegration = false;
    writeFileSync(path, JSON.stringify(config));
    const payload = {
      cwd,
      session_id: "session",
      tool_use_id: "call",
      tool_name: "Agent",
      tool_input: {},
    };
    expect(await consumeCodexProfileHook(payload)).toEqual({});
    config.harness.codexIntegration = true;
    writeFileSync(path, JSON.stringify(config));
    expect(await consumeCodexProfileHook(payload)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(
      await consumeCodexProfileHook({ ...payload, tool_input: { agent_type: "reviewer" } }),
    ).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  });
  // Covers: R13, R15, R18
  it("total slow catalog deadline closes the owned native child", async () => {
    const marker = join(directory, "native-pid");
    writeFileSync(
      join(commands, "rpc.cjs"),
      `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);`,
    );
    const start = Date.now();
    await expect(queryNativeCatalog(cwd, start + 500)).rejects.toThrow("unavailable-or-incomplete");
    expect(Date.now() - start).toBeLessThan(1200);
    const pid = Number(readFileSync(marker, "utf8"));
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), {
      timeout: 2_000,
      interval: 10,
    });
  });
  // Covers: R13, R14, R15
  it("catalog-refresh-next-session-and-dispatch retains query/source/time/context without future freshness", async () => {
    const a = await queryNativeCatalog(cwd);
    const b = await queryNativeCatalog(cwd);
    expect(a.connection).not.toBe(b.connection);
    expect(a.queries[0]).toMatch(/^request:model\/list:/);
    expect(a).not.toHaveProperty("validUntil");
    expect(isOwnedNativeCatalog(a)).toBe(true);
    expect(isOwnedNativeCatalog(JSON.parse(JSON.stringify(a)) as typeof a)).toBe(false);
    const preparation = await prepareCodexProfile(cwd, input);
    expect(preparation.application).toBe("pending");
    expect(await claimCodexProfile(cwd, preparation.id, input)).toEqual(preparation);
  });
  // Covers: R13
  it("same-record-two-consumers has exactly one atomic winner", async () => {
    const preparation = await prepareCodexProfile(cwd, input);
    const results = await Promise.all([claimProcess(preparation.id), claimProcess(preparation.id)]);
    expect(results.sort()).toEqual([0, 1]);
  });
  // Covers: R13, R16
  it("cross-role-action-rejected and changed current inputs cannot burn the original metadata claim", async () => {
    const preparation = await prepareCodexProfile(cwd, input);
    await expect(
      claimCodexProfile(cwd, preparation.id, { ...input, name: "reviewer" }),
    ).rejects.toThrow("cross-checkout-role-or-action");
    await expect(
      claimCodexProfile(cwd, preparation.id, { ...input, action: "another" }),
    ).rejects.toThrow("cross-checkout-role-or-action");
    writeFileSync(join(cwd, "new-input.ts"), "export const changed=true;\n");
    await expect(claimCodexProfile(cwd, preparation.id, input)).rejects.toThrow("stale");
  });
  // Covers: R12, R13, R16, R18
  it("no-inflight-change and host-cannot-apply-pending preserve project config and never imply dispatch", async () => {
    const config = readFileSync(join(cwd, "navori.config.json"));
    const preparation = await prepareCodexProfile(cwd, input);
    expect(readFileSync(join(cwd, "navori.config.json"))).toEqual(config);
    expect(preparation.reason).toContain("native-context-closed");
    await expect(prepareCodexProfile(cwd, { ...input, name: "missing" })).rejects.toThrow(
      "profile-missing",
    );
  });
});
