import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NavoriConfigSchema, type NavoriConfig } from "../../../lib/config/schema.ts";
import { loadPlugin } from "../../../lib/config/plugins.ts";
import { getCoreRoot } from "../../../lib/render/bundled-assets.ts";
import {
  COMPUTED_BLOCK_LAYERS,
  ORCHESTRATOR_LAYER_IDS,
  declaresClaudeLayer,
  layerOf,
} from "../../../lib/render/layers.ts";
import {
  CORE_MANAGED_ASSETS,
  computeRenderPlan,
  conditionOrchestration,
} from "../../../lib/render/render-plan.ts";
import { tc } from "../../../lib/i18n.ts";
import { renderAgentsMdEngine } from "../index.ts";
import { renderClaudeEngine, CLAUDE_COMPUTED_BLOCK_IDS } from "../../claude/index.ts";
import { renderCodexEngine } from "../../codex/index.ts";
import { renderCopilotEngine } from "../../copilot/index.ts";
import { renderCursorEngine } from "../../cursor/index.ts";
import { renderPiEngine } from "../../pi/index.ts";
import { buildAssetBlocks } from "../../shared/prose-harness.ts";

// No bundled plugin lacks a `layer` any more: `nolayer` is a third-party plugin that declares none.
vi.mock(import("../../../lib/render/bundled-assets.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  const { withFakePlugins, writeFakePlugin } =
    await import("../../../lib/__tests__/helpers/fake-plugins.ts");
  return withFakePlugins(actual, {
    nolayer: writeFakePlugin(
      "nolayer",
      { managed: [{ id: "nolayer-protocol", file: "managed/protocol.md" }] },
      { "managed/protocol.md": "### NoLayer protocol\n\nnolayer-fixture-text\n" },
    ),
  });
});

/**
 * Spec 0064 PR 4a: the layered, neutral `AGENTS.md`. The vocabulary below is what only Claude Code
 * can act on; none of it may appear in a shared block.
 */
const FORBIDDEN: ReadonlyArray<readonly [string, RegExp]> = [
  [".claude/", /\.claude\//],
  ["CLAUDE.md", /CLAUDE\.md/],
  ["TaskCreate", /\bTaskCreate\b/],
  ["`Agent`", /`Agent`/],
  ["Agent(", /\bAgent\(/],
  ["`Read`", /`Read`/],
  ["`Edit`", /`Edit`/],
  ["`Write`", /`Write`/],
  ["Read/Edit", /Read\/Edit/],
  ["Glob", /\bGlob\b/],
  ["Grep", /\bGrep\b/],
  ["auto mode", /auto mode/i],
  ["dontAsk", /\bdontAsk\b/],
  ["SessionStart", /SessionStart/],
  ["code.claude.com", /code\.claude\.com/],
  ["permission mode", /permission mode/i],
  ["hook `ask`", /hook `ask`/i],
  ["onClaude marker", /navori:if(-not)? onClaude/],
];

function found(text: string): string[] {
  return FORBIDDEN.filter(([, re]) => re.test(text)).map(([name]) => name);
}

const SHORT_TICKETS = "Rules: see `resolve-ticket`.";
const LONG_TICKETS = "describes a SYMPTOM";

const PLUGINS = { tgrep: { enabled: true }, codegraph: { enabled: true }, acli: { enabled: true } };

function cfg(engines: NavoriConfig["engines"], over: Record<string, unknown> = {}): NavoriConfig {
  return NavoriConfigSchema.parse({
    name: "layers",
    engines,
    preset: "custom",
    branchBase: "main",
    language: "en",
    harness: { planTiers: true, masterPlan: true },
    plugins: PLUGINS,
    project: { criticalAreas: ["payments"] },
    ...over,
  });
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "navori-shared-layer-"));
  dirs.push(d);
  return d;
}

/** The text of `file` under `cwd`, after the render. */
function read(cwd: string, file: string): string {
  return readFileSync(join(cwd, file), "utf-8");
}

