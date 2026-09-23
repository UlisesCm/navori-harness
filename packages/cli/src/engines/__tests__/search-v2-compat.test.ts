import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NavoriConfigSchema, type NavoriConfig } from "../../lib/schema.ts";
import { renderClaudeEngine } from "../claude/index.ts";
import { renderCodexEngine } from "../codex/index.ts";
import { renderCursorEngine } from "../cursor/index.ts";
import { renderCopilotEngine } from "../copilot/index.ts";
import { renderAgentsMdEngine } from "../agents-md/index.ts";
import { writeConfig } from "../../lib/config.ts";
import { runRender } from "../../commands/render.ts";
import { extractManagedContent } from "../../lib/marker.ts";
import { splitFrontmatter, getFrontmatterField } from "../../lib/frontmatter.ts";

// C07 (doctor half): `hasBinary` is mocked file-wide so `scanMissingExternalTools`/
// `computeHealthVerdict` don't depend on what's actually installed on the test
// machine's PATH — same pattern as `commands/__tests__/external-tools.test.ts`.
// Harmless for every other describe block here: nothing in the render pipeline
// calls `hasBinary`.
const hasBinary = vi.fn();
vi.mock(import("../../lib/which.ts"), () => ({ hasBinary: (n: string) => hasBinary(n) }));
const { scanMissingExternalTools, computeHealthVerdict } = await import("../../commands/doctor.ts");

/**
 * search-v2.md §7 P3 (C01-C07) — compatibility/lifecycle contracts the plan
 * calls out separately from the render matrix in `search-v2-render.test.ts`
 * (P2): `.gitignore` opt-in (§6.2), Codex/prose engine constraints, and
 * cross-plugin isolation. Fixtures follow the same `mkdtemp` + cleanup pattern
 * as `search-v2-render.test.ts` — no network call in this file.
 */

function baseConfig(
  engines: NavoriConfig["engines"],
  plugins: Record<string, { enabled: boolean }> = {},
  extra: Partial<Parameters<typeof NavoriConfigSchema.parse>[0]> = {},
): NavoriConfig {
  return NavoriConfigSchema.parse({
    name: "search-v2-compat-demo",
    engines,
    preset: "custom",
    branchBase: "main",
    qualityGate: { fast: "pnpm typecheck", full: "pnpm test" },
    plugins,
    ...extra,
  });
}

function mkTmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** The `tools:` allowlist of a rendered agent file, split into entries. */
function agentTools(content: string): string[] {
  const { frontmatter } = splitFrontmatter(content);
  const raw = getFrontmatterField(frontmatter, "tools");
  return raw
    ? raw
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t !== "")
    : [];
}

interface SettingsJson {
  permissions: { allow: string[]; deny?: string[]; ask?: string[] };
  [key: string]: unknown;
}
function readSettings(cwd: string): SettingsJson {
  return JSON.parse(readFileSync(join(cwd, ".claude/settings.json"), "utf-8")) as SettingsJson;
}
interface McpJson {
  mcpServers: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}
function readMcp(cwd: string): McpJson | null {
  const path = join(cwd, ".mcp.json");
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf-8")) as McpJson) : null;
}

