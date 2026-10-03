import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NavoriConfigSchema, type NavoriConfig } from "../../lib/config/schema.ts";
import { renderClaudeEngine } from "../claude/index.ts";
import { renderCodexEngine } from "../codex/index.ts";
import { CODEX_HOOK_REGISTRATIONS } from "../codex/hook-registrations.ts";
import { CODEX_PARITY } from "../shared/codex-parity.ts";

/**
 * Inventory-parity guard between the Claude and Codex engines (Spec 0007 M1).
 * Both engines must materialize the SAME semantic set of agents, shared skills
 * and hooks for a given config — except explicit engine-only assets. An asset wired into
 * one engine but forgotten in the other fails here, not in production repos
 * after a rollout.
 *
 * Skills also assert FORM, not just names (issue #161 C2): both engines must
 * materialize the DISCOVERABLE `<id>/SKILL.md` directory shape. The original
 * name-only check passed even while Claude wrote inert flat `<id>.md` files
 * (#166 C1) — the eje that actually decides whether the model ever sees a skill.
 */

/** Intentional inventory differences. orchestrator: the main Codex thread
 * embodies the orchestrator role, so the Codex engine deliberately emits no
 * spawnable orchestrator agent (see resolveHarnessPlan's includeOrchestrator
 * option in engines/shared/harness-plan.ts). */
const AGENT_KNOWN_DIFFS: ReadonlySet<string> = new Set(["orchestrator"]);

/**
 * Spec 0041 T15: the master-plan hooks are scoped to claude and codex, but Codex
 * installs a script only when a registration runs it, and both registrations are
 * conditional on `harness.masterPlan` (off in this fixture, like
 * `implementer-no-markdown`).
 */
const MASTER_PLAN_HOOKS: ReadonlySet<string> = new Set([
  "master-accept-confirm",
  "master-plan-context",
]);

function parityConfig(): NavoriConfig {
  return NavoriConfigSchema.parse({
    name: "parity-demo",
    engines: ["claude", "codex"],
    preset: "custom",
    branchBase: "main",
    qualityGate: { fast: "pnpm test", full: "pnpm test" },
    plugins: { engram: { enabled: true } },
    project: { libraries: ["zod-validation"] },
  });
}

/** Sorted entry names under `dir` mapped through `strip`; [] if missing. */
function names(dir: string, strip: (name: string) => string | null): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .map(strip)
    .filter((n): n is string => n !== null)
    .sort();
}

const stripMd = (n: string): string | null => (n.endsWith(".md") ? n.slice(0, -3) : null);
const stripToml = (n: string): string | null => (n.endsWith(".toml") ? n.slice(0, -5) : null);
const stripSh = (n: string): string | null => (n.endsWith(".sh") ? n.slice(0, -3) : null);
const asDir = (n: string): string | null => (n.startsWith(".") ? null : n);
/** A skill materialized in discoverable directory form: `<dir>/<id>/SKILL.md`. */
const isSkillDir = (dir: string, id: string): boolean => existsSync(join(dir, id, "SKILL.md"));

let claudeCwd: string;
let codexCwd: string;

beforeEach(() => {
  claudeCwd = mkdtempSync(join(tmpdir(), "navori-parity-claude-"));
  codexCwd = mkdtempSync(join(tmpdir(), "navori-parity-codex-"));
  const config = parityConfig();
  renderClaudeEngine(claudeCwd, config);
  renderCodexEngine(codexCwd, config);
});

afterEach(() => {
  rmSync(claudeCwd, { recursive: true, force: true });
  rmSync(codexCwd, { recursive: true, force: true });
});

