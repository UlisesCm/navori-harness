import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Hermetic on two axes (spec 0005 §6 safety): ~/.navori (backups) → throwaway
// home via the home.ts mock; the global render TARGET → a temp CLAUDE_CONFIG_DIR.
// Neither the real $HOME/.claude nor ~/.navori is ever touched.
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("../../lib/home.ts", () => ({
  safeHomedir: () => home.dir,
  globalConfigDir: () => process.env.CLAUDE_CONFIG_DIR || join(home.dir, ".claude"),
}));

const { runGlobalRender } = await import("../global.ts");
const { GlobalConfigSchema } = await import("../../lib/global-config.ts");

let claudeDir: string;
const savedEnv = process.env.CLAUDE_CONFIG_DIR;

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "global-launcher-home-"));
  claudeDir = mkdtempSync(join(tmpdir(), "global-launcher-claude-"));
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
});
afterEach(() => {
  rmSync(home.dir, { recursive: true, force: true });
  rmSync(claudeDir, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedEnv;
});

const cfg = (over = {}) => GlobalConfigSchema.parse({ language: "es", permissions: true, ...over });

// Fixtures live in a LOCAL `.navori/features/<id>/` override under the global
// target dir (which is `repoRoot` for a global render, since runGlobalRender
// never passes `repoRoot`) — same isolation pattern as
// engines/claude/__tests__/render-features.test.ts, so this suite is green
// independently of the bundled feature content.
const BOOTSTRAP_MANIFEST = {
  id: "demo-bootstrap",
  displayName: "Demo Bootstrap",
  description: "Trigger: build a demo app, crear una demo. Phased end-to-end project creation.",
  type: "feature",
  kind: "bootstrap",
  phases: [{ n: 0, slug: "product", objetivo: "Product def", skills: [], gate: "user approves" }],
};

const IN_REPO_MANIFEST = {
  id: "demo-in-repo",
  displayName: "Demo In-repo",
  description: "Trigger: work a ticket. In-repo workflow.",
  type: "feature",
  kind: "in-repo",
  phases: [{ n: 0, slug: "intake", objetivo: "intake", skills: [], gate: "ok" }],
};

function writeLocalFeature(manifest: Record<string, unknown>): void {
  const dir = join(claudeDir, ".navori/features", manifest.id as string);
  mkdirSync(join(dir, "phases"), { recursive: true });
  writeFileSync(join(dir, "feature.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(join(dir, "FEATURE.md"), `# ${manifest.displayName as string}\n\nOrchestration body.\n`);
}

const launcherPath = (id: string) => join(claudeDir, "skills", id, "SKILL.md");

describe("global render — bootstrap feature launchers", () => {
  it("renders a launcher SKILL.md for a bootstrap feature on apply", () => {
    writeLocalFeature(BOOTSTRAP_MANIFEST);
    const { result } = runGlobalRender(cfg(), { dryRun: false });
    expect(existsSync(launcherPath("demo-bootstrap"))).toBe(true);
    expect(
      result.written.some((w) => w.path === "skills/demo-bootstrap/SKILL.md" && w.status === "created"),
    ).toBe(true);
  });

  it("frontmatter carries the manifest description verbatim (quoted scalar), and the body names the init command", () => {
    writeLocalFeature(BOOTSTRAP_MANIFEST);
    runGlobalRender(cfg(), { dryRun: false });
    const md = readFileSync(launcherPath("demo-bootstrap"), "utf-8");
    expect(md.startsWith("---\n")).toBe(true);
    expect(md).toContain("name: demo-bootstrap");
    // The description is a double-quoted YAML flow scalar; parsing it back must
    // give the manifest description byte-for-byte (semantic verbatim).
    const line = md.match(/^description: (.*)$/m);
    expect(line).not.toBeNull();
    expect(JSON.parse(line![1]!)).toBe(BOOTSTRAP_MANIFEST.description);
    expect(md).toContain("navori init --feature demo-bootstrap --recommended");
  });

  it("a multi-line description (with an embedded --- line) stays a single intact frontmatter line, nothing leaks into the body", () => {
    const desc = 'Trigger: line one.\n---\nLine two after a "fence".';
    writeLocalFeature({ ...BOOTSTRAP_MANIFEST, description: desc });
    runGlobalRender(cfg(), { dryRun: false });
    const md = readFileSync(launcherPath("demo-bootstrap"), "utf-8");
    // Frontmatter block is intact: opens the file, closes at the next fence,
    // and still carries both keys inside it.
    const fm = md.match(/^---\n([\s\S]*?)\n---\n/);
    expect(fm).not.toBeNull();
    expect(fm![1]).toContain("name: demo-bootstrap");
    const line = fm![1]!.match(/^description: (.*)$/m);
    expect(line).not.toBeNull();
    expect(JSON.parse(line![1]!)).toBe(desc);
    // No raw description fragment leaked past the closing fence into the body.
    const body = md.slice(fm![0].length);
    expect(body).not.toContain("Line two after");
  });

  it("changing the manifest description re-renders the launcher as updated (asset-wins frontmatter merge)", () => {
    writeLocalFeature(BOOTSTRAP_MANIFEST);
    runGlobalRender(cfg(), { dryRun: false });
    writeLocalFeature({ ...BOOTSTRAP_MANIFEST, description: "Trigger: something entirely new." });
    const { result } = runGlobalRender(cfg(), { dryRun: false });
    expect(
      result.written.some((w) => w.path === "skills/demo-bootstrap/SKILL.md" && w.status === "updated"),
    ).toBe(true);
    const line = readFileSync(launcherPath("demo-bootstrap"), "utf-8").match(/^description: (.*)$/m);
    expect(JSON.parse(line![1]!)).toBe("Trigger: something entirely new.");
  });

  it("a malformed feature.json degrades to a warning; other launchers still render", () => {
    writeLocalFeature(BOOTSTRAP_MANIFEST);
    const brokenDir = join(claudeDir, ".navori/features/broken-feature");
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(join(brokenDir, "feature.json"), "{ not valid json");
    const { result } = runGlobalRender(cfg(), { dryRun: false });
    expect(result.warnings.some((w) => w.includes("broken-feature"))).toBe(true);
    expect(existsSync(launcherPath("demo-bootstrap"))).toBe(true);
    expect(existsSync(launcherPath("broken-feature"))).toBe(false);
  });

  it("does NOT render a launcher for an in-repo feature", () => {
    writeLocalFeature(IN_REPO_MANIFEST);
    runGlobalRender(cfg(), { dryRun: false });
    expect(existsSync(launcherPath("demo-in-repo"))).toBe(false);
  });

  it("dry-run reports the launcher but writes nothing to disk", () => {
    writeLocalFeature(BOOTSTRAP_MANIFEST);
    const { result } = runGlobalRender(cfg(), { dryRun: true });
    expect(existsSync(launcherPath("demo-bootstrap"))).toBe(false);
    expect(result.written.some((w) => w.path === "skills/demo-bootstrap/SKILL.md")).toBe(true);
  });

  it("a second render reports the launcher unchanged (idempotent)", () => {
    writeLocalFeature(BOOTSTRAP_MANIFEST);
    runGlobalRender(cfg(), { dryRun: false });
    const second = runGlobalRender(cfg(), { dryRun: false });
    expect(second.result.written.length).toBe(0);
  });

  it("renders the real bundled app-builder launcher with no local override (default global init behavior)", () => {
    const { result } = runGlobalRender(cfg(), { dryRun: false });
    expect(existsSync(launcherPath("app-builder"))).toBe(true);
    expect(result.written.some((w) => w.path === "skills/app-builder/SKILL.md")).toBe(true);
  });
});