/** The body of the `navori-agents` managed block of an AGENTS.md. */
function agentsBody(cwd: string): string {
  const md = read(cwd, "AGENTS.md");
  const open = md.indexOf('<!-- navori:managed id="navori-agents"');
  const close = md.indexOf('<!-- /navori:managed id="navori-agents"');
  expect(open).toBeGreaterThanOrEqual(0);
  expect(close).toBeGreaterThan(open);
  return md.slice(md.indexOf("-->", open) + 3, close);
}

function agentsMd(engines: NavoriConfig["engines"], over: Record<string, unknown> = {}): string {
  const cwd = tmp();
  renderAgentsMdEngine(cwd, cfg(engines, over));
  return agentsBody(cwd);
}

/** AGENTS.md body of `engines` once the orchestrator-layer blocks (which keep Claude's vocabulary) are cut out. */
function agentsBodyWithoutOrchestratorLayer(engines: NavoriConfig["engines"]): string {
  const config = cfg(engines);
  const body = agentsMd(engines);
  return buildAssetBlocks(config, tmp(), false, {
    engine: "agents-md",
    assetIds: ORCHESTRATOR_LAYER_IDS,
  }).reduce((text, block) => text.replace(block, ""), body);
}

const ORCHESTRATOR_TEXT: Readonly<Record<string, string>> = {
  planificacion: "## Planning tiers — classified, never chosen",
  "plan-maestro": "## Master plan — explicit request only",
  "arranque-sesion": "## Session startup",
};

