import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { stripTypeScriptTypes } from "node:module";
import { PassThrough } from "node:stream";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NavoriConfigSchema } from "../../../lib/config/schema.ts";
import { ENGINE_CAPABILITIES } from "../../shared/engine-capabilities.ts";
import { renderPiEngine } from "../index.ts";
import { missingPiChildFlags } from "../runtime-version.ts";
import { PI_EXTENSION_SOURCE } from "../extension-source.ts";

type Role = "scout" | "implementer" | "reviewer" | "scribe";
interface Model {
  provider: string;
  id: string;
}
interface Child extends EventEmitter {
  pid: number;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
}
interface Tool {
  execute: (
    id: string,
    params: { role: string; task: string; feature?: string },
    signal: AbortSignal,
    onUpdate: () => void,
    context: {
      cwd: string;
      isProjectTrusted: () => boolean;
      model?: Model;
      modelRegistry?: object;
    },
  ) => Promise<{ content: Array<{ text: string }>; details: { role: string } }>;
}
type ToolHandler = (
  event: { toolName: string; input: unknown },
  ctx: { cwd: string },
) => Promise<{ block: boolean; reason: string } | undefined> | undefined;

const PARENT: Model = { provider: "openai-codex", id: "gpt-parent" };
const SECRET = "sk-test-secret-value";

interface Runtime {
  tool: Tool | undefined;
  handlers: Map<string, ToolHandler>;
  children: Array<{ args: string[]; child: Child }>;
  navori: string[][];
}