describe("C01 — grant lifecycle: retire on disable, foreign grants survive, hand-edits preserved", () => {
  let cwd: string;
  beforeEach(() => (cwd = mkTmp("navori-compat-c01-")));
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it("disabling codegraph retires its grant on every role; engram's own grant on the same agent survives", () => {
    renderClaudeEngine(
      cwd,
      baseConfig(["claude"], { codegraph: { enabled: true }, engram: { enabled: true } }),
    );
    const leaderOn = readFileSync(join(cwd, ".claude/agents/orchestrator.md"), "utf-8");
    // engram's orchestrator skill narrows its grant via `mcpTools` — no wildcard.
    expect(agentTools(leaderOn)).toEqual(
      expect.arrayContaining(["mcp__codegraph__*", "mcp__engram__mem_search"]),
    );
    expect(readMcp(cwd)?.mcpServers.engram).toBeDefined();

    renderClaudeEngine(
      cwd,
      baseConfig(["claude"], { codegraph: { enabled: false }, engram: { enabled: true } }),
    );
    const leaderOff = readFileSync(join(cwd, ".claude/agents/orchestrator.md"), "utf-8");
    expect(agentTools(leaderOff)).not.toContain("mcp__codegraph__*");
    // Engram's grant on the SAME agent is untouched by codegraph's retirement.
    expect(agentTools(leaderOff)).toContain("mcp__engram__mem_search");
    expect(readMcp(cwd)?.mcpServers.codegraph).toBeUndefined();
    expect(readMcp(cwd)?.mcpServers.engram).toBeDefined();
    expect(readSettings(cwd).permissions.allow).toContain("mcp__engram__*");
  });

  it("a hand-edited codegraph sub-block is never force-overwritten by an unrelated tgrep toggle", () => {
    renderClaudeEngine(
      cwd,
      baseConfig(["claude"], { codegraph: { enabled: true }, tgrep: { enabled: false } }),
    );
    const path = join(cwd, ".claude/agents/orchestrator.md");
    const edited = readFileSync(path, "utf-8").replace(
      "Apply Code discovery routing from the project instructions.",
      "USER-EDIT: keep this exact wording.",
    );
    writeFileSync(path, edited);

    // Flipping an UNRELATED plugin (tgrep) must not touch codegraph's hand-edited block.
    const r = renderClaudeEngine(
      cwd,
      baseConfig(["claude"], { codegraph: { enabled: true }, tgrep: { enabled: true } }),
    );
    const after = readFileSync(path, "utf-8");
    expect(after).toContain("USER-EDIT: keep this exact wording.");
    expect(r.skipped.some((s) => s.path === ".claude/agents/orchestrator.md")).toBe(true);
  });
});

