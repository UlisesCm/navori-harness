import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { PI_EXTENSION_SOURCE } from "../extension-source.ts";

interface Tool {
  execute: (
    id: string,
    params: { role: string; task: string; feature?: string },
    signal: AbortSignal,
    onUpdate: () => void,
    context: { cwd: string; isProjectTrusted: () => boolean; model: object },
  ) => Promise<{ details: { role: string } }>;
}
interface Spawned {
  args: string[];
  child: FakeChild;
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A child process stand-in that only exposes what the extension touches. */
class FakeChild extends EventEmitter {
  readonly pid = 1;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  kill = vi.fn();
}

/** Loads the rendered extension against stubs: no Pi, no MCP server, no credentials. */
function load(): { tool: Tool; children: Spawned[] } {
  const children: Spawned[] = [];
  let registered: Tool | undefined;
  const sandbox = {
    exports: {} as { default?: (pi: unknown) => void },
    require: (id: string): unknown => {
      if (id === "node:child_process") {
        return {
          spawn: (program: string, args: string[]): FakeChild => {
            const child = new FakeChild();
            if (program !== "navori") children.push({ args, child });
            else {
              // The handoff preflight answers ok immediately; only `pi` spawns are recorded.
              child.stdout.write(JSON.stringify({ status: "ok", feature: args[2] }));
              setImmediate(() => child.emit("close", 0));
            }
            return child;
          },
        };
      }
      if (id === "@earendil-works/pi-ai") return { Type: new Proxy({}, { get: () => () => ({}) }) };
      if (id === "@earendil-works/pi-coding-agent") {
        return { VERSION: "1.1.0", defineTool: (value: unknown) => value };
      }
      return id === "node:path" ? { join } : { readFileSync };
    },
    process: {
      env: {},
      platform: "win32",
      versions: { node: "22.19.0" },
      stderr: { write: () => true },
    },
    Buffer,
    setTimeout,
    clearTimeout,
  };
  runInNewContext(
    stripTypeScriptTypes(PI_EXTENSION_SOURCE)
      .replace(/^import \{ (.+) \} from "(.+)";$/gm, 'const { $1 } = require("$2");')
      .replace("export default function", "exports.default = function"),
    sandbox,
  );
  sandbox.exports.default?.({
    on: () => {},
    registerTool: (value: Tool) => {
      registered = value;
    },
  });
  return { tool: registered!, children };
}

function run(tool: Tool, dir: string, role: string): ReturnType<Tool["execute"]> {
  return tool.execute(
    "c",
    { role, task: "Do the scoped work", feature: "pi_first" },
    new AbortController().signal,
    () => {},
    { cwd: dir, isProjectTrusted: () => true, model: { provider: "p", id: "m" } },
  );
}

describe("Pi MCP in children", () => {
  // Covers: R10
  it("native MCP role grants include indirect access", async () => {
    const dir = mkdtempSync(join(tmpdir(), "navori-pi-plugins-"));
    dirs.push(dir);
    const agentDir = mkdtempSync(join(tmpdir(), "navori-pi-plugins-home-"));
    dirs.push(agentDir);
    mkdirSync(join(dir, ".pi"));
    const fixtures = new Map<string, string>([
      [join(dir, ".pi/mcp.json"), '{"mcpServers":{"project":{"command":"fixture"}}}\n'],
      [join(dir, ".pi/auth.json"), '{"fake":"project-auth-sentinel"}\n'],
      [join(agentDir, "mcp.json"), '{"mcpServers":{"parent":{"command":"personal"}}}\n'],
      [join(agentDir, "auth.json"), '{"fake":"global-auth-sentinel"}\n'],
    ]);
    for (const [path, content] of fixtures) writeFileSync(path, content);

    // An enabled MCP plugin injecting prose into Pi roles is diagnosed at render time.
    const { warnings } = renderPiEngine(
      dir,
      NavoriConfigSchema.parse({
        name: "pi-plugins",
        preset: "custom",
        engines: ["pi"],
        branchBase: "main",
        qualityGate: { fast: "bun test", full: "bun test" },
        plugins: { engram: { enabled: true } },
      }),
    );
    for (const role of ["implementer", "reviewer"]) {
      expect(warnings).toContainEqual(
        expect.stringMatching(
          new RegExp(
            `Pi role ${role} needs MCP tools from plugin engram \\(mcp__engram__mem_search.*unavailable.*--no-mcp.*direct, discovery and codemode`,
          ),
        ),
      );
    }
    // The orchestrator is not a Pi child role: no false diagnostic for it.
    expect(warnings.some((w) => w.includes("Pi role orchestrator"))).toBe(false);

    // Every child carries --no-mcp, allowlisted or not: --tools alone does not remove MCP.
    const { tool, children } = load();
    for (const role of ["scout", "implementer", "reviewer"]) {
      const pending = run(tool, dir, role);
      await vi.waitFor(() => expect(children.length).toBeGreaterThan(0));
      const { args, child } = children.at(-1)!;
      expect(args).toContain("--no-mcp");
      expect(args).toContain("--tools");
      child.stdout.write(`${JSON.stringify({ type: "agent_settled" })}\n`);
      child.emit("close", 0);
      await pending;
      children.length = 0;
    }

    // A role asking for direct, discovery or codemode MCP access is rejected before spawning.
    const path = join(dir, ".pi/agents/scout.md");
    for (const wanted of ["mcp__engram__mem_search", "mcp__engram__*", "codemode"]) {
      writeFileSync(path, readFileSync(path, "utf8").replace('"write"]', `"write","${wanted}"]`));
      await expect(run(tool, dir, "scout")).rejects.toThrow(
        wanted === "codemode"
          ? /Unknown or missing Pi role tool mapping: scout/
          : /scout requires MCP tools .* is unavailable.*--no-mcp/,
      );
      writeFileSync(path, readFileSync(path, "utf8").replace(`,"${wanted}"]`, "]"));
    }
    expect(children).toEqual([]);

    // User MCP config and credentials stay byte-for-byte; the grant stays deferred with a reason.
    for (const [file, content] of fixtures) expect(readFileSync(file, "utf8")).toBe(content);
    const grants = ENGINE_CAPABILITIES.pi.runtimeAdmissions?.find(
      (row) => row.capability === "child-mcp-grants",
    );
    expect(grants).toMatchObject({ decision: "deferred" });
    expect(grants?.probe).toMatch(/connects every enabled MCP server/);
  });
});
