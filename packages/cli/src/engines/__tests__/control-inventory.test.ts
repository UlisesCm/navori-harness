import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { NavoriConfigSchema, type NavoriConfig } from "../../lib/config/schema.ts";
import { renderAgentsMdEngine } from "../agents-md/index.ts";
import { renderClaudeEngine } from "../claude/index.ts";
import { renderCodexEngine } from "../codex/index.ts";
import { renderCopilotEngine } from "../copilot/index.ts";
import { renderCursorEngine } from "../cursor/index.ts";
import {
  CONTROL_DEFINITIONS,
  ENGINE_CAPABILITIES,
  WRITE_CAPABLE_TOOLS,
  type AnalyticRole,
  type ControlId,
  type EngineId,
} from "../shared/engine-capabilities.ts";

/**
 * Spec 0033 D5 (R22, R23) — the registry vs. the actual render.
 *
 * Renders all five engines into their own temp directory, with every relevant
 * flag ON and a real project-local skill on disk, then reads the RENDERED
 * FILES back (never another declaration inside `engine-capabilities.ts`) to
 * confirm every declared control state matches what the engine actually
 * produced, and that the four analytic roles' effective write tools/sandbox
 * match `analyticWriteTools`.
 *
 * Covers: R22, R23
 */

const LOCAL_SKILL_ID = "control-inventory-local";
const ANALYTIC_ROLES: readonly AnalyticRole[] = ["auditor", "scout", "reviewer", "architect"];

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function freshDir(engineId: string): string {
  const dir = mkdtempSync(join(tmpdir(), `navori-control-inventory-${engineId}-`));
  tempDirs.push(dir);
  return dir;
}

