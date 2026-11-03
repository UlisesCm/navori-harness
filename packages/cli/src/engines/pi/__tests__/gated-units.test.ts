import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NavoriConfigSchema } from "../../../lib/config/schema.ts";
import { renderClaudeEngine } from "../../claude/index.ts";
import { renderPiEngine } from "../index.ts";

/**
 * #1484: the Pi bindings that ride an opt-in flag carry a real `when`, so
 * `.pi/navori.json` never points at a script the plan pruned (challenge B2).
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function render(extra: Record<string, unknown> = {}): { cwd: string; warnings: string[] } {
  const cwd = mkdtempSync(join(tmpdir(), "navori-pi-gated-"));
  dirs.push(cwd);
  const config = NavoriConfigSchema.parse({
    name: "pi-gated",
    engines: ["pi"],
    preset: "custom",
    branchBase: "main",
    ...extra,
  });
  return { cwd, warnings: renderPiEngine(cwd, config).warnings };
}

function manifestScripts(cwd: string): string[] {
  const manifest = JSON.parse(readFileSync(join(cwd, ".pi/navori.json"), "utf8")) as {
    hooks: Array<{ script: string }>;
  };
  return manifest.hooks.map((h) => h.script);
}

const GATED = ["master-accept-confirm", "routing-watch", "audit-mode-close"];

describe("Pi hook bindings behind an opt-in flag", () => {
  it("omits the script and the manifest binding by default", () => {
    const { cwd } = render();
    const scripts = manifestScripts(cwd);
    for (const id of GATED) {
      expect(scripts).not.toContain(id);
      expect(existsSync(join(cwd, `.pi/navori/hooks/${id}.sh`))).toBe(false);
    }
  });

  it("writes both once each flag is on", () => {
    const { cwd } = render({
      harness: { masterPlan: true, planTiers: true },
      hooks: { auditMode: true },
    });
    const scripts = manifestScripts(cwd);
    for (const id of GATED) {
      expect(scripts).toContain(id);
      expect(existsSync(join(cwd, `.pi/navori/hooks/${id}.sh`))).toBe(true);
    }
  });

  it("audit.mode always keeps audit-mode-close without hooks.auditMode", () => {
    const { cwd } = render({ audit: { mode: "always" } });
    expect(manifestScripts(cwd)).toContain("audit-mode-close");
  });

  it("still warns when scribeOwnsMarkdown is on but the scribe role is disabled", () => {
    const { warnings } = render({ harness: { scribeOwnsMarkdown: true, scribe: false } });
    expect(warnings.some((w) => w.includes("scribe role is disabled"))).toBe(true);
    expect(render({ harness: { scribeOwnsMarkdown: true } }).warnings.join("\n")).not.toContain(
      "scribe role is disabled",
    );
  });
});

describe("agents index follows the scribe gate (Claude)", () => {
  function indexOf(harness: Record<string, unknown>): string {
    const cwd = mkdtempSync(join(tmpdir(), "navori-agents-index-"));
    dirs.push(cwd);
    renderClaudeEngine(
      cwd,
      NavoriConfigSchema.parse({ name: "idx", engines: ["claude"], preset: "custom", harness }),
    );
    return readFileSync(join(cwd, ".claude/context/20-agentes-disponibles.md"), "utf8");
  }

  it("lists the scribe only with scribeOwnsMarkdown", () => {
    expect(indexOf({})).not.toContain("`scribe`");
    expect(indexOf({ scribeOwnsMarkdown: true })).toContain("`scribe`");
  });
});
