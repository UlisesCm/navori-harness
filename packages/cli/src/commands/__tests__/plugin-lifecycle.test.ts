import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeConfig } from "../../lib/config/config.ts";
import { runRender } from "../render.ts";
import { extractManagedContent } from "../../lib/render/marker.ts";

/**
 * #80 — disabling a plugin must clean up ALL its artifacts, not just its
 * CLAUDE.md managed block: the injectInto sub-blocks and the .claude/scripts/*
 * it wrote while enabled. `configure plugins`/`navori remove` set enabled:false;
 * the render reconciles.
 */

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-plugin-lc-"));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

function writeCfg(
  plugins: Record<string, { enabled: boolean }>,
  gitignoreHarness?: "off" | "local" | "full",
): void {
  writeConfig(join(cwd, "navori.config.json"), {
    name: "demo",
    engines: ["claude"],
    preset: "custom",
    qualityGate: { fast: "echo fast", full: "echo full" },
    plugins,
    ...(gitignoreHarness ? { gitignoreHarness } : {}),
  });
}

/** The `.gitignore` managed block content, or null when absent. */
function gitignoreBlock(): string | null {
  const path = join(cwd, ".gitignore");
  if (!existsSync(path)) return null;
  return extractManagedContent(readFileSync(path, "utf-8"), "gitignore-harness", "shell");
}

describe("plugin lifecycle cleanup (#80)", () => {
  it("strips a disabled plugin's injectInto sub-block from its target file", () => {
    writeCfg({ engram: { enabled: true } });
    runRender(cwd, false);
    const leaderPath = join(cwd, ".claude/agents/orchestrator.md");
    expect(readFileSync(leaderPath, "utf-8")).toContain('id="engram-orchestrator-extension"');

    writeCfg({ engram: { enabled: false } });
    runRender(cwd, false);
    expect(readFileSync(leaderPath, "utf-8")).not.toContain('id="engram-orchestrator-extension"');
    // The base orchestrator block survives — only the plugin sub-block is stripped.
    expect(readFileSync(leaderPath, "utf-8")).toContain('id="orchestrator-base"');
  });

  it("deletes a disabled plugin's script from .claude/scripts/", () => {
    writeCfg({ semgrep: { enabled: true } });
    runRender(cwd, false);
    const scriptPath = join(cwd, ".claude/scripts/check-semgrep.sh");
    expect(existsSync(scriptPath)).toBe(true);

    writeCfg({ semgrep: { enabled: false } });
    runRender(cwd, false);
    expect(existsSync(scriptPath)).toBe(false);
  });

  it("removes a disabled plugin's managed block from CLAUDE.md", () => {
    // engram carries no CLAUDE.md-wide block anymore (#814; its doctrine is a
    // skill injected straight into the agents that hold `mem_*` tools) — gh
    // still does, so it covers this scenario.
    writeCfg({ gh: { enabled: true } });
    runRender(cwd, false);
    const claudeMd = join(cwd, "CLAUDE.md");
    expect(readFileSync(claudeMd, "utf-8")).toContain('id="gh-protocol"');

    writeCfg({ gh: { enabled: false } });
    runRender(cwd, false);
    expect(readFileSync(claudeMd, "utf-8")).not.toContain('id="gh-protocol"');
  });

  it("cleanup is idempotent: re-rendering a disabled plugin is a no-op", () => {
    writeCfg({ semgrep: { enabled: true } });
    runRender(cwd, false);
    writeCfg({ semgrep: { enabled: false } });
    runRender(cwd, false);
    const second = runRender(cwd, false);
    // Nothing left to remove the second time around.
    const removed = (second.engineResult?.written ?? []).filter(
      (w) => w.status === "removed-condition-false" && w.path.includes("check-semgrep"),
    );
    expect(removed).toEqual([]);
  });

  // search-v2.md §6.2/§7 — disabling a v2 search plugin must also retire its
  // `.gitignore` entry, the same cleanup contract every other plugin artifact
  // already gets in this suite (injectInto sub-block, script, CLAUDE.md block).
  it("disabling codegraph retires its .gitignore entry; tgrep's survives", () => {
    writeCfg({ codegraph: { enabled: true }, tgrep: { enabled: true } }, "full");
    runRender(cwd, false);
    expect(gitignoreBlock()?.split("\n")).toEqual(
      expect.arrayContaining([".codegraph/", ".tgrep/"]),
    );

    writeCfg({ codegraph: { enabled: false }, tgrep: { enabled: true } }, "full");
    runRender(cwd, false);
    const lines = gitignoreBlock()?.split("\n") ?? [];
    expect(lines).not.toContain(".codegraph/");
    expect(lines).toContain(".tgrep/");
  });
});
