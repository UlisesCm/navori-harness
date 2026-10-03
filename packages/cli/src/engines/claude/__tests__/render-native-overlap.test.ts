import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it, expect } from "vitest";
import type { NavoriConfig } from "../../../lib/config/config.ts";
import { getCoreRoot } from "../../../lib/render/bundled-assets.ts";
import { resolveCodexHooks } from "../../codex/hook-registrations.ts";
import { resolveHarnessPlan } from "../../shared/harness-plan.ts";
import {
  OverlapRowSchema,
  filterInventory,
  nativeEmissionsFor,
  type OverlapRow,
} from "../../shared/native-overlap.ts";
import type { AdapterCtx } from "../../shared/execute-plan.ts";
import { commitWrites } from "../../shared/execute-plan.ts";
import { computeManagedHash, extractManagedContent } from "../../../lib/render/marker.ts";
import { planNativeRetirements } from "../index.ts";
import { renderManagedFile } from "../../shared/render-managed-file.ts";
import { removeManagedSectionGuarded } from "../../../lib/render/marker.ts";
import { createClaudeAdapter } from "../adapter.ts";
import { buildClaudeSettings } from "../build-settings.ts";

const CONFIG = {
  name: "t",
  engines: ["claude", "codex"],
  preset: "custom",
  version: "1.0.0",
  language: "es",
  branchBase: "main",
  commits: "conventional-es",
  qualityGate: { fast: "x", full: "y" },
  hooks: { verifyOnStop: true },
  harness: { planTiers: true, masterPlan: true },
} as unknown as NavoriConfig;

const SCRIPT = "routing-watch";

/** FIXTURE row: native on Claude only. No real row is native yet (spec 0039 T1). */
const FIXTURE: OverlapRow = {
  unit: { kind: "hook", id: SCRIPT },
  native: {
    capability: "fixture",
    url: "https://code.claude.com/docs/en/hooks",
    verifiedAt: "2026-09-30",
  },
  verdict: "reemplazar-por-nativo",
  codexParity: { state: "igual", enforcing: false },
  engines: {
    claude: "native",
    codex: "emit",
    pi: "unsupported",
    "agents-md": "emit",
    cursor: "emit",
    copilot: "emit",
  },
  nativeEmission: { kind: "settings-patch", detail: "fixture" },
  note: "fixture",
};

const plan = resolveHarnessPlan(CONFIG, resolve(getCoreRoot(), "core-assets"), null, {
  includeOrchestrator: true,
  includeClaudeOnlySkills: true,
  includeClaudeOnlyHooks: true,
});
const inventory = { plan, plugins: [] };

describe("native overlap fixture row (R4)", () => {
  // Covers: R3
  it("the fixture is itself a valid row", () => {
    expect(OverlapRowSchema.safeParse(FIXTURE).success).toBe(true);
  });

  // Covers: R4
  it("the control: unfiltered, the hook is planned and registered", () => {
    expect(plan.hooks.map((h) => h.id)).toContain(SCRIPT);
    expect(JSON.stringify(buildClaudeSettings(CONFIG, inventory))).toContain(`${SCRIPT}.sh`);
  });

  // Covers: R4
  it("Claude: the native unit is absent from the plan, the written files and settings.json", () => {
    const filtered = filterInventory(inventory, "claude", [FIXTURE]);
    expect(filtered.plan.hooks.map((h) => h.id)).not.toContain(SCRIPT);
    const adapter = createClaudeAdapter();
    const ctx: AdapterCtx = {
      cwd: "/tmp/unused",
      config: CONFIG,
      repoRoot: "/tmp/unused",
      isWorkspace: false,
      coreAssets: resolve(getCoreRoot(), "core-assets"),
      preset: null,
      plugins: [],
    };
    const written = filtered.plan.hooks.map((h) => adapter.placeHook(h, ctx)?.destRelPath);
    expect(written).not.toContain(`.claude/hooks/${SCRIPT}.sh`);
    expect(JSON.stringify(buildClaudeSettings(CONFIG, filtered))).not.toContain(SCRIPT);
  });

  // Covers: R4
  it("Claude: every core hook settings.json registers is a hook the filtered plan writes", () => {
    const filtered = filterInventory(inventory, "claude", [FIXTURE]);
    const settings = JSON.stringify(buildClaudeSettings(CONFIG, filtered));
    const registered = [...settings.matchAll(/\.claude\/hooks\/([a-z0-9-]+)\.sh/g)].map(
      (m) => m[1],
    );
    const written = new Set(filtered.plan.hooks.map((h) => h.id));
    expect(registered.length).toBeGreaterThan(0);
    expect(registered.filter((id) => !written.has(id as string))).toEqual([]);
  });

  // Covers: R4
  it("Codex and agents-md keep the unit; Codex still registers it", () => {
    for (const engine of ["codex", "agents-md", "cursor", "copilot"] as const) {
      const filtered = filterInventory(inventory, engine, [FIXTURE]);
      expect(
        filtered.plan.hooks.map((h) => h.id),
        engine,
      ).toContain(SCRIPT);
    }
    expect(resolveCodexHooks(CONFIG, [], [FIXTURE]).map((h) => h.script)).toContain(SCRIPT);
  });

  // Covers: R4
  it("a hook native on Codex is not registered there", () => {
    const codexNative: OverlapRow = {
      ...FIXTURE,
      engines: { ...FIXTURE.engines, claude: "emit", codex: "native" },
    };
    expect(resolveCodexHooks(CONFIG, [], [codexNative]).map((h) => h.script)).not.toContain(SCRIPT);
  });

  // Covers: R4
  it("nativeEmissionsFor reports the emission only for the engine where the unit is native", () => {
    expect(nativeEmissionsFor("claude", [FIXTURE])).toEqual([
      { unit: FIXTURE.unit, emission: FIXTURE.nativeEmission },
    ]);
    expect(nativeEmissionsFor("codex", [FIXTURE])).toEqual([]);
  });

  // Covers: R4
  it("with the real matrix (nothing native) the inventory is returned unchanged", () => {
    expect(filterInventory(inventory, "claude")).toBe(inventory);
  });
});

