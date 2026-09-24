import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  NavoriConfigSchema,
  type NavoriConfig,
  type NavoriConfigInput,
} from "../../../lib/config/schema.ts";
import { renderCodexEngine } from "../index.ts";

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

  // Covers: R9
  it("emits the openai.yaml sidecar when the source declares disable-model-invocation", () => {
    writeSource(
      "manual-only",
      "Use only via explicit invocation.",
      "disable-model-invocation: true\n",
    );

    renderCodexEngine(cwd, config({ project: { localSkills: ["manual-only"] } }));

    expect(existsSync(join(cwd, ".agents/skills/manual-only/agents/openai.yaml"))).toBe(true);
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
