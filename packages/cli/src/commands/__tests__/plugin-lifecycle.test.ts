import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeConfig } from "../../lib/config.ts";
import { runRender } from "../render.ts";

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

function writeCfg(plugins: Record<string, { enabled: boolean }>): void {
  writeConfig(join(cwd, "navori.config.json"), {
    name: "demo",
    engines: ["claude"],
    preset: "custom",
    qualityGate: { fast: "echo fast", full: "echo full" },
    plugins,
  });
}

describe("plugin lifecycle cleanup (#80)", () => {
  it("strips a disabled plugin's injectInto sub-block from its target file", () => {
    writeCfg({ engram: { enabled: true } });
    runRender(cwd, false);
    const leaderPath = join(cwd, ".claude/agents/leader.md");
    expect(readFileSync(leaderPath, "utf-8")).toContain('id="engram-leader-extension"');

    writeCfg({ engram: { enabled: false } });
    runRender(cwd, false);
    expect(readFileSync(leaderPath, "utf-8")).not.toContain('id="engram-leader-extension"');
    // The base leader block survives — only the plugin sub-block is stripped.
    expect(readFileSync(leaderPath, "utf-8")).toContain('id="leader-base"');
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
    writeCfg({ engram: { enabled: true } });
    runRender(cwd, false);
    const claudeMd = join(cwd, "CLAUDE.md");
    expect(readFileSync(claudeMd, "utf-8")).toContain('id="engram-protocol"');

    writeCfg({ engram: { enabled: false } });
    runRender(cwd, false);
    expect(readFileSync(claudeMd, "utf-8")).not.toContain('id="engram-protocol"');
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
});
