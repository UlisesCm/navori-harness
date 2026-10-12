import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
import { rolePluginProse } from "../plugin-projection.ts";
import type { LoadedPlugin } from "../../../lib/config/plugins.ts";
import { PI_EXTENSION_SOURCE, renderPiExtensionSource } from "../extension-source.ts";

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

describe("Pi MCP server diagnosis", () => {
  const SECRET = "sk-secret-sentinel";

  /** Renders with the engram plugin against the given Pi MCP config files; returns MCP warnings. */
  function diagnose(
    globalJson?: string,
    projectJson?: string,
  ): { warnings: string[]; files: string[] } {
    const dir = mkdtempSync(join(tmpdir(), "navori-pi-mcp-"));
    const agentDir = mkdtempSync(join(tmpdir(), "navori-pi-mcp-home-"));
    dirs.push(dir, agentDir);
    mkdirSync(join(dir, ".pi"));
    const files: string[] = [];
    if (globalJson !== undefined) writeFileSync(join(agentDir, "mcp.json"), globalJson);
    if (projectJson !== undefined) writeFileSync(join(dir, ".pi/mcp.json"), projectJson);
    for (const f of [join(agentDir, "mcp.json"), join(dir, ".pi/mcp.json")]) {
      try {
        files.push(readFileSync(f, "utf8"));
      } catch {
        files.push("");
      }
    }
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      const { warnings } = renderPiEngine(
        dir,
        NavoriConfigSchema.parse({
          name: "pi-mcp",
          preset: "custom",
          engines: ["pi"],
          branchBase: "main",
          qualityGate: { fast: "bun test", full: "bun test" },
          plugins: { engram: { enabled: true } },
        }),
      );
      const mcp = warnings.filter((w) => /Pi MCP server|Could not read/.test(w));
      // The files are never rewritten.
      expect(files).toEqual([globalJson ?? "", projectJson ?? ""]);
      return { warnings: mcp, files };
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  }

  // Covers: R13
  it("missing mcp server diagnosed without echo", () => {
    const { warnings } = diagnose(
      `{"mcpServers":{"other":{"command":"x","env":{"TOKEN":"${SECRET}"}}}}`,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/engram.*not configured.*pi mcp add engram \[-l\] -- <command>/);
    expect(warnings[0]).not.toContain(SECRET);
    expect(warnings[0]).not.toContain("other");
  });

  // Covers: R13
  it("a configured and enabled server passes, with - and _ equivalent", () => {
    expect(diagnose('{"mcpServers":{"engram":{"command":"x"}}}').warnings).toEqual([]);
    expect(diagnose('{"mcpServers":{"engram":{"command":"x","enabled":true}}}').warnings).toEqual(
      [],
    );
  });

  // Covers: R13
  it("a disabled server is flagged", () => {
    const { warnings } = diagnose(
      `{"mcpServers":{"engram":{"command":"x","enabled":false,"env":{"T":"${SECRET}"}}}}`,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/is disabled.*pi mcp add engram/);
    expect(warnings[0]).not.toContain(SECRET);
  });

  // Covers: R13
  it("a server only in the project file is effective only if trusted", () => {
    const { warnings } = diagnose(undefined, '{"mcpServers":{"engram":{"command":"x"}}}');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/only in \.pi\/mcp\.json.*\/trust/);
  });

  // Covers: R13
  it("malformed json is handled without a crash or echo", () => {
    const { warnings } = diagnose(`{"mcpServers": {"engram": ${SECRET} oops`);
    expect(warnings.some((w) => /Could not read .*mcp\.json; check its JSON\./.test(w))).toBe(true);
    expect(warnings.join("\n")).not.toContain(SECRET);
    expect(warnings.some((w) => w.includes("pi mcp add engram"))).toBe(true);
  });
});