/** Loads the rendered extension against deterministic stubs: no Pi, no network, no credentials. */
function load(
  options: { version?: string; env?: Record<string, string>; handoff?: string } = {},
): Runtime {
  const children: Runtime["children"] = [];
  const navori: string[][] = [];
  const handlers = new Map<string, ToolHandler>();
  let tool: Tool | undefined;
  const spawn = (program: string, args: string[]): Child => {
    const child = Object.assign(new EventEmitter(), {
      pid: 321,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    if (program === "navori") {
      navori.push(args);
      child.stdout.write(JSON.stringify({ status: options.handoff ?? "ok", feature: args[2] }));
      setImmediate(() => child.emit("close", 0));
    } else {
      children.push({ args, child });
    }
    return child;
  };
  const modules: Record<string, unknown> = {
    "node:child_process": { spawn },
    "node:fs": { readFileSync },
    "node:path": { join },
    "@earendil-works/pi-ai": {
      Type: Object.fromEntries(
        ["Object", "Union", "Literal", "String", "Optional"].map((name) => [name, () => ({})]),
      ),
    },
    "@earendil-works/pi-coding-agent": {
      VERSION: options.version ?? "1.1.0",
      defineTool: (value: unknown) => value,
    },
  };
  const exports: Record<string, unknown> = {};
  const compiled = stripTypeScriptTypes(PI_EXTENSION_SOURCE)
    .replace(/^import \{ (.+) \} from "(.+)";$/gm, 'const { $1 } = require("$2");')
    .replace("export default function", "exports.default = function");
  runInNewContext(compiled, {
    exports,
    require: (id: string): unknown => modules[id],
    process: {
      env: { OPENAI_API_KEY: SECRET, ...options.env },
      platform: "win32",
      versions: { node: "22.19.0" },
      stderr: { write: () => true },
    },
    Buffer,
    setTimeout,
    clearTimeout,
  });
  (exports.default as (pi: unknown) => void)({
    on: (name: string, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
    registerTool: (value: Tool) => {
      tool = value;
    },
  });
  return { tool, handlers, children, navori };
}

const dirs: string[] = [];
function project(harness: Record<string, unknown> = { scribeOwnsMarkdown: true }): {
  dir: string;
  warnings: string[];
} {
  const dir = mkdtempSync(join(tmpdir(), "navori-pi-roles-"));
  dirs.push(dir);
  const { warnings } = renderPiEngine(
    dir,
    NavoriConfigSchema.parse({
      name: "pi-roles",
      preset: "custom",
      engines: ["pi"],
      branchBase: "main",
      qualityGate: { fast: "bun test", full: "bun test" },
      models: { scout: "haiku", codexMap: { haiku: "openai-codex/gpt-5" } },
      harness,
    }),
  );
  return { dir, warnings };
}

function run(
  rt: Runtime,
  dir: string,
  role: string,
  context: Partial<Parameters<Tool["execute"]>[4]> = {},
): ReturnType<Tool["execute"]> {
  return rt.tool!.execute(
    "c",
    { role, task: "Do the scoped work", feature: "pi_first" },
    new AbortController().signal,
    () => {},
    { cwd: dir, isProjectTrusted: () => true, model: PARENT, ...context },
  );
}

/** Dispatches a role, settles its child like Pi would and returns the dispatch result. */
async function dispatch(
  rt: Runtime,
  dir: string,
  role: string,
  context: Partial<Parameters<Tool["execute"]>[4]> = {},
): ReturnType<Tool["execute"]> {
  const before = rt.children.length;
  const pending = run(rt, dir, role, context);
  await vi.waitFor(() => expect(rt.children.length).toBeGreaterThan(before));
  const { child } = rt.children.at(-1)!;
  child.stdout.write(
    `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } })}\n${JSON.stringify({ type: "agent_settled" })}\n`,
  );
  child.emit("close", 0);
  return pending;
}

function flag(args: string[], name: string): string | undefined {
  return args[args.indexOf(name) + 1];
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Pi 1.1.0 `pi --help` excerpt, enough for the admitted child flags.
const HELP_1_1_0 = [
  '  --model <pattern>              Model pattern or ID (supports "provider/id")',
  "  --tools, -t <tools>            Comma-separated allowlist of tool names",
  "  --no-mcp                       Disable built-in MCP support",
].join("\n");

describe("Pi first-class roles", () => {
  // Covers: R1, R2
  it("native admission and incompatible runtime", async () => {
    const rows = ENGINE_CAPABILITIES.pi.runtimeAdmissions ?? [];
    const admitted = rows.filter((row) => row.decision === "admitted");
    expect(admitted.map((row) => row.capability)).toEqual([
      "child-mcp-off",
      "child-model-selection",
      "child-tool-allowlist",
    ]);
    for (const row of rows) {
      expect(row.source).toMatch(/Pi \d+\.\d+\.\d+/);
      expect(row.verifiedFrom).toMatch(/^\d+\.\d+\.\d+$/);
      expect(row.probe.length).toBeGreaterThan(0);
      expect(row.boundary.length).toBeGreaterThan(0);
    }
    // MCP in children is documented as NOT admitted, never as enforced.
    expect(rows.find((row) => row.capability === "child-mcp-grants")?.decision).toBe("deferred");

    expect(missingPiChildFlags(HELP_1_1_0)).toEqual([]);
    expect(missingPiChildFlags(HELP_1_1_0.replace("--no-mcp", "--no-mpc"))).toEqual(["--no-mcp"]);
    expect(missingPiChildFlags("")).toEqual(["--no-mcp", "--model", "--tools"]);

    // A runtime older than the probed version is diagnosed and never spawns a child.
    const { dir } = project();
    const old = load({ version: "0.87.1" });
    await expect(run(old, dir, "scout")).rejects.toThrow(
      /Pi 0\.87\.1 is not verified for Navori children: child-mcp-off \(verified from Pi 1\.1\.0\)/,
    );
    expect(old.children).toEqual([]);
  });

  // Covers: R3
  it("configured role cycle", async () => {
    const { dir } = project();
    const rt = load();
    const wanted: Record<Role, string> = {
      scout: "read,grep,find,ls,write",
      implementer: "read,grep,find,ls,bash,edit,write",
      reviewer: "read,grep,find,ls,bash,write",
      scribe: "read,grep,find,ls,bash,edit,write",
    };
    for (const role of ["scout", "implementer", "scribe", "reviewer"] as const) {
      const result = await dispatch(rt, dir, role);
      expect(result.details.role).toBe(role);
      const { args } = rt.children.at(-1)!;
      expect(args).toContain("--no-mcp");
      expect(flag(args, "--tools")).toBe(wanted[role]);
      expect(args.at(-1)).toContain(`# ${role[0]!.toUpperCase()}${role.slice(1)} Agent`);
    }
    // No orchestrator or broad default: only the configured core roles dispatch.
    for (const role of ["orchestrator", "auditor", "general-purpose"]) {
      await expect(run(rt, dir, role)).rejects.toThrow("Unsupported Navori Pi role");
    }
    expect(rt.children).toHaveLength(4);

    // A configured role that depends on MCP is explicitly unavailable, with an action.
    const path = join(dir, ".pi/agents/scout.md");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace('"write"]', '"write","mcp__engram__mem_search"]'),
    );
    await expect(run(rt, dir, "scout")).rejects.toThrow(
      /scout requires MCP tools \(mcp__engram__mem_search\) and is unavailable.*--no-mcp.*role file/,
    );
    expect(rt.children).toHaveLength(4);
  });

  // Covers: R17
  it("explicit model and exact parent inheritance", async () => {
    const { dir } = project();
    const rt = load();

    // Explicit role override wins over the parent's identity.
    await dispatch(rt, dir, "scout");
    expect(flag(rt.children.at(-1)!.args, "--model")).toBe("openai-codex/gpt-5");

    // No override: the parent's exact provider/model is passed even when it differs from any default.
    await dispatch(rt, dir, "implementer", { model: { provider: "anthropic", id: "claude-x" } });
    const { args } = rt.children.at(-1)!;
    expect(flag(args, "--model")).toBe("anthropic/claude-x");
    expect(args.join(" ")).not.toContain(SECRET); // credentials never travel in args

    // Missing identity is a diagnostic, never a silent fallback.
    await expect(run(rt, dir, "implementer", { model: undefined })).rejects.toThrow(
      /cannot determine the parent Pi model for role implementer/,
    );
    // An unavailable model is a diagnostic too.
    const registry = { getAvailable: () => [{ provider: "openai-codex", id: "gpt-other" }] };
    await expect(run(rt, dir, "implementer", { modelRegistry: registry })).rejects.toThrow(
      /Pi model openai-codex\/gpt-parent is not available for role implementer/,
    );
    await expect(run(rt, dir, "scout", { modelRegistry: registry })).rejects.toThrow(
      /openai-codex\/gpt-5 is not available/,
    );
    expect(rt.children).toHaveLength(2);
  });

  // Covers: R18, R6
  it("code and documentation reviewed together", async () => {
    const { dir } = project();
    const rt = load();
    await dispatch(rt, dir, "implementer");
    await dispatch(rt, dir, "scribe");
    await dispatch(rt, dir, "reviewer");

    // The scribe produces Markdown through its own role; handoff is validated before each consumer.
    expect(rt.navori.map((args) => args[args.indexOf("--for") + 1])).toEqual([
      "scribe",
      "orchestrator",
    ]);
    expect(rt.navori.every((args) => args[2] === "pi_first")).toBe(true);
    const scribe = rt.children[1]!.args;
    expect(scribe.at(-1)).toContain("sole author of the Markdown");
    expect(flag(scribe, "--tools")).toContain("write");

    // The implementer cannot write Markdown directly; the scribe's child is not blocked.
    const implementer = load({
      env: { NAVORI_PI_CHILD_DEPTH: "1", NAVORI_PI_CHILD_ROLE: "implementer" },
    });
    const block = await implementer.handlers.get("tool_call")!(
      { toolName: "write", input: { path: "docs/a.md" } },
      { cwd: dir },
    );
    expect(block).toMatchObject({ block: true });
    const asScribe = load({ env: { NAVORI_PI_CHILD_DEPTH: "1", NAVORI_PI_CHILD_ROLE: "scribe" } });
    expect(
      await asScribe.handlers.get("tool_call")!(
        { toolName: "write", input: { path: "docs/a.md" } },
        { cwd: dir },
      ),
    ).toBeUndefined();

    // An invalid handoff blocks the consumer before any child starts.
    const bad = load({ handoff: "invalid" });
    await expect(run(bad, dir, "scribe")).rejects.toThrow(
      "Navori handoff check did not pass; scribe blocked",
    );
    expect(bad.children).toEqual([]);

    // Forbidding Markdown without enabling its producer is diagnosed before the task starts.
    const broken = project({ scribeOwnsMarkdown: true, scribe: false });
    expect(broken.warnings.join("\n")).toMatch(/scribe role is disabled/);
    const nobody = load();
    await expect(run(nobody, broken.dir, "implementer")).rejects.toThrow(
      /scribe role is not enabled/,
    );
    expect(nobody.children).toEqual([]);

    // Without ownership the scribe is not admitted at all.
    const plain = project({ scribeOwnsMarkdown: false });
    await expect(run(load(), plain.dir, "scribe")).rejects.toThrow(
      /scribe is admitted only when harness.scribeOwnsMarkdown/,
    );
  });
});