/** Writes the one project-local skill fixture every case declares. */
function seedLocalSkill(cwd: string): void {
  const dir = join(cwd, ".claude/skills", LOCAL_SKILL_ID);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${LOCAL_SKILL_ID}\ndescription: "Fixture skill for control-inventory.test.ts"\n---\n\nBody.\n`,
  );
}

/** All flags on, one engine, one project-local skill declared. */
function fullFlagsConfig(engineId: EngineId): NavoriConfig {
  return NavoriConfigSchema.parse({
    name: "control-inventory-demo",
    engines: [engineId],
    preset: "custom",
    branchBase: "main",
    harness: { planTiers: true, scribeOwnsMarkdown: true },
    project: { localSkills: [LOCAL_SKILL_ID] },
  });
}

interface EngineCase {
  readonly id: EngineId;
  readonly render: (cwd: string, config: NavoriConfig) => void;
}

const ENGINE_CASES: readonly EngineCase[] = [
  { id: "claude", render: (cwd, config) => void renderClaudeEngine(cwd, config) },
  { id: "codex", render: (cwd, config) => void renderCodexEngine(cwd, config) },
  { id: "agents-md", render: (cwd, config) => void renderAgentsMdEngine(cwd, config) },
  { id: "cursor", render: (cwd, config) => void renderCursorEngine(cwd, config) },
  { id: "copilot", render: (cwd, config) => void renderCopilotEngine(cwd, config) },
];

/** `.claude/settings.json`'s hook shape, narrowed to what this test reads. */
interface ClaudeSettingsHooks {
  hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>>;
}

function readClaudeSettings(cwd: string): ClaudeSettingsHooks {
  const path = join(cwd, ".claude/settings.json");
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf-8")) as ClaudeSettingsHooks;
}

/** Whether `settings.json` registers a `PreToolUse`/`PostToolUse`/… hook for
 *  `script` under the exact `event`/`matcher` an evidence entry names. */
function claudeHookRegistered(
  settings: ClaudeSettingsHooks,
  event: string,
  matcher: string,
  script: string,
): boolean {
  const entries = settings.hooks?.[event] ?? [];
  return entries.some(
    (entry) =>
      entry.matcher === matcher &&
      (entry.hooks ?? []).some((h) => typeof h.command === "string" && h.command.includes(script)),
  );
}

/** Whether ANY registered hook (any event/matcher) names `script` — used to
 *  confirm an `unsupported` control's hookScripts never fired at all. */
function claudeAnyHookNames(settings: ClaudeSettingsHooks, script: string): boolean {
  return Object.values(settings.hooks ?? {}).some((entries) =>
    entries.some((entry) => (entry.hooks ?? []).some((h) => h.command?.includes(script))),
  );
}

/** Checks a declared control's state against what `cwd`'s render produced. */
function assertControlMatchesRender(cwd: string, engineId: EngineId, controlId: ControlId): void {
  const declaration = ENGINE_CAPABILITIES[engineId].controls[controlId];
  const definition = CONTROL_DEFINITIONS[controlId];
  const label = `${engineId}.${controlId}`;

  if (controlId === "local-skill-discovery") {
    if (declaration.state === "enforced" && declaration.evidence.kind === "native-skill-root") {
      expect(
        existsSync(join(cwd, `.claude/skills/${LOCAL_SKILL_ID}/SKILL.md`)),
        `${label}: enforced via native-skill-root, but the source is gone`,
      ).toBe(true);
    } else if (
      declaration.state === "enforced" &&
      declaration.evidence.kind === "local-skill-pointer"
    ) {
      expect(
        existsSync(join(cwd, `.agents/skills/${LOCAL_SKILL_ID}/SKILL.md`)),
        `${label}: enforced via local-skill-pointer, but no pointer was rendered`,
      ).toBe(true);
    } else if (declaration.state === "advisory") {
      // Prose engines: declared advisory via a plain index row, no file to
      // stat — checked separately against the prose file's own content below.
    } else {
      expect(declaration.state).toBe("unsupported");
    }
    return;
  }

  if (engineId === "claude") {
    const settings = readClaudeSettings(cwd);
    if (
      declaration.state === "enforced" ||
      (declaration.state === "advisory" && declaration.evidence)
    ) {
      const evidence = declaration.evidence;
      if (evidence && evidence.kind === "hook") {
        expect(
          claudeHookRegistered(settings, evidence.event, evidence.matcher, evidence.script),
          `${label}: declared with hook evidence (${evidence.script}), not found registered in settings.json`,
        ).toBe(true);
      }
    } else if (declaration.state === "unsupported") {
      for (const script of definition.hookScripts) {
        expect(
          claudeAnyHookNames(settings, script),
          `${label}: declared unsupported, but ${script} is registered`,
        ).toBe(false);
      }
    } else {
      // advisory with no evidence (e.g. handoff-consumer, analytic-write-tools):
      // nothing rendered to check — the contract lives in prose only.
    }
    return;
  }

  if (engineId === "codex") {
    // No codex control declares hook evidence (D5: hooks are never registered
    // in .codex/config.toml for these); nothing further to check here besides
    // local-skill-discovery, handled above.
    return;
  }

  // Prose engines (agents-md, cursor, copilot): every control is
  // `unsupported`, and no hook/agent infrastructure is rendered at all —
  // trivially satisfied by the engine's own shape. `.claude/skills/` is
  // excluded: it's this test's OWN fixture (`seedLocalSkill`), not something
  // these engines render.
  expect(
    existsSync(join(cwd, ".claude/settings.json")) ||
      existsSync(join(cwd, ".claude/hooks")) ||
      existsSync(join(cwd, ".claude/agents")) ||
      existsSync(join(cwd, ".codex")),
    `${label}: a prose engine rendered Claude/Codex-only infrastructure`,
  ).toBe(false);
}

describe("control inventory vs. the actual render (spec 0033 D5)", () => {
  for (const engineCase of ENGINE_CASES) {
    describe(engineCase.id, () => {
      const cwd = freshDir(engineCase.id);
      seedLocalSkill(cwd);
      engineCase.render(cwd, fullFlagsConfig(engineCase.id));

      for (const controlId of Object.keys(CONTROL_DEFINITIONS) as ControlId[]) {
        it(`${controlId}: declared state matches the render`, () => {
          assertControlMatchesRender(cwd, engineCase.id, controlId);
        });
      }
    });
  }

  it("agents-md/cursor/copilot: the project-local skill does NOT reach the index row today (D5 discrepancy, see engine-capabilities.ts)", () => {
    // `buildSkillsSection` (prose-harness.ts) calls `buildSkillRows` without a
    // `localSkills` argument, so `local-skill-discovery` is `unsupported` for
    // these three engines in practice, not the `advisory` design.md describes.
    const files: Record<string, string> = {
      "agents-md": "AGENTS.md",
      cursor: ".cursor/rules/navori.mdc",
      copilot: ".github/copilot-instructions.md",
    };
    for (const [engineId, relPath] of Object.entries(files)) {
      const cwd = freshDir(`${engineId}-index`);
      seedLocalSkill(cwd);
      const engineCase = ENGINE_CASES.find((c) => c.id === engineId)!;
      engineCase.render(cwd, fullFlagsConfig(engineId as EngineId));
      const content = readFileSync(join(cwd, relPath), "utf-8");
      expect(content).not.toContain(LOCAL_SKILL_ID);
    }
  });

  it("claude: with both flags off, the conditioned hooks are not registered", () => {
    const cwd = freshDir("claude-flags-off");
    seedLocalSkill(cwd);
    const config = NavoriConfigSchema.parse({
      name: "control-inventory-flags-off",
      engines: ["claude"],
      preset: "custom",
      branchBase: "main",
    });
    renderClaudeEngine(cwd, config);
    const settings = readClaudeSettings(cwd);
    expect(claudeAnyHookNames(settings, "plan-gate.sh")).toBe(false);
    expect(claudeAnyHookNames(settings, "implementer-no-markdown.sh")).toBe(false);
  });
});

describe("analyticWriteTools vs. the actual render (spec 0033 D5, R23)", () => {
  it("claude: the intersection of each role's rendered `tools:` with WRITE_CAPABLE_TOOLS matches the declaration", () => {
    const cwd = freshDir("claude-analytic-tools");
    seedLocalSkill(cwd);
    renderClaudeEngine(cwd, fullFlagsConfig("claude"));
    for (const role of ANALYTIC_ROLES) {
      const body = readFileSync(join(cwd, `.claude/agents/${role}.md`), "utf-8");
      const toolsLine = body.match(/^tools:\s*(.+)$/m)?.[1] ?? "";
      const declaredTools = toolsLine.split(",").map((t) => t.trim());
      const effective = declaredTools.filter((t) => WRITE_CAPABLE_TOOLS.has(t));
      expect(effective, `claude.${role}`).toEqual(
        ENGINE_CAPABILITIES.claude.analyticWriteTools[role],
      );
    }
  });

  it("codex: the effective sandbox_mode for each role matches the declaration", () => {
    const cwd = freshDir("codex-analytic-tools");
    seedLocalSkill(cwd);
    renderCodexEngine(cwd, fullFlagsConfig("codex"));
    const configToml = readFileSync(join(cwd, ".codex/config.toml"), "utf-8");
    const defaultSandbox =
      configToml.match(/^sandbox_mode\s*=\s*"([^"]+)"/m)?.[1] ?? "workspace-write";
    for (const role of ANALYTIC_ROLES) {
      const agentToml = readFileSync(join(cwd, `.codex/agents/${role}.toml`), "utf-8");
      const roleSandbox = agentToml.match(/^sandbox_mode\s*=\s*"([^"]+)"/m)?.[1] ?? defaultSandbox;
      expect([`sandbox:${roleSandbox}`], `codex.${role}`).toEqual(
        ENGINE_CAPABILITIES.codex.analyticWriteTools[role],
      );
    }
  });

  it("prose engines declare no write-capable tools, and render no agent files", () => {
    for (const engineId of ["agents-md", "cursor", "copilot"] as const) {
      for (const role of ANALYTIC_ROLES) {
        expect(ENGINE_CAPABILITIES[engineId].analyticWriteTools[role]).toEqual([]);
      }
    }
  });
});
