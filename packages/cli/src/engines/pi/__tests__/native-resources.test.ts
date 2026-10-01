import * as fs from "node:fs";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NavoriConfigSchema } from "../../../lib/config/schema.ts";
import { renderPiEngine } from "../index.ts";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const dirs: string[] = [];
const config = NavoriConfigSchema.parse({
  name: "pi-native-resources-test",
  preset: "custom",
  engines: ["pi"],
  branchBase: "main",
  qualityGate: { fast: "bun test", full: "bun test" },
});

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "navori-pi-native-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.clearAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Pi-owned MCP and authentication resources", () => {
  // Covers: R4, R5
  it("preserves project and user MCP, settings, and credential fixtures byte-for-byte", () => {
    const project = freshDir();
    const agentDir = join(freshDir(), "agent");
    mkdirSync(join(project, ".pi"));
    mkdirSync(agentDir);
    const fixtures = new Map<string, string>([
      [
        join(project, ".pi/mcp.json"),
        '{"mcpServers":{"project":{"command":"fixture","env":{"TOKEN":"${MCP_TOKEN}"}}}}\n',
      ],
      [join(project, ".pi/settings.json"), '{"extensions":["builtin:mcp"],"userSetting":true}\n'],
      [join(project, ".pi/auth.json"), '{"fake":"project-auth-sentinel"}\n'],
      [
        join(agentDir, "mcp.json"),
        '{"mcpServers":{"global":{"url":"https://invalid.example.test/mcp"}}}\n',
      ],
      [join(agentDir, "auth.json"), '{"openai-codex":{"access":"global-auth-sentinel"}}\n'],
    ]);
    for (const [path, content] of fixtures) writeFileSync(path, content);

    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      vi.mocked(fs.readFileSync).mockClear();
      const preview = renderPiEngine(project, config, { dryRun: true });
      expect(preview.written).toContainEqual({ path: ".pi/navori.json", status: "created" });
      for (const path of fixtures.keys()) expect(existsSync(path)).toBe(true);

      const applied = renderPiEngine(project, config);
      expect(applied.written).toEqual(preview.written);
      const sensitivePaths = new Set(fixtures.keys());
      const rendererReads = vi
        .mocked(fs.readFileSync)
        .mock.calls.map(([path]) => (typeof path === "string" ? path : String(path)))
        .filter((path) => sensitivePaths.has(path));
      expect(rendererReads).toEqual([]);
      expect(JSON.stringify([preview, applied])).not.toMatch(/auth-sentinel|MCP_TOKEN/);
      for (const [path, content] of fixtures) expect(readFileSync(path, "utf-8")).toBe(content);
      expect(readdirSync(join(project, ".pi"))).toContain("navori.json");
      expect(readdirSync(agentDir).sort()).toEqual(["auth.json", "mcp.json"]);

      const rendered = readFileSync(join(project, ".pi/navori.json"), "utf-8");
      expect(rendered).not.toContain("global-auth-sentinel");
      expect(rendered).not.toContain("project-auth-sentinel");
      expect(rendered).not.toContain("MCP_TOKEN");
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });

  // Covers: R4, R5
  it("does not create MCP, settings, or auth files when they are absent", () => {
    const project = freshDir();
    const agentDir = join(freshDir(), "agent");
    mkdirSync(agentDir);
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      renderPiEngine(project, config);
      for (const name of ["mcp.json", "settings.json", "auth.json"]) {
        expect(existsSync(join(project, ".pi", name))).toBe(false);
      }
      expect(readdirSync(agentDir)).toEqual([]);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });
});