function presetIds(): string[] {
  return readdirSync(join(getCoreRoot(), "core-assets/presets"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

describe("layer of a block", () => {
  it("the orchestrator layer is exactly the assets that declare an audience", () => {
    expect([...ORCHESTRATOR_LAYER_IDS].sort()).toEqual(
      ["arranque-sesion", "orquestacion", "plan-maestro", "planificacion"].sort(),
    );
    for (const asset of CORE_MANAGED_ASSETS) {
      expect(ORCHESTRATOR_LAYER_IDS.has(asset.id)).toBe(asset.audience === "orchestrator");
    }
  });

  it("classifies by audience, then explicit layer, then provenance", () => {
    const plan = computeRenderPlan("", cfg(["claude"], { preset: "express" }), tmp(), {
      engine: "claude",
    });
    const by = (id: string) => plan.entries.find((e) => e.asset.id === id)!;
    expect(layerOf(by("planificacion"), "express")).toBe("orchestrator");
    expect(layerOf(by("claude-apendice"), "express")).toBe("claude");
    expect(layerOf(by("operaciones-seguras"), "express")).toBe("shared");
    expect(layerOf(by("tgrep-search-v2"), "express")).toBe("shared"); // declared in its manifest
    expect(plan.entries.some((e) => e.source === "express")).toBe(true);
    for (const e of plan.entries.filter((x) => x.source === "express")) {
      expect(layerOf(e, "express")).toBe("shared");
    }
  });

  it("an undeclared plugin block reads as Claude-specific but is not an explicit Claude block", () => {
    const plan = computeRenderPlan(
      "",
      cfg(["claude"], { plugins: { nolayer: { enabled: true } } }),
      tmp(),
      {
        engine: "claude",
      },
    );
    const entry = plan.entries.find((e) => e.asset.id === "nolayer-protocol")!;
    expect(layerOf(entry, "custom")).toBe("claude");
    expect(declaresClaudeLayer(entry)).toBe(false);
    const apendice = computeRenderPlan("", cfg(["claude"]), tmp(), {
      engine: "claude",
    }).entries.find((e) => e.asset.id === "claude-apendice")!;
    expect(declaresClaudeLayer(apendice)).toBe(true);
  });

  it("every plugin block that ships a shared layer is declared in its manifest", () => {
    for (const id of ["tgrep", "codegraph", "acli"]) {
      expect(loadPlugin(id).managedAssets.map((a) => a.layer)).toEqual(["shared"]);
    }
  });

  it("COMPUTED_BLOCK_LAYERS classifies exactly the blocks the Claude engine computes (declared exception)", () => {
    expect(Object.keys(COMPUTED_BLOCK_LAYERS).sort()).toEqual(
      [...CLAUDE_COMPUTED_BLOCK_IDS].sort(),
    );
  });
});

describe("onLayered condition", () => {
  const SRC =
    "<!-- navori:if onLayered -->short<!-- /navori:if --><!-- navori:if-not onLayered -->long<!-- /navori:if-not -->";
  const resolve = (engine: string, engines: NavoriConfig["engines"]): string =>
    conditionOrchestration(SRC, cfg(engines), engine);

  it("is true for claude, and for agents-md only with pi configured", () => {
    expect(resolve("claude", ["claude"])).toBe("short");
    expect(resolve("agents-md", ["agents-md", "pi"])).toBe("short");
    expect(resolve("agents-md", ["agents-md"])).toBe("long");
    expect(resolve("agents-md", ["claude", "agents-md"])).toBe("long");
  });

  it("is false for every other engine, even with pi configured", () => {
    for (const engine of ["cursor", "copilot", "codex", "pi"]) {
      expect(resolve(engine, ["pi", engine as "cursor"])).toBe("long");
    }
  });
});

describe("the shared layer is neutral at the source", () => {
  it("no shared block, preset or shared plugin block keeps an onClaude span", () => {
    const root = getCoreRoot();
    const files = [
      ...CORE_MANAGED_ASSETS.filter((a) => a.audience === undefined && a.layer === undefined).map(
        (a) => join(root, a.relPath),
      ),
      ...presetIds().map((p) => join(root, "core-assets/presets", p, "managed/stack.md")),
      ...["tgrep", "codegraph", "acli"].flatMap((id) =>
        loadPlugin(id).managedAssets.map((a) => a.absPath),
      ),
    ];
    expect(files.length).toBeGreaterThan(20);
    for (const file of files) expect(found(readFileSync(file, "utf-8")), file).toEqual([]);
  });
});

describe("the shared layer is neutral once rendered", () => {
  for (const preset of presetIds()) {
    for (const engine of ["agents-md", "claude"]) {
      it(`${preset} as ${engine}: every shared block is free of Claude vocabulary`, () => {
        const config = cfg(["agents-md"], { preset });
        const plan = computeRenderPlan("", config, tmp(), { engine });
        const shared = plan.entries.filter(
          (e) => e.newContent !== null && layerOf(e, config.preset) === "shared",
        );
        expect(shared.some((e) => e.source === preset)).toBe(true);
        expect(shared.some((e) => e.asset.id === "tgrep-search-v2")).toBe(true);
        for (const e of shared) expect(found(e.newContent!), e.asset.id).toEqual([]);
      });
    }
  }

  it("AGENTS.md of claude+pi+agents-md is neutral from top to bottom, skills index included", () => {
    expect(found(agentsMd(["claude", "pi", "agents-md"]))).toEqual([]);
  });

  it("AGENTS.md of agents-md alone is neutral outside the orchestrator layer it still carries", () => {
    expect(found(agentsBodyWithoutOrchestratorLayer(["agents-md"]))).toEqual([]);
    // Without Pi the orchestrator layer stays, with Claude's wording (it moves for Claude later).
    expect(found(agentsMd(["agents-md"]))).toContain(".claude/");
  });
});

describe("composition of AGENTS.md by engines", () => {
  it("agents-md alone carries the shared layer, the search blocks, the project rules and the orchestrator layer", () => {
    const body = agentsMd(["agents-md"]);
    expect(body).toContain("### Textual provider: tgrep");
    expect(body).toContain("codegraph_explore");
    expect(body).toContain("acli jira workitem view");
    expect(body).toContain(tc("en").blocks.projectContext.heading);
    expect(body).toContain("payments");
    for (const text of Object.values(ORCHESTRATOR_TEXT)) expect(body).toContain(text);
    expect(body).not.toContain("## Role: orchestrator"); // `orquestacion` still never lands here
  });

  it("the orchestrator layer leaves AGENTS.md only when pi is configured", () => {
    for (const engines of [["agents-md"], ["claude", "agents-md"]] as const) {
      const body = agentsMd([...engines]);
      for (const text of Object.values(ORCHESTRATOR_TEXT))
        expect(body, engines.join()).toContain(text);
    }
    for (const engines of [
      ["pi", "agents-md"],
      ["claude", "pi", "agents-md"],
    ] as const) {
      const body = agentsMd([...engines]);
      for (const text of Object.values(ORCHESTRATOR_TEXT)) {
        expect(body, engines.join()).not.toContain(text);
      }
      expect(body).toContain("### Textual provider: tgrep"); // the shared layer stays
    }
  });

  it("a plugin block with no layer stays in Codex's and Pi's AGENTS.md and out of the layered one", () => {
    const over = { plugins: { nolayer: { enabled: true } } };
    expect(agentsMd(["agents-md"], over)).not.toContain("nolayer-fixture-text");

    const codex = tmp();
    renderCodexEngine(codex, cfg(["claude", "codex"], over));
    expect(read(codex, "AGENTS.md")).toContain("nolayer-fixture-text");

    const pi = tmp();
    renderPiEngine(pi, cfg(["pi"], over));
    expect(read(pi, "AGENTS.md")).toContain("nolayer-fixture-text");
  });

  it("no prose engine carries the Claude appendix", () => {
    const claude = tmp();
    renderClaudeEngine(claude, cfg(["claude"]));
    expect(read(claude, "CLAUDE.md")).toContain("## Claude Code specifics");

    const written: string[] = [];
    for (const [engines, file, render] of [
      [["agents-md"], "AGENTS.md", renderAgentsMdEngine],
      [["cursor"], ".cursor/rules/navori.mdc", renderCursorEngine],
      [["copilot"], ".github/copilot-instructions.md", renderCopilotEngine],
      [["claude", "codex"], "AGENTS.md", renderCodexEngine],
      [["pi"], "AGENTS.md", renderPiEngine],
    ] as const) {
      const cwd = tmp();
      render(cwd, cfg([...engines]));
      written.push(read(cwd, file));
    }
    expect(written).toHaveLength(5);
    for (const text of written) expect(text).not.toContain("Claude Code specifics");
  });
});

describe("tickets text: exactly one version in every engine", () => {
  const verdict = (text: string): "short" | "long" | "both" | "neither" => {
    const short = text.includes(SHORT_TICKETS);
    const long = text.includes(LONG_TICKETS);
    return short && long ? "both" : short ? "short" : long ? "long" : "neither";
  };

  it("the short text goes to claude, and to agents-md only with pi", () => {
    const claude = tmp();
    renderClaudeEngine(claude, cfg(["claude"]));
    expect(verdict(read(claude, "CLAUDE.md"))).toBe("short");
    expect(verdict(agentsMd(["pi", "agents-md"]))).toBe("short");
    expect(verdict(agentsMd(["claude", "pi", "agents-md"]))).toBe("short");
  });

  it("agents-md without pi, cursor, copilot, codex and Pi alone keep the long text", () => {
    expect(verdict(agentsMd(["agents-md"]))).toBe("long");
    expect(verdict(agentsMd(["claude", "agents-md"]))).toBe("long");
    const reads: string[] = [];
    for (const [engines, file, render] of [
      [["cursor"], ".cursor/rules/navori.mdc", renderCursorEngine],
      [["copilot"], ".github/copilot-instructions.md", renderCopilotEngine],
      [["claude", "codex"], "AGENTS.md", renderCodexEngine],
      [["pi"], "AGENTS.md", renderPiEngine],
    ] as const) {
      const cwd = tmp();
      render(cwd, cfg([...engines]));
      reads.push(verdict(read(cwd, file)));
    }
    expect(reads).toEqual(["long", "long", "long", "long"]);
  });
});