/** A shell file carrying one managed block with a valid hash, stamped `version`. */
function shellManaged(id: string, version: string, body = "echo hi"): string {
  const wrap = (hash: string): string =>
    `# navori:managed start id="${id}" hash="${hash}" version="${version}" source="@navori/core"\n${body}\n# navori:managed end id="${id}"\n`;
  const probe = extractManagedContent(wrap("x"), id, "shell") ?? "";
  return wrap(computeManagedHash(probe));
}

function htmlManaged(id: string, version: string, body = "hello"): string {
  const wrap = (hash: string): string =>
    `<!-- navori:managed id="${id}" hash="${hash}" version="${version}" source="@navori/core" -->\n${body}\n<!-- /navori:managed id="${id}" -->\n`;
  const probe = extractManagedContent(wrap("x"), id, "html") ?? "";
  return wrap(computeManagedHash(probe));
}

describe("native retirement of installed repos (R5)", () => {
  const hookRel = `.claude/hooks/${SCRIPT}.sh`;
  const marker = plan.hooks.find((h) => h.id === SCRIPT)!.managedId;

  function setup(content: string): string {
    const cwd = mkdtempSync(join(tmpdir(), "navori-native-"));
    mkdirSync(join(cwd, ".claude/hooks"), { recursive: true });
    writeFileSync(join(cwd, hookRel), content);
    return cwd;
  }

  function run(cwd: string, pending: { path: string; content: string; status: "updated" }[] = []) {
    const removals: { path: string; recursive?: boolean }[] = [];
    const warnings: string[] = [];
    planNativeRetirements({
      cwd,
      config: CONFIG,
      rows: [FIXTURE],
      plan,
      pending,
      removals,
      warnings,
      claudeMdPath: join(cwd, "CLAUDE.md"),
    });
    return { removals, warnings, pending };
  }

  // Covers: R5
  it("removes a pristine file through commitWrites, with a backup", () => {
    const cwd = setup(shellManaged(marker, "0.0.1"));
    const { removals, warnings } = run(cwd);
    expect(removals).toEqual([{ path: join(cwd, hookRel) }]);
    expect(warnings).toEqual([]);
    const { backupPath } = commitWrites({ pending: [], removals, cwd });
    expect(existsSync(join(cwd, hookRel))).toBe(false);
    expect(backupPath).not.toBeNull();
    const backedUp = readdirSync(backupPath!, { recursive: true }).map(String);
    expect(backedUp.some((f) => f.endsWith(`${SCRIPT}.sh`))).toBe(true);
  });

  // Covers: R5
  it("keeps and reports a file written by a newer navori", () => {
    const cwd = setup(shellManaged(marker, "999.0.0"));
    const { removals, warnings } = run(cwd);
    expect(removals).toEqual([]);
    expect(warnings.join("\n")).toMatch(/newer file/);
  });

  // Covers: R5
  it("keeps and reports a hand-edited block (hash mismatch)", () => {
    const cwd = setup(shellManaged(marker, "0.0.1").replace("echo hi", "echo edited"));
    const { removals, warnings } = run(cwd);
    expect(removals).toEqual([]);
    expect(warnings.join("\n")).toMatch(/modified file/);
  });

  // Covers: R5
  it("keeps and reports a file with user text outside the marker", () => {
    const cwd = setup(`${shellManaged(marker, "0.0.1")}\necho mine\n`);
    const { removals, warnings } = run(cwd);
    expect(removals).toEqual([]);
    expect(warnings.join("\n")).toMatch(/modified file/);
  });

  // Covers: R5
  it("leaves a path already in pending this run untouched", () => {
    const cwd = setup(shellManaged(marker, "0.0.1"));
    const { removals, warnings } = run(cwd, [
      { path: join(cwd, hookRel), content: "x", status: "updated" },
    ]);
    expect(removals).toEqual([]);
    expect(warnings).toEqual([]);
  });

  describe("managed blocks inside CLAUDE.md", () => {
    const BLOCK: OverlapRow = {
      ...FIXTURE,
      unit: { kind: "managed-block", id: "fixture-block" },
    };

    function runBlock(
      content: string,
      pending: { path: string; content: string; status: "updated" }[] = [],
    ) {
      const cwd = mkdtempSync(join(tmpdir(), "navori-native-"));
      writeFileSync(join(cwd, "CLAUDE.md"), content);
      const warnings: string[] = [];
      const claudeMdPath = join(cwd, "CLAUDE.md");
      planNativeRetirements({
        cwd,
        config: CONFIG,
        rows: [BLOCK],
        plan,
        pending,
        removals: [],
        warnings,
        claudeMdPath,
      });
      return { pending, warnings, claudeMdPath, cwd };
    }

    // Covers: R5
    it("removes a pristine block", () => {
      const r = runBlock(`intro\n${htmlManaged("fixture-block", "0.0.1")}outro\n`);
      expect(r.warnings).toEqual([]);
      expect(r.pending).toHaveLength(1);
      expect(r.pending[0]!.content).toBe("intro\noutro\n");
      expect(readFileSync(r.claudeMdPath, "utf-8")).toContain("fixture-block");
    });

    // Covers: R5
    it("keeps a block from a newer version", () => {
      const r = runBlock(htmlManaged("fixture-block", "999.0.0"));
      expect(r.pending).toEqual([]);
      expect(r.warnings.join("\n")).toMatch(/newer block/);
    });

    // Covers: R5
    it("keeps a block whose hash no longer matches", () => {
      const r = runBlock(htmlManaged("fixture-block", "0.0.1").replace("hello", "edited"));
      expect(r.pending).toEqual([]);
      expect(r.warnings.join("\n")).toMatch(/modified block/);
    });

    // Covers: R5
    it("skips CLAUDE.md when this run already wrote it", () => {
      const pending = [{ path: "", content: "w", status: "updated" as const }];
      const cwd = mkdtempSync(join(tmpdir(), "navori-native-"));
      writeFileSync(join(cwd, "CLAUDE.md"), htmlManaged("fixture-block", "0.0.1"));
      pending[0]!.path = join(cwd, "CLAUDE.md");
      const warnings: string[] = [];
      planNativeRetirements({
        cwd,
        config: CONFIG,
        rows: [BLOCK],
        plan,
        pending,
        removals: [],
        warnings,
        claudeMdPath: join(cwd, "CLAUDE.md"),
      });
      expect(pending).toHaveLength(1);
      expect(pending[0]!.content).toBe("w");
    });
  });
});

