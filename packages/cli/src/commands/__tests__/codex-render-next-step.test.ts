import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NavoriConfigSchema, type NavoriConfig } from "../../lib/config/schema.ts";
import { resolveCodexHooks } from "../../engines/codex/hook-registrations.ts";
import { codexHookHash, codexHookKey } from "../../lib/codex/trust.ts";

/**
 * Spec 0035 D10/R17 — `render`'s codex next-step hint reads (never writes)
 * `~/.codex/config.toml`. `safeHomedir` is mocked so this file never touches
 * the developer's real one.
 */
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock(import("../../lib/primitives/home.ts"), () => ({ safeHomedir: () => home.dir }));

const { renderNonClaudeEngines } = await import("../render.ts");

function config(overrides: Partial<NavoriConfig> = {}): NavoriConfig {
  return NavoriConfigSchema.parse({
    name: "cx",
    engines: ["codex"],
    preset: "custom",
    branchBase: "main",
    ...overrides,
  });
}

let cwd: string;

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "navori-codex-next-step-home-"));
  cwd = mkdtempSync(join(tmpdir(), "navori-codex-next-step-repo-"));
});

afterEach(() => {
  rmSync(home.dir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function codexTrustHintFrom(warnings: string[]): string | undefined {
  return warnings.find((w) => w.includes("navori codex trust"));
}

describe("render's Codex trust next-step hint (spec 0035 T10)", () => {
  // Covers: R17
  it("points to 'navori codex trust' when the project isn't trusted at all", () => {
    // No ~/.codex/config.toml fixture at all.
    const [codex] = renderNonClaudeEngines(cwd, config(), ["codex"], true, { repoRoot: cwd });
    expect(codex).toBeDefined();
    expect(codexTrustHintFrom(codex!.warnings)).toBeDefined();
  });

  // Covers: R17
  it("points to 'navori codex trust' when the project is trusted but a hook isn't approved", () => {
    mkdirSync(join(home.dir, ".codex"), { recursive: true });
    writeFileSync(
      join(home.dir, ".codex/config.toml"),
      `[projects."${cwd}"]\ntrust_level = "trusted"\n`,
    );
    const [codex] = renderNonClaudeEngines(cwd, config(), ["codex"], true, { repoRoot: cwd });
    expect(codexTrustHintFrom(codex!.warnings)).toBeDefined();
  });

  // Covers: R17 — "only when something is missing"
  it("stays silent when the project and every hook are already Trusted", () => {
    const cfg = config();
    const hooks = resolveCodexHooks(cfg);
    const configTomlPath = join(cwd, ".codex", "config.toml");
    const lines = [`[projects."${cwd}"]`, `trust_level = "trusted"`, ""];
    const groupIndexByEvent = new Map<string, number>();
    for (const hook of hooks) {
      const groupIndex = groupIndexByEvent.get(hook.event) ?? 0;
      groupIndexByEvent.set(hook.event, groupIndex + 1);
      const key = codexHookKey(configTomlPath, hook.event, groupIndex, 0);
      const command = `bash "$(git rev-parse --show-toplevel)/.codex/hooks/${hook.script}.sh"${hook.args ? ` ${hook.args}` : ""}`;
      const hash = codexHookHash(hook, command);
      lines.push(`[hooks.state."${key}"]`, `trusted_hash = "${hash}"`, "");
    }
    mkdirSync(join(home.dir, ".codex"), { recursive: true });
    writeFileSync(join(home.dir, ".codex/config.toml"), lines.join("\n"));

    const [codex] = renderNonClaudeEngines(cwd, cfg, ["codex"], true, { repoRoot: cwd });
    expect(codexTrustHintFrom(codex!.warnings)).toBeUndefined();
  });
});