describe("Pi MCP check at session start", () => {
  const SECRET = "mcp-runtime-secret-sentinel";

  /** Runs every `session_start` handler of the parent extension and returns the notices shown. */
  async function sessionStart(opts: {
    projectJson?: string;
    trusted: boolean;
    throwOnTrust?: boolean;
    child?: boolean;
  }): Promise<string[]> {
    const dir = mkdtempSync(join(tmpdir(), "navori-pi-mcp-rt-"));
    const agentDir = mkdtempSync(join(tmpdir(), "navori-pi-mcp-rt-home-"));
    dirs.push(dir, agentDir);
    mkdirSync(join(dir, ".pi"));
    if (opts.projectJson !== undefined) writeFileSync(join(dir, ".pi/mcp.json"), opts.projectJson);
    const handlers: Array<(event: unknown, ctx: unknown) => Promise<void> | void> = [];
    const notices: string[] = [];
    const sandbox = {
      exports: {} as { default?: (pi: unknown) => void },
      require: (id: string): unknown => {
        if (id === "node:child_process") {
          // The context injector's `navori` call fails fast; it is irrelevant here.
          return {
            spawn: (): FakeChild => {
              const child = new FakeChild();
              setImmediate(() => child.emit("close", 1));
              return child;
            },
          };
        }
        if (id === "@earendil-works/pi-ai")
          return { Type: new Proxy({}, { get: () => () => ({}) }) };
        if (id === "@earendil-works/pi-coding-agent") {
          return { VERSION: "1.1.0", defineTool: (value: unknown) => value };
        }
        return id === "node:path"
          ? { join }
          : { readFileSync, existsSync, appendFileSync, lstatSync, readlinkSync };
      },
      process: {
        env: {
          PI_CODING_AGENT_DIR: agentDir,
          ...(opts.child ? { NAVORI_PI_CHILD_DEPTH: "1" } : {}),
        },
        platform: "linux",
        versions: { node: "22.19.0" },
        stderr: { write: () => true },
      },
      Buffer,
      setTimeout,
      clearTimeout,
    };
    runInNewContext(
      stripTypeScriptTypes(renderPiExtensionSource(["engram"]))
        .replace(/^import \{ (.+) \} from "(.+)";$/gm, 'const { $1 } = require("$2");')
        .replace("export default function", "exports.default = function"),
      sandbox,
    );
    sandbox.exports.default?.({
      on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) => {
        if (name === "session_start") handlers.push(handler);
      },
      registerTool: () => {},
    });
    const ctx = {
      cwd: dir,
      isProjectTrusted: () => {
        if (opts.throwOnTrust) throw new Error(SECRET);
        return opts.trusted;
      },
      ui: { notify: (message: string) => notices.push(message) },
    };
    for (const handler of handlers) await handler({}, ctx);
    return notices;
  }

  // Covers: R13
  it("untrusted project mcp server reported at session start", async () => {
    const project = '{"mcpServers":{"engram":{"command":"x","env":{"T":"' + SECRET + '"}}}}';
    const notices = await sessionStart({ projectJson: project, trusted: false });
    const mcp = notices.filter((n) => /Pi MCP server/.test(n));
    expect(mcp).toHaveLength(1);
    expect(mcp[0]).toMatch(/engram.*only in \.pi\/mcp\.json.*not effective.*\/trust/);
    expect(mcp[0]).not.toContain(SECRET);
    // Trusted projects and children stay silent.
    expect(await sessionStart({ projectJson: project, trusted: true })).toEqual([]);
    expect(await sessionStart({ projectJson: project, trusted: false, child: true })).toEqual([]);
  });

  // Covers: R13, R15
  it("runtime mcp check failure stays silent", async () => {
    expect(await sessionStart({ trusted: false, throwOnTrust: true })).toEqual([]);
    expect(
      await sessionStart({
        projectJson: '{"mcpServers": {"engram": ' + SECRET + " oops",
        trusted: false,
      }),
    ).toEqual([]);
  });
});

