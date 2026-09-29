import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NavoriConfigSchema } from "../../../lib/config/schema.ts";
import {
  loadEnabledPlugins,
  PluginManifestSchema,
  type LoadedPlugin,
} from "../../../lib/config/plugins.ts";
import { projectCodexHooksMatch } from "../../../lib/codex/trust.ts";
import { renderCodexEngine } from "../index.ts";
import { renderClaudeEngine } from "../../claude/index.ts";
import { buildCodexConfigToml } from "../build-config-toml.ts";
import {
  codexHookCommand,
  resolveCodexHooks,
  resolvePluginCodexHooks,
} from "../hook-registrations.ts";

function config(engines: Array<"claude" | "codex"> = ["codex"], enabled = true) {
  return NavoriConfigSchema.parse({
    name: "plugin-gates",
    engines,
    preset: "custom",
    branchBase: "main",
    qualityGate: { fast: "bun lint", full: "bun test" },
    plugins: { semgrep: { enabled }, jscpd: { enabled } },
  });
}

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), "navori-plugin-gates-"));
}

// Covers: R4, R6, R20
describe("Codex plugin gates", () => {
  it("renders Codex-only scripts with includes and provenance, registering each once after core", () => {
    const cwd = tempRepo();
    const cfg = config();
    renderCodexEngine(cwd, cfg);
    const plugins = loadEnabledPlugins(cfg.plugins).loaded;
    const hooks = resolveCodexHooks(cfg, plugins);
    const toml = readFileSync(join(cwd, ".codex/config.toml"), "utf-8");
    expect(existsSync(join(cwd, ".claude/scripts/check-semgrep.sh"))).toBe(false);
    for (const id of ["jscpd", "semgrep"]) {
      const script = readFileSync(join(cwd, `.codex/scripts/check-${id}.sh`), "utf-8");
      expect(script).toContain(`source="@navori/plugin-${id}"`);
      expect(script).toContain("extract_cmd()");
      expect(script).not.toContain("# navori:include extract-cmd");
      expect(toml.match(new RegExp(`check-${id}\\.sh`, "g"))).toHaveLength(1);
    }
    expect(hooks.slice(-2).map((hook) => hook.pluginId)).toEqual(["jscpd", "semgrep"]);
    expect(hooks[0]?.script).toBe("guard-destructive");
    expect(projectCodexHooksMatch(join(cwd, ".codex/config.toml"), hooks)).toBe(true);
    expect(renderCodexEngine(cwd, cfg).written).toEqual([]);
  });

  it("keeps Claude bytes unchanged in a dual render and removes disabled Codex registrations", () => {
    const cwd = tempRepo();
    const cfg = config(["claude", "codex"]);
    renderClaudeEngine(cwd, cfg);
    const before = readFileSync(join(cwd, ".claude/scripts/check-semgrep.sh"), "utf-8");
    renderCodexEngine(cwd, cfg);
    expect(readFileSync(join(cwd, ".claude/scripts/check-semgrep.sh"), "utf-8")).toBe(before);
    const disabled = config(["codex"], false);
    renderCodexEngine(cwd, disabled);
    expect(readFileSync(join(cwd, ".codex/config.toml"), "utf-8")).not.toContain(
      "check-semgrep.sh",
    );
    expect(existsSync(join(cwd, ".codex/scripts/check-semgrep.sh"))).toBe(false);
  });

  it("quotes workspace metacharacters and rejects unsupported hook shapes", () => {
    const cfg = config();
    const plugin: LoadedPlugin = {
      manifest: PluginManifestSchema.parse({
        id: "example",
        name: "example",
        description: "test",
        version: "1.0.0",
        hooks: [
          {
            event: "PreToolUse",
            matcher: "Bash",
            command: 'bash "$CLAUDE_PROJECT_DIR/.claude/scripts/check-$`x.sh"',
          },
          { event: "PreToolUse", matcher: "Bash", command: "echo unsupported" },
        ],
      }),
      packageRoot: "",
      managedAssets: [],
      scriptAssets: [{ src: "/unused", dest: "check-$`x.sh", exec: true }],
      skillAssets: [],
    };
    const translated = resolvePluginCodexHooks([plugin]);
    expect(translated.hooks).toHaveLength(1);
    expect(translated.warnings).toHaveLength(1);
    expect(codexHookCommand(translated.hooks[0]!, 'apps/a b$`"c')).toContain(
      'apps/a b\\$\\`\\"c/.codex/scripts/check-\\$\\`x.sh',
    );
    expect(buildCodexConfigToml(cfg, [plugin]).warnings).toContainEqual(
      expect.stringContaining("forma no traducible"),
    );
    const collision: LoadedPlugin = {
      ...plugin,
      manifest: PluginManifestSchema.parse({ ...plugin.manifest, id: "second" }),
    };
    const conflicted = resolvePluginCodexHooks([plugin, collision]);
    expect(conflicted.hooks).toEqual([]);
    expect(conflicted.warnings).toContainEqual(expect.stringContaining("varias veces"));
  });

  it("refuses positional trust when project hooks differ from the proposed render", () => {
    const cwd = tempRepo();
    const cfg = config();
    renderCodexEngine(cwd, cfg);
    const path = join(cwd, ".codex/config.toml");
    const hooks = resolveCodexHooks(cfg, loadEnabledPlugins(cfg.plugins).loaded);
    expect(projectCodexHooksMatch(path, hooks)).toBe(true);
    writeFileSync(
      path,
      readFileSync(path, "utf-8").replace("check-semgrep.sh", "wrong-semgrep.sh"),
    );
    expect(renderCodexEngine(cwd, cfg).skipped).toContainEqual(
      expect.objectContaining({ path: ".codex/config.toml", status: "user-modified-skipped" }),
    );
    expect(projectCodexHooksMatch(path, hooks)).toBe(false);
  });

  it("keeps foreign and newer script content instead of adopting or downgrading it", () => {
    const cwd = tempRepo();
    const cfg = config();
    renderCodexEngine(cwd, cfg);
    const path = join(cwd, ".codex/scripts/check-semgrep.sh");
    writeFileSync(path, "# user-owned script\n");
    const foreign = renderCodexEngine(cwd, cfg);
    expect(foreign.skipped).toContainEqual(
      expect.objectContaining({
        path: ".codex/scripts/check-semgrep.sh",
        status: "user-modified-skipped",
      }),
    );
    expect(readFileSync(path, "utf-8")).toBe("# user-owned script\n");

    const fresh = tempRepo();
    renderCodexEngine(fresh, cfg);
    const newerPath = join(fresh, ".codex/scripts/check-semgrep.sh");
    writeFileSync(
      newerPath,
      readFileSync(newerPath, "utf-8").replace(/version="[^"]+"/, 'version="999.0.0"'),
    );
    const newer = renderCodexEngine(fresh, cfg);
    expect(newer.skipped).toContainEqual(
      expect.objectContaining({
        path: ".codex/scripts/check-semgrep.sh",
        status: "downgrade-skipped",
      }),
    );
    expect(readFileSync(newerPath, "utf-8")).toContain('version="999.0.0"');
  });
});