describe("C02 — .gitignore: byte-identical off, local/full gated strictly per active plugin", () => {
  let cwd: string;
  let configPath: string;
  beforeEach(() => {
    cwd = mkTmp("navori-compat-c02-");
    configPath = join(cwd, "navori.config.json");
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  function write(
    gitignoreHarness: "off" | "local" | "full",
    plugins: Record<string, { enabled: boolean }>,
  ) {
    writeConfig(configPath, {
      name: "demo",
      engines: ["claude"],
      preset: "custom",
      gitignoreHarness,
      plugins,
    });
  }

  it("off never writes .gitignore, regardless of which v2 plugins are active", () => {
    write("off", { codegraph: { enabled: true }, tgrep: { enabled: true } });
    const result = runRender(cwd, { dryRun: false });
    expect(result.gitignore == null).toBe(true);
    expect(existsSync(join(cwd, ".gitignore"))).toBe(false);
  });

  it("local/full add each entry only under its own plugin, never duplicated", () => {
    write("full", { codegraph: { enabled: true } });
    runRender(cwd, { dryRun: false });
    const content = readFileSync(join(cwd, ".gitignore"), "utf-8");
    const block = extractManagedContent(content, "gitignore-harness", "shell") ?? "";
    const lines = block.split("\n");
    expect(lines.filter((l) => l === ".codegraph/")).toHaveLength(1);
    expect(lines).not.toContain(".tgrep/");
  });
});

describe("C03 — base Cubo A/B rules, manual preservation, backup and dry-run survive v2 plugins", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkTmp("navori-compat-c03-");
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it("Cubo A/B entries and a pre-existing user line all coexist with both plugins active", () => {
    writeConfig(join(cwd, "navori.config.json"), {
      name: "demo",
      engines: ["claude"],
      preset: "custom",
      gitignoreHarness: "full",
      plugins: { codegraph: { enabled: true }, tgrep: { enabled: true } },
    });
    writeFileSync(join(cwd, ".gitignore"), "# my own rule\ncoverage/\n");
    const result = runRender(cwd, { dryRun: false });
    expect(result.gitignore?.status).toBe("created");
    const content = readFileSync(join(cwd, ".gitignore"), "utf-8");
    expect(content).toContain("coverage/");
    expect(content).toContain(".claude/");
    expect(content).toContain(".codegraph/");
    expect(content).toContain(".tgrep/");
  });

  it("dry-run with both plugins active writes nothing and reports the plan only", () => {
    writeConfig(join(cwd, "navori.config.json"), {
      name: "demo",
      engines: ["claude"],
      preset: "custom",
      gitignoreHarness: "local",
      plugins: { codegraph: { enabled: true }, tgrep: { enabled: true } },
    });
    const result = runRender(cwd, { dryRun: true });
    expect(result.gitignore?.status).toBe("created");
    expect(existsSync(join(cwd, ".gitignore"))).toBe(false);
  });
});

describe("C04 — Codex: no alwaysLoad, no untransformed .claude paths, generic MCP contract holds", () => {
  let cwd: string;
  beforeEach(() => (cwd = mkTmp("navori-compat-c04-")));
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it("codegraph's MCP entry in config.toml carries only command/args/env — never alwaysLoad", () => {
    renderCodexEngine(cwd, baseConfig(["codex"], { codegraph: { enabled: true } }));
    const toml = readFileSync(join(cwd, ".codex/config.toml"), "utf-8");
    expect(toml).toContain('[mcp_servers."codegraph"]');
    expect(toml).toContain('command = "codegraph"');
    expect(toml).toContain('args = ["serve", "--mcp"]');
    expect(toml).not.toContain("alwaysLoad");
  });

  it("tgrep has no mcpServer, so Codex just warns instead of emitting a broken entry", () => {
    const result = renderCodexEngine(cwd, baseConfig(["codex"], { tgrep: { enabled: true } }));
    const toml = readFileSync(join(cwd, ".codex/config.toml"), "utf-8");
    expect(toml).not.toContain('mcp_servers."tgrep"');
    expect(result.warnings.some((w) => w.includes("tgrep") && w.includes("mcpServer"))).toBe(true);
  });

  it("the Codex-rendered AGENTS.md never carries an untransformed .claude path", () => {
    renderCodexEngine(cwd, baseConfig(["codex"], { codegraph: { enabled: true } }));
    const agentsMd = readFileSync(join(cwd, "AGENTS.md"), "utf-8");
    expect(agentsMd).not.toContain(".claude/agents");
    expect(agentsMd).not.toContain(".claude/skills");
  });
});

describe("C05 — prose engines (cursor, copilot, agents-md) never promise MCP tools they don't configure", () => {
  let cwd: string;
  beforeEach(() => (cwd = mkTmp("navori-compat-c05-")));
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  const cases = [
    {
      name: "cursor",
      render: renderCursorEngine,
      path: ".cursor/rules/navori.mdc",
    },
    {
      name: "copilot",
      render: renderCopilotEngine,
      path: ".github/copilot-instructions.md",
    },
    {
      name: "agents-md",
      render: renderAgentsMdEngine,
      path: "AGENTS.md",
    },
  ] as const;

  for (const { name, render, path } of cases) {
    it(`${name} emits no mcp__codegraph__ tool reference and warns about the omitted plugin blocks`, () => {
      const config = baseConfig([name === "agents-md" ? "agents-md" : name], {
        codegraph: { enabled: true },
        tgrep: { enabled: true },
      });
      const result = render(cwd, config);
      const content = readFileSync(join(cwd, path), "utf-8");
      expect(content).not.toContain("mcp__codegraph__");
      expect(content).not.toContain('id="codegraph-search-v2"');
      expect(content).not.toContain('id="tgrep-search-v2"');
      expect(result.warnings.some((w) => w.includes("codegraph") && w.includes("tgrep"))).toBe(
        true,
      );
    });
  }
});

describe("C06 — v2 render doesn't disturb other plugins' settings/MCP/hooks fragments", () => {
  let cwd: string;
  beforeEach(() => (cwd = mkTmp("navori-compat-c06-")));
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  function multiPluginConfig(codegraphOn: boolean, tgrepOn: boolean): NavoriConfig {
    return baseConfig(["claude"], {
      codegraph: { enabled: codegraphOn },
      tgrep: { enabled: tgrepOn },
      engram: { enabled: true },
      jscpd: { enabled: true },
      semgrep: { enabled: true },
    });
  }

  it("engram, jscpd and semgrep keep their exact fragments with both v2 plugins active", () => {
    renderClaudeEngine(cwd, multiPluginConfig(true, true));

    // engram carries no CLAUDE.md-wide block (#814); its fragment lives in the
    // leader's own file instead.
    const leader = readFileSync(join(cwd, ".claude/agents/orchestrator.md"), "utf-8");
    expect(leader).toContain('id="engram-orchestrator-extension"');
    expect(agentTools(leader)).toEqual(
      expect.arrayContaining(["mcp__engram__mem_search", "mcp__codegraph__*"]),
    );

    expect(existsSync(join(cwd, ".claude/scripts/check-jscpd.sh"))).toBe(true);
    expect(existsSync(join(cwd, ".claude/scripts/check-semgrep.sh"))).toBe(true);
    const reviewSkill = readFileSync(join(cwd, ".claude/skills/review-diff/SKILL.md"), "utf-8");
    expect(reviewSkill).toContain('id="jscpd-review-extension"');
    const securitySkill = readFileSync(
      join(cwd, ".claude/skills/security-invariants/SKILL.md"),
      "utf-8",
    );
    expect(securitySkill).toContain('id="semgrep-review-extension"');

    expect(readMcp(cwd)?.mcpServers.engram).toBeDefined();
    expect(readSettings(cwd).permissions.allow).toEqual(expect.arrayContaining(["Bash(jscpd:*)"]));
  });

  it("disabling both v2 plugins afterwards leaves the other three plugins' fragments untouched", () => {
    renderClaudeEngine(cwd, multiPluginConfig(true, true));
    renderClaudeEngine(cwd, multiPluginConfig(false, false));

    const claudeMd = readFileSync(join(cwd, "CLAUDE.md"), "utf-8");
    expect(claudeMd).not.toContain('id="codegraph-search-v2"');
    expect(claudeMd).not.toContain('id="tgrep-search-v2"');

    const leader = readFileSync(join(cwd, ".claude/agents/orchestrator.md"), "utf-8");
    // engram carries no CLAUDE.md-wide block (#814); check its own fragment survives instead.
    expect(leader).toContain('id="engram-orchestrator-extension"');
    expect(agentTools(leader)).toContain("mcp__engram__mem_search");
    expect(agentTools(leader)).not.toContain("mcp__codegraph__*");

    expect(existsSync(join(cwd, ".claude/scripts/check-jscpd.sh"))).toBe(true);
    expect(existsSync(join(cwd, ".claude/scripts/check-semgrep.sh"))).toBe(true);
    expect(readSettings(cwd).permissions.allow).not.toContain("Bash(tgrep search *)");
    expect(readSettings(cwd).permissions.allow).toEqual(expect.arrayContaining(["Bash(jscpd:*)"]));
  });
});

describe("C07 — repos without the codegraph/tgrep binaries still render; doctor only informs", () => {
  let cwd: string;
  const savedPath = process.env.PATH;
  beforeEach(() => (cwd = mkTmp("navori-compat-c07-")));
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
  });

  it("render succeeds with both plugins active and neither binary on PATH", () => {
    // An empty PATH proves render never shells out to codegraph/tgrep — it is
    // driven purely by config, same claim R06 (search-v2-render.test.ts) pins
    // for dry-run; this is the non-dry-run counterpart.
    process.env.PATH = "";
    const result = renderClaudeEngine(
      cwd,
      baseConfig(["claude"], { codegraph: { enabled: true }, tgrep: { enabled: true } }),
    );
    expect(result.written.length).toBeGreaterThan(0);
    expect(readMcp(cwd)?.mcpServers.codegraph).toBeDefined();
    expect(readSettings(cwd).permissions.allow).toContain("Bash(tgrep search *)");
  });
});

describe("C07 — doctor.scanMissingExternalTools: informs, never blocks (ok stays independent)", () => {
  beforeEach(() => hasBinary.mockReset());

  it("flags codegraph and tgrep as missing external tools when their binaries are absent", () => {
    hasBinary.mockReturnValue(false);
    const missing = scanMissingExternalTools(
      baseConfig(["claude"], { codegraph: { enabled: true }, tgrep: { enabled: true } }),
    );
    const ids = missing.map((m) => m.pluginId).sort();
    expect(ids).toEqual(["codegraph", "tgrep"]);
  });

  it("HealthVerdict.ok never depends on missing external tools", () => {
    const cwd = mkTmp("navori-compat-c07-doctor-");
    try {
      hasBinary.mockReturnValue(false);
      const cfg = baseConfig(["claude"], {
        codegraph: { enabled: true },
        tgrep: { enabled: true },
      });
      renderClaudeEngine(cwd, cfg);
      const verdict = computeHealthVerdict(cwd, cfg);
      expect(verdict.ok).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
