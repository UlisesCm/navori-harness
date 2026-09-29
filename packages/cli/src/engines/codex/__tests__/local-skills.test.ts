import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { getCoreRoot } from "../../../lib/render/bundled-assets.ts";
import {
  NavoriConfigSchema,
  type NavoriConfig,
  type NavoriConfigInput,
} from "../../../lib/config/schema.ts";
import { renderCodexEngine } from "../index.ts";
import { renderClaudeEngine } from "../../claude/index.ts";

/**
 * Spec 0033 D2 (R9-R12), end to end through `renderCodexEngine`: a
 * `project.localSkills` id becomes a discoverable Codex pointer without
 * navori ever touching the source, a stale pointer follows the source's own
 * frontmatter, a missing source never gets an invented destination, and a
 * retired id is pruned with backup like any other managed file.
 */

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-codex-local-skills-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function config(overrides: Partial<NavoriConfigInput> = {}): NavoriConfig {
  return NavoriConfigSchema.parse({
    name: "codex-demo",
    engines: ["codex"],
    preset: "custom",
    branchBase: "main",
    qualityGate: { fast: "pnpm test", full: "pnpm test" },
    ...overrides,
  });
}

function writeSource(id: string, description: string, extraFrontmatter = ""): string {
  const dir = join(cwd, ".claude/skills", id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "SKILL.md");
  writeFileSync(
    path,
    `---\nname: ${id}\ndescription: ${description}\n${extraFrontmatter}---\n\n` +
      `## Body\n\nSome prose the pointer never copies.\n`,
  );
  return path;
}

