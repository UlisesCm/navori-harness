import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { NavoriConfigSchema, type NavoriConfig } from "../../lib/config/schema.ts";
import { renderAgentsMdEngine } from "../agents-md/index.ts";
import { renderClaudeEngine } from "../claude/index.ts";
import { CODEX_HOOK_REGISTRATIONS } from "../codex/hook-registrations.ts";
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
    harness: { planTiers: true, masterPlan: true, scribeOwnsMarkdown: true },
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

/**
 * Spec 0035 T4/R8 — one `[[hooks.<event>]]` group followed by its sibling
 * `[[hooks.<event>.hooks]]` block, the shape `buildCodexConfigToml` emits for
 * every row `resolveCodexHooks` returns (see build-config-toml.ts). Captures
 * the group's own `matcher` (absent when the row has none) and the nested
 * block's `command`, so a match requires the exact event+matcher pair, not
 * just the script appearing somewhere in the file.
 */
const CODEX_HOOK_GROUP_RE =
  /\[\[hooks\.(\w+)\]\]\n(?:matcher = "((?:[^"\\]|\\.)*)"\n)?\n\[\[hooks\.\1\.hooks\]\]\n(?:[^\n]*\n)*?command = "((?:[^"\\]|\\.)*)"/g;

/** Whether `.codex/config.toml`'s text registers `script` on `event` with
 *  exactly `matcher` (R8). */
function codexHookRegistered(
  configToml: string,
  event: string,
  matcher: string,
  script: string,
): boolean {
  for (const m of configToml.matchAll(CODEX_HOOK_GROUP_RE)) {
    if (m[1] === event && (m[2] ?? "") === matcher && (m[3] ?? "").includes(script)) return true;
  }
  return false;
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
        expect(
          existsSync(join(cwd, `.claude/hooks/${evidence.script}`)),
          `${label}: registered hook ${evidence.script} has no rendered executable`,
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
    // Spec 0035 R7/R8: enforced controls require exact hook evidence.
    // Covers: R6, R7, R8
    if (declaration.state === "enforced" && declaration.evidence.kind === "hook") {
      const configToml = readFileSync(join(cwd, ".codex/config.toml"), "utf-8");
      const evidence = declaration.evidence;
      expect(
        codexHookRegistered(configToml, evidence.event, evidence.matcher, evidence.script),
        `${label}: declared enforced with hook evidence (${evidence.script}), not found registered ` +
          `as ${evidence.event}(${evidence.matcher}) in .codex/config.toml`,
      ).toBe(true);
    }
    if (controlId === "plan-gate") {
      const configToml = readFileSync(join(cwd, ".codex/config.toml"), "utf-8");
      expect(declaration.state).toBe("advisory");
      expect(declaration.reason).toContain("Codex 0.158.0");
      expect(declaration.reason).toContain("no typed agent role");
      expect(configToml).not.toContain("plan-gate.sh");
      expect(configToml).toContain("implementer-no-markdown.sh");
    }
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
    for (const script of ["master-plan-context.sh", "master-accept-confirm.sh"]) {
      expect(existsSync(join(cwd, `.claude/hooks/${script}`))).toBe(true);
      expect(claudeAnyHookNames(settings, script)).toBe(false);
    }
  });

  it("codex: does not render Claude-only master-plan hooks", () => {
    const cwd = freshDir("codex-master-plan");
    renderCodexEngine(cwd, fullFlagsConfig("codex"));
    expect(existsSync(join(cwd, ".codex/hooks/master-plan-context.sh"))).toBe(false);
    expect(existsSync(join(cwd, ".codex/hooks/master-accept-confirm.sh"))).toBe(false);
  });

  // Covers: R13, R14, R21
  it("qualifies the plan gate by engine without promoting Codex's advisory control", () => {
    const claudeDir = freshDir("claude-plan-claim");
    const codexDir = freshDir("codex-plan-claim");
    renderClaudeEngine(claudeDir, fullFlagsConfig("claude"));
    renderCodexEngine(codexDir, fullFlagsConfig("codex"));

    const claudePlan = readFileSync(
      join(claudeDir, ".claude/context/05-planificacion.md"),
      "utf-8",
    );
    const codexPlan = readFileSync(join(codexDir, "AGENTS.md"), "utf-8");
    const claudeSettings = readClaudeSettings(claudeDir);
    const codexConfig = readFileSync(join(codexDir, ".codex/config.toml"), "utf-8");

    expect(claudePlan).toMatch(/Claude Code[^\n]*plan-gate[^\n]*hook/i);
    expect(claudePlan).not.toContain("A hook denies dispatching");
    expect(claudeHookRegistered(claudeSettings, "PreToolUse", "Agent", "plan-gate.sh")).toBe(true);

    expect(codexPlan).toMatch(/Codex[^\n]*plan-gate[^\n]*advisory/i);
    expect(codexPlan).not.toContain("A hook denies dispatching");
    expect(codexConfig).not.toContain("plan-gate.sh");
    expect(ENGINE_CAPABILITIES.codex.controls["plan-gate"].state).toBe("advisory");
    expect(ENGINE_CAPABILITIES.claude.controls["plan-gate"].state).toBe("enforced");
  });

  // Covers: R10
  it("keeps plan-gate unregistered in Codex and the routing-watch matcher unchanged", () => {
    const row = CODEX_HOOK_REGISTRATIONS.find((r) => r.script === "plan-gate");
    expect(row?.registration).toBeUndefined();
    expect(row?.unsupported).toContain("explicit agent_type spawn exposes the typed role in Pre");
    expect(row?.unsupported).toContain("stays advisory");
    const routing = CODEX_HOOK_REGISTRATIONS.find((r) => r.script === "routing-watch");
    expect(routing?.registration?.event).toBe("PostToolUse");
    expect(routing?.registration?.matcher).toBe("^(Bash|apply_patch|spawn_agent)$");
  });

  // Covers: R16
  it("declares repeat-failure advice for Claude and unsupported for Codex", () => {
    const row = CODEX_HOOK_REGISTRATIONS.find((r) => r.script === "bash-outcome-watch");
    expect(row?.registration).toBeUndefined();
    expect(row?.unsupported).toContain("does not distinguish Bash success from failure");
    expect(ENGINE_CAPABILITIES.claude.controls["repeat-failure-advice"].state).toBe("advisory");
    expect(ENGINE_CAPABILITIES.codex.controls["repeat-failure-advice"].state).toBe("unsupported");
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

  // Covers: R20
  it("codex: analytic roles inherit the declared full-access default", () => {
    const cwd = freshDir("codex-analytic-tools");
    seedLocalSkill(cwd);
    renderCodexEngine(cwd, fullFlagsConfig("codex"));
    const configToml = readFileSync(join(cwd, ".codex/config.toml"), "utf-8");
    const defaultSandbox = configToml.match(/^sandbox_mode\s*=\s*"([^"]+)"/m)?.[1];
    expect(defaultSandbox).toBe("danger-full-access");
    expect(configToml).toContain('approval_policy = "on-request"');
    expect(configToml).toContain('approvals_reviewer = "user"');
    expect(configToml).not.toContain('approval_policy = "never"');
    expect(configToml).not.toContain('approvals_reviewer = "auto_review"');
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

  // Covers: R60
  it("codex keeps master-plan unsupported: no skill and no master hooks are rendered", () => {
    expect(ENGINE_CAPABILITIES.codex.controls["master-plan"].state).toBe("unsupported");
    const cwd = freshDir("codex-master-plan-unsupported");
    renderCodexEngine(cwd, fullFlagsConfig("codex"));
    expect(existsSync(join(cwd, ".agents/skills/master-plan/SKILL.md"))).toBe(false);
    expect(existsSync(join(cwd, ".codex/skills/master-plan/SKILL.md"))).toBe(false);
  });
});

// Covers: R10
describe("acceptance-evidence control", () => {
  it("is advisory for Claude and unsupported for Codex and prose engines", () => {
    expect(ENGINE_CAPABILITIES.claude.controls["acceptance-evidence"].state).toBe("advisory");
    for (const id of ["codex", "agents-md", "cursor", "copilot"] as const) {
      expect(ENGINE_CAPABILITIES[id].controls["acceptance-evidence"].state).toBe("unsupported");
    }
    expect(CONTROL_DEFINITIONS["acceptance-evidence"].hookScripts).toEqual([]);
  });
});