describe("engine inventory parity (claude ↔ codex)", () => {
  // Covers: R1, R2, R3
  it("renders scribe with the equivalent Claude/Codex tier and preserves the requested profiles", () => {
    const config = NavoriConfigSchema.parse({
      name: "scribe-profile-parity",
      engines: ["claude", "codex"],
      preset: "custom",
      branchBase: "main",
      qualityGate: { fast: "pnpm test", full: "pnpm test" },
      // `architect` always renders since spec 0032 R33 retired its
      // `harness.architect` toggle — no harness override needed here.
      models: { orchestrator: "opus", architect: "opus", scribe: "haiku" },
      effort: { orchestrator: "medium", architect: "high", scribe: "low" },
    });
    const claude = mkdtempSync(join(tmpdir(), "navori-scribe-claude-"));
    const codex = mkdtempSync(join(tmpdir(), "navori-scribe-codex-"));
    try {
      renderClaudeEngine(claude, config);
      renderCodexEngine(codex, config);

      const claudeScribe = readFileSync(join(claude, ".claude/agents/scribe.md"), "utf-8");
      const claudeArchitect = readFileSync(join(claude, ".claude/agents/architect.md"), "utf-8");
      const codexScribe = readFileSync(join(codex, ".codex/agents/scribe.toml"), "utf-8");
      const codexArchitect = readFileSync(join(codex, ".codex/agents/architect.toml"), "utf-8");

      expect(claudeScribe).toContain("model: haiku");
      expect(claudeScribe).toContain("effort: low");
      expect(codexScribe).toContain('model = "gpt-6-luna"');
      expect(codexScribe).toContain('model_reasoning_effort = "low"');
      expect(claudeArchitect).toContain("model: opus");
      expect(claudeArchitect).toContain("effort: high");
      expect(codexArchitect).toContain('model = "gpt-6-sol"');
      expect(codexArchitect).toContain('model_reasoning_effort = "high"');
    } finally {
      rmSync(claude, { recursive: true, force: true });
      rmSync(codex, { recursive: true, force: true });
    }
  });

  // Covers: R1
  it("emits the same skill set, master-plan skills included", () => {
    // Both engines materialize skills as `<id>/SKILL.md` directories now, so
    // read directory names on both sides (a flat `<id>.md` would NOT count).
    const claudeSkills = names(join(claudeCwd, ".claude/skills"), asDir);
    const codexSkills = names(join(codexCwd, ".agents/skills"), asDir);
    expect(claudeSkills.length).toBeGreaterThan(0);
    expect(codexSkills).toEqual(claudeSkills);
    for (const id of ["context-intake", "master-plan"]) expect(codexSkills).toContain(id);
  });

  // Covers: R1
  it("materializes every skill in the DISCOVERABLE `<id>/SKILL.md` directory form (C1/C2)", () => {
    const claudeDir = join(claudeCwd, ".claude/skills");
    const codexDir = join(codexCwd, ".agents/skills");
    const claudeSkills = names(claudeDir, asDir);
    expect(claudeSkills.length).toBeGreaterThan(0);
    for (const id of claudeSkills) {
      // Claude Code auto-discovers skills ONLY in directory form; the inert flat
      // `<id>.md` must NOT coexist (it would make the model see the skill twice).
      expect(isSkillDir(claudeDir, id)).toBe(true);
      expect(existsSync(join(claudeDir, `${id}.md`))).toBe(false);
      expect(isSkillDir(codexDir, id)).toBe(true);
    }
  });

  it("emits the same agent set (minus known diffs)", () => {
    const claudeAgents = names(join(claudeCwd, ".claude/agents"), stripMd).filter(
      (id) => !AGENT_KNOWN_DIFFS.has(id),
    );
    const codexAgents = names(join(codexCwd, ".codex/agents"), stripToml).filter(
      (id) => !AGENT_KNOWN_DIFFS.has(id),
    );
    // `names()` answers [] for a directory that isn't there, so a renamed
    // destination on BOTH sides used to satisfy this as `[] === []` (#504).
    expect(claudeAgents.length).toBeGreaterThan(0);
    expect(codexAgents).toEqual(claudeAgents);
  });

  it("keeps `orchestrator` a REAL diff: emitted by Claude, absent from Codex", () => {
    // The exemption above is subtracted from both sides, so on its own it hides
    // both regressions it is meant to describe: Codex growing a spawnable
    // orchestrator (the main thread already embodies the role) or Claude
    // losing one. Asserted here, the entry has to keep earning its place in
    // AGENT_KNOWN_DIFFS.
    expect(names(join(claudeCwd, ".claude/agents"), stripMd)).toContain("orchestrator");
    expect(names(join(codexCwd, ".codex/agents"), stripToml)).not.toContain("orchestrator");
  });

  it("emits the same shared hook set; the two master-plan hooks wait for harness.masterPlan on Codex", () => {
    const claudeHooks = names(join(claudeCwd, ".claude/hooks"), stripSh);
    const codexHooks = names(join(codexCwd, ".codex/hooks"), stripSh);
    // Same trap as the agent set: pin non-empty before comparing.
    expect(claudeHooks.length).toBeGreaterThan(0);
    expect(claudeHooks.filter((hook) => MASTER_PLAN_HOOKS.has(hook))).toEqual(
      [...MASTER_PLAN_HOOKS].sort(),
    );
    expect(codexHooks.filter((hook) => MASTER_PLAN_HOOKS.has(hook))).toEqual([]);
    // Spec 0041 R13/R30: Codex installs only scripts a registration runs, so the
    // table's `unsupported` rows are absent (and `implementer-no-markdown` is
    // conditional on `scribeOwnsMarkdown`, off in this fixture).
    const notInstalled = new Set([
      ...CODEX_HOOK_REGISTRATIONS.filter((row) => row.registration === undefined).map(
        (row) => row.script,
      ),
      "implementer-no-markdown",
      ...MASTER_PLAN_HOOKS,
    ]);
    // Spec 0041 D5: `role-guard` is Codex-only, so it is the one Codex hook with no Claude copy.
    expect(claudeHooks).not.toContain("role-guard");
    expect(codexHooks).toContain("role-guard");
    expect(codexHooks.filter((hook) => hook !== "role-guard")).toEqual(
      claudeHooks.filter((hook) => !notInstalled.has(hook)),
    );
  });

  // Covers: R3, R18
  it("every Claude hook is registered for Codex or declared unsupported", () => {
    // Both engines copy the same hook scripts to disk (asserted above); this
    // checks REGISTRATION, spec 0035's actual gap — a script Codex copies but
    // never wires into `.codex/config.toml` is dead weight, not parity.
    const claudeHooks = names(join(claudeCwd, ".claude/hooks"), stripSh);
    const tableScripts = new Set(CODEX_HOOK_REGISTRATIONS.map((row) => row.script));
    for (const script of claudeHooks) {
      expect(tableScripts.has(script)).toBe(true);
    }
    for (const row of CODEX_HOOK_REGISTRATIONS) {
      // A hook Codex does not register is declared `limite-codex` in the parity
      // table, with a non-empty reason (R3); a registered one never is.
      const parity = CODEX_PARITY[`hook:${row.script}`];
      expect(parity, `hook:${row.script}`).toBeDefined();
      expect(parity?.state === "limite-codex").toBe(row.registration === undefined);
      if (parity?.state === "limite-codex") {
        expect(parity.containment?.length ?? 0).toBeGreaterThan(0);
      }
    }
  });

  // Covers: R16
  it("`model:` in Claude iff `model` in Codex, per role", () => {
    const hasClaudeModel = (md: string): boolean => /^model:\s*\S/m.test(md);
    const hasCodexModel = (toml: string): boolean => /^model\s*=\s*"[^"]+"/m.test(toml);
    const configs: Array<[string, NavoriConfig]> = [
      ["defaults", parityConfig()],
      [
        "partial models",
        NavoriConfigSchema.parse({
          name: "model-symmetry",
          engines: ["claude", "codex"],
          preset: "custom",
          branchBase: "main",
          qualityGate: { fast: "pnpm test", full: "pnpm test" },
          models: { scribe: "haiku", architect: "opus" },
        }),
      ],
    ];
    for (const [label, config] of configs) {
      const claude = mkdtempSync(join(tmpdir(), "navori-model-claude-"));
      const codex = mkdtempSync(join(tmpdir(), "navori-model-codex-"));
      try {
        renderClaudeEngine(claude, config);
        renderCodexEngine(codex, config);
        const roles = names(join(codex, ".codex/agents"), stripToml);
        expect(roles.length, label).toBeGreaterThan(0);
        for (const role of roles) {
          const md = readFileSync(join(claude, `.claude/agents/${role}.md`), "utf-8");
          const toml = readFileSync(join(codex, `.codex/agents/${role}.toml`), "utf-8");
          expect(hasCodexModel(toml), `${label}: ${role}`).toBe(hasClaudeModel(md));
        }
      } finally {
        rmSync(claude, { recursive: true, force: true });
        rmSync(codex, { recursive: true, force: true });
      }
    }
  });
});