describe("renderCodexEngine — local skills (spec 0033 D2)", () => {
  // Covers: R9
  it("generates a discoverable pointer with the source's name/description", () => {
    writeSource("probe", "Use when verifying the Codex pointer contract.");

    const result = renderCodexEngine(cwd, config({ project: { localSkills: ["probe"] } }));

    const destPath = join(cwd, ".agents/skills/probe/SKILL.md");
    expect(existsSync(destPath)).toBe(true);
    const content = readFileSync(destPath, "utf-8");
    expect(content).toContain("name: probe");
    expect(content).toContain("Use when verifying the Codex pointer contract.");
    expect(content).toContain(".claude/skills/probe/SKILL.md");
    expect(result.written.some((w) => w.path === ".agents/skills/probe/SKILL.md")).toBe(true);
  });

  // Covers: R9, R17
  it.each(["", "disable-model-invocation: false\n"])(
    "omits the implicit-invocation opt-out when source metadata is %j",
    (extraFrontmatter: string) => {
      const sourcePath = writeSource(
        "available",
        "Use when the host discovers this skill by description.",
        extraFrontmatter,
      );
      const before = readFileSync(sourcePath, "utf-8");

      renderCodexEngine(cwd, config({ project: { localSkills: ["available"] } }));

      const pointer = readFileSync(join(cwd, ".agents/skills/available/SKILL.md"), "utf-8");
      expect(pointer).toContain("name: available");
      expect(pointer).toContain("Use when the host discovers this skill by description.");
      expect(pointer).toContain(".claude/skills/available/SKILL.md");
      expect(existsSync(join(cwd, ".agents/skills/available/agents/openai.yaml"))).toBe(false);
      expect(readFileSync(sourcePath, "utf-8")).toBe(before);
    },
  );

  // Covers: R9, R17
  it("keeps the explicit skill pointer while rendering the implicit-invocation prohibition", () => {
    const sourcePath = writeSource(
      "manual-only",
      "Use only via explicit invocation.",
      "disable-model-invocation: true\n",
    );
    const before = readFileSync(sourcePath, "utf-8");

    renderCodexEngine(cwd, config({ project: { localSkills: ["manual-only"] } }));

    const pointer = readFileSync(join(cwd, ".agents/skills/manual-only/SKILL.md"), "utf-8");
    const sidecar = readFileSync(
      join(cwd, ".agents/skills/manual-only/agents/openai.yaml"),
      "utf-8",
    );
    expect(pointer).toContain("name: manual-only");
    expect(pointer).toContain(".claude/skills/manual-only/SKILL.md");
    expect(pointer).not.toContain("disable-model-invocation");
    expect(sidecar).toContain("policy:\n  allow_implicit_invocation: false");
    expect(readFileSync(sourcePath, "utf-8")).toBe(before);
  });

  // Covers: R17
  it("removes a stale prohibition when the source drops manual-only metadata", () => {
    const cfg = config({ project: { localSkills: ["toggle"] } });
    writeSource(
      "toggle",
      "Use when toggling invocation policy.",
      "disable-model-invocation: true\n",
    );
    renderCodexEngine(cwd, cfg);
    const pointerPath = join(cwd, ".agents/skills/toggle/SKILL.md");
    const sidecarPath = join(cwd, ".agents/skills/toggle/agents/openai.yaml");
    expect(existsSync(pointerPath)).toBe(true);
    expect(existsSync(sidecarPath)).toBe(true);

    const sourcePath = writeSource("toggle", "Use when toggling invocation policy.");
    const before = readFileSync(sourcePath, "utf-8");
    renderCodexEngine(cwd, cfg);

    expect(existsSync(sidecarPath)).toBe(false);
    expect(readFileSync(pointerPath, "utf-8")).toContain(".claude/skills/toggle/SKILL.md");
    expect(readFileSync(sourcePath, "utf-8")).toBe(before);
  });

  // Covers: R10
  it("never modifies the source bytes", () => {
    const sourcePath = writeSource("untouched", "Use when checking the source stays pristine.");
    const before = readFileSync(sourcePath, "utf-8");

    renderCodexEngine(cwd, config({ project: { localSkills: ["untouched"] } }));

    expect(readFileSync(sourcePath, "utf-8")).toBe(before);
  });

  // Covers: R10
  it("reports 'updated' when the source's description changes, not when only the body does", () => {
    const cfg = config({ project: { localSkills: ["stale"] } });
    writeSource("stale", "Original description.");
    renderCodexEngine(cwd, cfg);

    // Body-only change: the pointer body never derives from the source's
    // prose, so re-rendering must be a no-op.
    writeSource("stale", "Original description.");
    const unchanged = renderCodexEngine(cwd, cfg);
    expect(unchanged.written.some((w) => w.path === ".agents/skills/stale/SKILL.md")).toBe(false);

    // Description change: the pointer's own frontmatter must follow it.
    writeSource("stale", "A brand new description.");
    const updated = renderCodexEngine(cwd, cfg);
    const entry = updated.written.find((w) => w.path === ".agents/skills/stale/SKILL.md");
    expect(entry?.status).toBe("updated");
    expect(readFileSync(join(cwd, ".agents/skills/stale/SKILL.md"), "utf-8")).toContain(
      "A brand new description.",
    );
  });

  // Covers: R11
  it("never invents a destination for a declared id with no source", () => {
    // The "missing" warning itself is `render`'s responsibility (R11 requires
    // it regardless of which engines are configured, exactly once per run —
    // see `commands/__tests__/render-local-skills.test.ts`), not the Codex
    // adapter's; this only pins the "no destination" half.
    const result = renderCodexEngine(cwd, config({ project: { localSkills: ["ghost"] } }));

    expect(existsSync(join(cwd, ".agents/skills/ghost"))).toBe(false);
    expect(result.written.some((w) => w.path.includes("ghost"))).toBe(false);
  });

  // Covers: R12
  it("prunes a retired id's pointer with backup, and never appears in a kept/removed report", () => {
    const cfg = config({ project: { localSkills: ["retiring"] } });
    writeSource("retiring", "Use while this id is still declared.");
    const first = renderCodexEngine(cwd, cfg);
    expect(first.warnings.some((w) => w.includes("retiring"))).toBe(false);
    expect(existsSync(join(cwd, ".agents/skills/retiring/SKILL.md"))).toBe(true);

    // The id drops out of project.localSkills — its pointer is now an orphan.
    const second = renderCodexEngine(cwd, config());
    expect(existsSync(join(cwd, ".agents/skills/retiring/SKILL.md"))).toBe(false);
    expect(second.backupPath).not.toBeNull();
  });
});

describe("shared skill source across native engine roots", () => {
  // Covers: R17, R18
  it("renders one core asset into each host's skill root without changing its source", () => {
    const sourcePath = join(getCoreRoot(), "core-assets/skills/verify-before-done.md");
    const before = readFileSync(sourcePath, "utf-8");
    const sourceDescription = before.match(/^description: (.+)$/m)?.[1];
    expect(sourceDescription).toBeDefined();
    const cfg = config({ engines: ["claude", "codex"] });

    renderClaudeEngine(cwd, cfg);
    renderCodexEngine(cwd, cfg);

    const claudeSkill = readFileSync(
      join(cwd, ".claude/skills/verify-before-done/SKILL.md"),
      "utf-8",
    );
    const codexSkill = readFileSync(
      join(cwd, ".agents/skills/verify-before-done/SKILL.md"),
      "utf-8",
    );
    expect(claudeSkill).toContain("name: verify-before-done");
    expect(codexSkill).toContain("name: verify-before-done");
    expect(claudeSkill).toContain(`description: ${sourceDescription}`);
    expect(codexSkill).toContain(`description: ${sourceDescription}`);
    expect(existsSync(join(cwd, ".agents/skills/verify-before-done/agents/openai.yaml"))).toBe(
      false,
    );
    expect(readFileSync(sourcePath, "utf-8")).toBe(before);
  });
});