describe("requirePristine compares against what navori renders (R5)", () => {
  const AGENT: OverlapRow = { ...FIXTURE, unit: { kind: "agent", id: "scribe" } };
  const SKILL: OverlapRow = { ...FIXTURE, unit: { kind: "skill", id: "locate-code" } };
  const agentUnit = plan.agents.find((a) => a.id === "scribe")!;
  const skillUnit = plan.skills.find((s) => s.id === "locate-code")!;

  const fresh = (unit: { assetPath: string; managedId: string }): string =>
    renderManagedFile({
      assetPath: unit.assetPath,
      existingContent: null,
      managedId: unit.managedId,
      meta: { source: "@navori/core", version: "0.0.1" },
      config: CONFIG,
      commentStyle: "html",
    }).content;

  function runUnit(row: OverlapRow, rel: string, content: string) {
    const cwd = mkdtempSync(join(tmpdir(), "navori-native-"));
    mkdirSync(join(cwd, rel, ".."), { recursive: true });
    writeFileSync(join(cwd, rel), content);
    const removals: { path: string; recursive?: boolean }[] = [];
    const warnings: string[] = [];
    planNativeRetirements({
      cwd,
      config: CONFIG,
      rows: [row],
      plan,
      pending: [],
      removals,
      warnings,
      claudeMdPath: join(cwd, "CLAUDE.md"),
    });
    return { removals, warnings };
  }

  const agentRel = ".claude/agents/scribe.md";
  const skillRel = ".claude/skills/locate-code/SKILL.md";

  // Covers: R5
  it("removes an agent and a skill exactly as navori renders them", () => {
    expect(runUnit(AGENT, agentRel, fresh(agentUnit)).removals).toHaveLength(1);
    expect(runUnit(SKILL, skillRel, fresh(skillUnit)).removals).toHaveLength(1);
  });

  // Covers: R5
  it("still removes an agent whose tools carry a plugin's mcp__ grant", () => {
    const content = fresh(agentUnit).replace(/^tools: (.*)$/m, "tools: $1, mcp__engram__*");
    expect(content).toContain("mcp__engram__*");
    expect(runUnit(AGENT, agentRel, content).removals).toHaveLength(1);
  });

  // Covers: R5
  it.each([
    ["a user-added frontmatter key", (c: string) => c.replace("---\n", "---\nmyKey: secret\n")],
    ["a model the user set", (c: string) => c.replace("---\n", "---\nmodel: opus\n")],
    ["a changed tools list", (c: string) => c.replace(/^tools: (.*)$/m, "tools: $1, Bash")],
    ["a user heading", (c: string) => `${c}\n# My own notes\n`],
    ["a user HTML comment", (c: string) => `${c}\n<!-- my todo: keep this -->\n`],
    ["a heading plus a comment", (c: string) => `${c}\n## Mis reglas\n<!-- aqui -->\n`],
  ])("keeps and reports an agent with %s", (_name, mutate) => {
    const { removals, warnings } = runUnit(AGENT, agentRel, mutate(fresh(agentUnit)));
    expect(removals).toEqual([]);
    expect(warnings.join("\n")).toMatch(/modified file/);
  });

  // Covers: R5
  it("keeps a skill with a user-added frontmatter key or heading", () => {
    for (const mutate of [
      (c: string) => c.replace("---\n", "---\nmyKey: secret\n"),
      (c: string) => `${c}\n# My own notes\n`,
    ]) {
      const { removals, warnings } = runUnit(SKILL, skillRel, mutate(fresh(skillUnit)));
      expect(removals).toEqual([]);
      expect(warnings.join("\n")).toMatch(/modified file/);
    }
  });

  // Covers: R5
  it("keeps a hook that gained a frontmatter-like or comment line outside the block", () => {
    const hook = plan.hooks.find((h) => h.id === SCRIPT)!;
    const base = shellManaged(hook.managedId, "0.0.1");
    for (const content of [`${base}# mine\n`, `---\nk: v\n---\n${base}`]) {
      const cwd = mkdtempSync(join(tmpdir(), "navori-native-"));
      mkdirSync(join(cwd, ".claude/hooks"), { recursive: true });
      writeFileSync(join(cwd, `.claude/hooks/${SCRIPT}.sh`), content);
      const removals: { path: string }[] = [];
      planNativeRetirements({
        cwd,
        config: CONFIG,
        rows: [FIXTURE],
        plan,
        pending: [],
        removals,
        warnings: [],
        claudeMdPath: join(cwd, "CLAUDE.md"),
      });
      expect(removals).toEqual([]);
    }
  });

  // Covers: R5
  it("keeps a managed block that carries no version attribute", () => {
    const noVersion = htmlManaged("b", "0.0.1").replace(' version="0.0.1"', "");
    expect(removeManagedSectionGuarded(noVersion, "b")).toEqual({ kept: "modified" });
  });
});