describe("Pi plugin projection", () => {
  const GUARD = {
    script: "guard-destructive",
    on: "tool_call",
    tools: ["bash"],
    scope: "all",
    class: "enforced",
    interactive: true,
    timeoutMs: 30_000,
  } as const;

  /** A project directory plus the config for the given engines and plugin switches. */
  function project(engines: string[], plugins: Record<string, { enabled: boolean }>) {
    const dir = mkdtempSync(join(tmpdir(), "navori-pi-plugins-"));
    dirs.push(dir);
    const config = NavoriConfigSchema.parse({
      name: "pi-plugins",
      preset: "custom",
      engines,
      branchBase: "main",
      qualityGate: { fast: "bun test", full: "bun test" },
      plugins,
    });
    return { dir, config };
  }
  const read = (dir: string, rel: string): string => readFileSync(join(dir, rel), "utf8");
  const hookPaths = (dir: string): string[] =>
    (JSON.parse(read(dir, ".pi/navori.json")) as { hooks: Array<{ path: string }> }).hooks.map(
      (hook) => hook.path,
    );

  // Covers: R12
  it("plugin skills and prose projected since codex absent", () => {
    const { dir, config } = project(["pi"], { jscpd: { enabled: true }, tgrep: { enabled: true } });
    renderPiEngine(dir, config, { hookBindings: [GUARD] });
    // The skill that extends review-diff is a sub-block of Pi's own shared-root copy.
    expect(read(dir, ".agents/skills/review-diff/SKILL.md")).toContain("jscpd-review-extension");
    // Plugin protocol blocks ride in the context file Pi writes.
    expect(read(dir, "AGENTS.md")).toContain("Textual provider: tgrep");
  });

  // Covers: R12
  it("with codex active nothing the codex owns is duplicated", () => {
    const { dir, config } = project(["pi", "codex"], {
      jscpd: { enabled: true },
      tgrep: { enabled: true },
    });
    renderPiEngine(dir, config, { hookBindings: [GUARD] });
    expect(existsSync(join(dir, ".agents"))).toBe(false);
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
    // Pi's own executable copies remain Pi's.
    expect(existsSync(join(dir, ".pi/navori/scripts/check-jscpd.sh"))).toBe(true);
  });

  // Covers: R12
  it("plugin hook placed under .pi/navori and declared in the manifest", () => {
    const { dir, config } = project(["pi"], { jscpd: { enabled: true }, tgrep: { enabled: true } });
    renderPiEngine(dir, config, { hookBindings: [GUARD] });
    expect(hookPaths(dir)).toEqual(
      expect.arrayContaining([
        ".pi/navori/hooks/guard-destructive.sh",
        ".pi/navori/scripts/check-jscpd.sh",
      ]),
    );
    // The tgrep lane rides inside Pi's guard copy and the script it sources is installed beside it.
    expect(read(dir, ".pi/navori/hooks/guard-destructive.sh")).toContain("tgrep-search-lane");
    expect(existsSync(join(dir, ".pi/navori/scripts/guard-search-routing.sh"))).toBe(true);
    expect(statSync(join(dir, ".pi/navori/scripts/check-jscpd.sh")).mode & 0o111).not.toBe(0);
  });

  // Covers: R12
  it("disabling a plugin prunes its Pi outputs", () => {
    const on = project(["pi"], { jscpd: { enabled: true }, tgrep: { enabled: true } });
    renderPiEngine(on.dir, on.config, { hookBindings: [GUARD] });
    const off = NavoriConfigSchema.parse({
      ...on.config,
      plugins: { jscpd: { enabled: false }, tgrep: { enabled: false } },
    });
    renderPiEngine(on.dir, off, { hookBindings: [GUARD] });
    expect(existsSync(join(on.dir, ".pi/navori/scripts/check-jscpd.sh"))).toBe(false);
    expect(existsSync(join(on.dir, ".pi/navori/scripts/guard-search-routing.sh"))).toBe(false);
    expect(read(on.dir, ".agents/skills/review-diff/SKILL.md")).not.toContain(
      "jscpd-review-extension",
    );
    expect(read(on.dir, ".pi/navori/hooks/guard-destructive.sh")).not.toContain(
      "tgrep-search-lane",
    );
    expect(hookPaths(on.dir)).toEqual([".pi/navori/hooks/guard-destructive.sh"]);
  });

  // Covers: R12
  it("an MCP plugin's prose is not injected into a child role", () => {
    const { dir, config } = project(["pi"], { engram: { enabled: true } });
    renderPiEngine(dir, config);
    expect(read(dir, ".pi/agents/reviewer.md")).not.toContain("engram");
  });

  // Covers: R12
  it("prose of a plugin without an MCP server is appended to the role file", () => {
    const dir = mkdtempSync(join(tmpdir(), "navori-pi-prose-"));
    dirs.push(dir);
    writeFileSync(join(dir, "ext.txt"), "Extra reviewer guidance.\n");
    const config = NavoriConfigSchema.parse({
      name: "pi-prose",
      preset: "custom",
      engines: ["pi"],
      branchBase: "main",
    });
    const target = [".claude", "agents", "reviewer.md"].join("/");
    const plugin = (mcp: boolean): LoadedPlugin =>
      ({
        manifest: { id: "x", ...(mcp ? { mcpServer: { name: "x" } } : {}) },
        skillAssets: [{ id: "x-ext", absPath: join(dir, "ext.txt"), injectInto: target }],
      }) as unknown as LoadedPlugin;
    expect(rolePluginProse("reviewer", [plugin(false)], config)).toContain(
      "Extra reviewer guidance.",
    );
    expect(rolePluginProse("implementer", [plugin(false)], config)).toBe("");
    expect(rolePluginProse("reviewer", [plugin(true)], config)).toBe("");
  });
});
