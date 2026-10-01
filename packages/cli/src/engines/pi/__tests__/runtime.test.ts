import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { NavoriConfigSchema } from "../../../lib/config/schema.ts";
import { renderPiEngine } from "../index.ts";

const PI_PACKAGE_ROOT = resolve(
  import.meta.dirname,
  "../../../../node_modules/@earendil-works/pi-coding-agent",
);
const PI_CLI = join(PI_PACKAGE_ROOT, "dist/bundle/cli.js");
const dirs: string[] = [];
const config = NavoriConfigSchema.parse({
  name: "pi-runtime-smoke",
  preset: "custom",
  engines: ["pi"],
  branchBase: "main",
  qualityGate: { fast: "bun test", full: "bun test" },
  harness: { scribeOwnsMarkdown: true },
});

function project(compiled: boolean = false): { cwd: string; agentDir: string; home: string } {
  // Keep the fixture below the declared Pi dev dependency, without artificial module symlinks.
  const root = mkdtempSync(resolve(import.meta.dirname, "../../../../.pi-runtime-smoke-"));
  dirs.push(root);
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const home = join(root, "home");
  mkdirSync(cwd);
  mkdirSync(agentDir);
  mkdirSync(home);
  if (compiled) {
    writeFileSync(join(cwd, "navori.config.json"), JSON.stringify(config));
    const rendered = spawnSync(
      process.execPath,
      [resolve(import.meta.dirname, "../../../../dist/index.js"), "render", "--apply"],
      { cwd, encoding: "utf8", timeout: 15_000 },
    );
    expect(rendered.status, rendered.stderr + rendered.stdout).toBe(0);
  } else {
    renderPiEngine(cwd, config);
  }
  return { cwd, agentDir, home };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Pi 0.87.1 credential-free runtime", () => {
  // Covers: R7, R9
  it("accepts Pi's three process trust modes without touching user auth", () => {
    const piPackage: unknown = JSON.parse(
      readFileSync(join(PI_PACKAGE_ROOT, "package.json"), "utf8"),
    );
    expect(piPackage).toMatchObject({ version: "0.87.1" });
    const { cwd, agentDir, home } = project();
    expect(readFileSync(join(cwd, ".pi/extensions/navori.ts"), "utf8")).toContain(
      "navori_subagent",
    );
    const marker = join(dirname(cwd), "factory-loaded");
    // The observer calls the rendered factory; it never substitutes a fake extension for Navori.
    writeFileSync(
      join(cwd, ".pi/extensions/observer.ts"),
      [
        'import { writeFileSync } from "node:fs";',
        'import { VERSION } from "@earendil-works/pi-coding-agent";',
        'import navori from "./navori.ts";',
        "export default function(pi) { navori(pi); writeFileSync(process.env.NAVORI_PI_SMOKE_MARKER, VERSION); }",
        "",
      ].join("\n"),
    );
    for (const [flags, shouldLoad] of [
      [[], false],
      [["--no-approve"], false],
      [["--approve"], true],
      [[], false],
    ] as const) {
      if (existsSync(marker)) unlinkSync(marker);
      const run = spawnSync(process.execPath, [PI_CLI, ...flags, "--help"], {
        cwd,
        encoding: "utf8",
        env: {
          HOME: home,
          PATH: process.env.PATH,
          PI_CODING_AGENT_DIR: agentDir,
          PI_CODING_AGENT_SESSION_DIR: join(agentDir, "sessions"),
          NAVORI_PI_SMOKE_MARKER: marker,
        },
        timeout: 15_000,
      });
      expect(run.status, run.stderr).toBe(0);
      expect(run.stderr).not.toContain("Failed to load extension");
      expect(run.stdout).toContain("Usage:");
      expect(existsSync(marker)).toBe(shouldLoad);
      if (shouldLoad) expect(readFileSync(marker, "utf8")).toBe("0.87.1");
    }
    expect(existsSync(join(home, ".pi/agent/auth.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8"))).toEqual({});
  });

  // Covers: R9
  it.each([false, true])(
    "loads the rendered extension in the real SDK and registers its subagent tool (compiled=%s)",
    async (compiled: boolean) => {
      const { cwd, agentDir } = project(compiled);
      const denied = new DefaultResourceLoader({ cwd, agentDir });
      await denied.reload({ resolveProjectTrust: async () => false });
      expect(denied.getExtensions().extensions).toEqual([]);
      const loader = new DefaultResourceLoader({ cwd, agentDir });
      await loader.reload({ resolveProjectTrust: async () => true });
      // Covers: R3, R9
      expect(loader.getSkills().skills.map((skill) => skill.name)).toContain("verify-before-done");
      expect(loader.getExtensions().errors).toEqual([]);
      expect(loader.getExtensions().extensions.map((extension) => extension.path)).toContain(
        join(cwd, ".pi/extensions/navori.ts"),
      );
      const runtime = await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: join(agentDir, "models.json"),
      });
      const { session } = await createAgentSession({
        cwd,
        agentDir,
        resourceLoader: loader,
        modelRuntime: runtime,
        sessionManager: SessionManager.inMemory(cwd),
        settingsManager: SettingsManager.inMemory({}),
        noTools: "all",
      });
      expect(
        session.extensionRunner?.getAllRegisteredTools().map((tool) => tool.definition.name),
      ).toContain("navori_subagent");
      // Covers: R7, R9 — this is real SDK event dispatch; trust=true above is a loader seam.
      const previousRole = process.env.NAVORI_PI_CHILD_ROLE;
      process.env.NAVORI_PI_CHILD_ROLE = "implementer";
      try {
        const blocked = await session.extensionRunner?.emitToolCall({
          type: "tool_call",
          toolName: "write",
          toolCallId: "markdown",
          input: { path: "README.md" },
        });
        const allowed = await session.extensionRunner?.emitToolCall({
          type: "tool_call",
          toolName: "write",
          toolCallId: "typescript",
          input: { path: "src/index.ts" },
        });
        expect(blocked).toMatchObject({ block: true });
        expect(allowed).toBeUndefined();
      } finally {
        if (previousRole === undefined) delete process.env.NAVORI_PI_CHILD_ROLE;
        else process.env.NAVORI_PI_CHILD_ROLE = previousRole;
      }
    },
  );
});
