import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderClaudeEngine } from "../index.ts";
import type { NavoriConfig } from "../../../lib/config.ts";

/**
 * Feature render (spec 0004). Fixtures live in a LOCAL `.navori/features/<id>/`
 * override so this suite is green independently of the bundled feature content.
 */

const MANIFEST = {
  id: "app-builder",
  displayName: "App builder",
  description: "Trigger: build a mobile app, crear una app. Phased end-to-end app creation.",
  type: "feature",
  kind: "bootstrap",
  phases: [
    { n: 0, slug: "product", objetivo: "Product def", skills: ["cognitive-doc-design"], gate: "user approves" },
    { n: 1, slug: "scaffold", objetivo: "Monorepo boots", skills: ["typescript"], gate: "app boots" },
  ],
  invariants: ["0-product"],
};

function baseConfig(features: string[]): NavoriConfig {
  return {
    name: "demo",
    engines: ["claude"],
    preset: "custom",
    version: "1.0.0",
    language: "es",
    branchBase: "main",
    commits: "conventional-es",
    features,
  } as unknown as NavoriConfig;
}

let cwd: string;

function writeFixture(): void {
  const dir = join(cwd, ".navori/features/app-builder");
  mkdirSync(join(dir, "phases"), { recursive: true });
  writeFileSync(join(dir, "feature.json"), JSON.stringify(MANIFEST, null, 2));
  writeFileSync(
    join(dir, "FEATURE.md"),
    "# App builder\n\nOrquestas fases hacia una app en stores.\n",
  );
  writeFileSync(join(dir, "phases/0-product.md"), "# 0 — product\n\nDefine el producto.\n");
  writeFileSync(join(dir, "phases/1-scaffold.md"), "# 1 — scaffold\n\nMonorepo booteando.\n");
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-feat-render-"));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("renderClaudeEngine — features", () => {
  it("renders an active feature as a managed mother skill + phases", () => {
    writeFixture();
    renderClaudeEngine(cwd, baseConfig(["app-builder"]));

    const skillMd = join(cwd, ".claude/skills/app-builder/SKILL.md");
    const phase0 = join(cwd, ".claude/skills/app-builder/phases/0-product.md");
    const phase1 = join(cwd, ".claude/skills/app-builder/phases/1-scaffold.md");
    expect(existsSync(skillMd)).toBe(true);
    expect(existsSync(phase0)).toBe(true);
    expect(existsSync(phase1)).toBe(true);

    const content = readFileSync(skillMd, "utf-8");
    // Managed marker with the feature source (ownership).
    expect(content).toContain('navori:managed id="app-builder"');
    expect(content).toContain('source="@navori/feature-app-builder"');
    // Frontmatter carries the manifest description (with its triggers) as a
    // double-quoted flow scalar — JSON.parse recovers it verbatim.
    expect(content).toMatch(/^---[\s\S]*name: app-builder[\s\S]*---/);
    const line = content.match(/^description: (.*)$/m);
    expect(line).not.toBeNull();
    expect(JSON.parse(line![1]!)).toBe(MANIFEST.description);
    // Phase files carry the feature marker too.
    expect(readFileSync(phase0, "utf-8")).toContain('source="@navori/feature-app-builder"');
  });

  it("keeps a multi-line description (embedded --- line) on a single intact frontmatter line", () => {
    writeFixture();
    const desc = 'Trigger: line one.\n---\nLine two after a "fence".';
    writeFileSync(
      join(cwd, ".navori/features/app-builder/feature.json"),
      JSON.stringify({ ...MANIFEST, description: desc }, null, 2),
    );
    renderClaudeEngine(cwd, baseConfig(["app-builder"]));
    const content = readFileSync(join(cwd, ".claude/skills/app-builder/SKILL.md"), "utf-8");
    const fm = content.match(/^---\n([\s\S]*?)\n---\n/);
    expect(fm).not.toBeNull();
    const line = fm![1]!.match(/^description: (.*)$/m);
    expect(line).not.toBeNull();
    expect(JSON.parse(line![1]!)).toBe(desc);
    // Nothing leaked past the closing fence into the body.
    expect(content.slice(fm![0].length)).not.toContain("Line two after");
  });

  it("lists the feature in the CLAUDE.md skills index", () => {
    writeFixture();
    renderClaudeEngine(cwd, baseConfig(["app-builder"]));
    const claudeMd = readFileSync(join(cwd, "CLAUDE.md"), "utf-8");
    expect(claudeMd).toContain("`app-builder` — feature");
  });

  it("is idempotent (second render writes nothing for the feature)", () => {
    writeFixture();
    renderClaudeEngine(cwd, baseConfig(["app-builder"]));
    const r2 = renderClaudeEngine(cwd, baseConfig(["app-builder"]));
    const featureWrites = r2.written.filter((w) => w.path.includes("skills/app-builder"));
    expect(featureWrites).toEqual([]);
  });

  it("removes rendered feature files when the feature is deactivated", () => {
    writeFixture();
    renderClaudeEngine(cwd, baseConfig(["app-builder"]));
    expect(existsSync(join(cwd, ".claude/skills/app-builder/SKILL.md"))).toBe(true);

    // Deactivate: features now empty.
    renderClaudeEngine(cwd, baseConfig([]));
    expect(existsSync(join(cwd, ".claude/skills/app-builder/SKILL.md"))).toBe(false);
    expect(existsSync(join(cwd, ".claude/skills/app-builder/phases/1-scaffold.md"))).toBe(false);
    // The now-empty feature directory is pruned.
    expect(existsSync(join(cwd, ".claude/skills/app-builder"))).toBe(false);
  });

  it("reconciles a deactivated feature whose SKILL.md was hand-deleted (marked phases remain)", () => {
    writeFixture();
    renderClaudeEngine(cwd, baseConfig(["app-builder"]));
    const dir = join(cwd, ".claude/skills/app-builder");
    // The user hand-deletes SKILL.md; the marked phase files still carry the
    // feature source. The old reconciler keyed off SKILL.md and orphaned these.
    rmSync(join(dir, "SKILL.md"));
    expect(existsSync(join(dir, "phases/1-scaffold.md"))).toBe(true);

    renderClaudeEngine(cwd, baseConfig([]));
    expect(existsSync(join(dir, "phases/1-scaffold.md"))).toBe(false);
    // The now-empty dir is pruned.
    expect(existsSync(dir)).toBe(false);
  });

  it("keeps a user's unmarked file (and its dir) while removing the marked phases", () => {
    writeFixture();
    renderClaudeEngine(cwd, baseConfig(["app-builder"]));
    const dir = join(cwd, ".claude/skills/app-builder");
    rmSync(join(dir, "SKILL.md"));
    // The user drops an unmarked note into the same dir.
    writeFileSync(join(dir, "notes.md"), "# My notes\n\nNo navori marker here.\n");

    renderClaudeEngine(cwd, baseConfig([]));
    // Marked phases go; the unmarked note survives and keeps the dir alive.
    expect(existsSync(join(dir, "phases/1-scaffold.md"))).toBe(false);
    expect(existsSync(join(dir, "notes.md"))).toBe(true);
    expect(existsSync(dir)).toBe(true);
  });

  it("ownership guard: a user's hand-authored skill dir of the same name is NOT deleted", () => {
    // No feature fixture, no active feature — but a user skill dir exists.
    const userDir = join(cwd, ".claude/skills/app-builder");
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, "SKILL.md"), "---\nname: app-builder\n---\n\nMy own skill.\n");

    renderClaudeEngine(cwd, baseConfig([]));
    expect(existsSync(join(userDir, "SKILL.md"))).toBe(true);
  });

  it("bundled app-builder invariants survive verbatim in rendered output", () => {
    // No local fixture: this resolves the BUNDLED core-assets/features/app-builder,
    // so it validates the shipped invariants (spec 0004 §9), not a test double.
    renderClaudeEngine(cwd, baseConfig(["app-builder"]));
    const root = join(cwd, ".claude/skills/app-builder");
    expect(existsSync(join(root, "SKILL.md"))).toBe(true);

    const readAll = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const abs = join(dir, e.name);
        return e.isDirectory() ? readAll(abs) : [readFileSync(abs, "utf-8")];
      });
    const rendered = readAll(root).join("\n");

    // Two rule strings (in the SKILL.md body) + phase-slug ids (in the managed
    // marker ids `app-builder-<n>-<slug>` of the phase files).
    for (const inv of [
      "No escribas codigo antes de aprobar la fase 0",
      "Un solo monorepo, nunca varios repos",
      "0-product",
      "1-scaffold",
      "4-ui-nav",
      "8-web",
      "10-store",
    ]) {
      expect(rendered, `invariant '${inv}' must survive verbatim`).toContain(inv);
    }
  });

  it("warns and skips an unknown feature id without crashing", () => {
    const r = renderClaudeEngine(cwd, baseConfig(["ghost"]));
    expect(existsSync(join(cwd, ".claude/skills/ghost"))).toBe(false);
    expect(r.warnings.some((w) => w.includes("ghost") && /not found/.test(w))).toBe(true);
  });
});
