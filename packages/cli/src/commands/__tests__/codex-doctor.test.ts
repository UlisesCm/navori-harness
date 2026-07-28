import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { NavoriConfigSchema, type NavoriConfig } from "../../lib/schema.ts";
import { scanCodexHealth, buildEngineInventory } from "../doctor.ts";

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), "navori-codex-doctor-"));
}

function config(overrides: Partial<NavoriConfig> = {}): NavoriConfig {
  return NavoriConfigSchema.parse({
    name: "cx",
    engines: ["codex"],
    preset: "custom",
    branchBase: "main",
    qualityGate: { fast: "pnpm test", full: "pnpm test" },
    plugins: { engram: { enabled: true } },
    ...overrides,
  });
}

describe("scanCodexHealth (Spec 0007 M5)", () => {
  it("returns null when codex is not a configured engine", () => {
    const cwd = tempRepo();
    expect(scanCodexHealth(cwd, config({ engines: ["claude"] }))).toBeNull();
  });

  it("returns null when codex is configured but nothing rendered yet", () => {
    const cwd = tempRepo();
    expect(scanCodexHealth(cwd, config())).toBeNull();
  });

  it("flags a hook without the executable bit and hints at hook-trust", () => {
    const cwd = tempRepo();
    mkdirSync(join(cwd, ".codex/hooks"), { recursive: true });
    const hook = join(cwd, ".codex/hooks/guard-destructive.sh");
    writeFileSync(hook, "#!/bin/sh\n");
    chmodSync(hook, 0o644); // no +x
    const health = scanCodexHealth(cwd, config());
    expect(health).not.toBeNull();
    expect(health?.hooksNotExecutable).toContain(".codex/hooks/guard-destructive.sh");
    expect(health?.hookTrustHint).toBe(true);
  });

  it("flags an unbalanced managed block in config.toml", () => {
    const cwd = tempRepo();
    mkdirSync(join(cwd, ".codex"), { recursive: true });
    writeFileSync(
      join(cwd, ".codex/config.toml"),
      '# navori:managed start id="codex-config-base"\nfoo = 1\n', // start without end
    );
    const health = scanCodexHealth(cwd, config());
    expect(health?.configMalformed).toBe(true);
  });

  it("passes a balanced config.toml", () => {
    const cwd = tempRepo();
    mkdirSync(join(cwd, ".codex"), { recursive: true });
    writeFileSync(
      join(cwd, ".codex/config.toml"),
      '# navori:managed start id="codex-config-base"\nfoo = 1\n# navori:managed end id="codex-config-base"\n',
    );
    const health = scanCodexHealth(cwd, config());
    expect(health?.configMalformed).toBe(false);
  });
});

describe("buildEngineInventory (Spec 0007 M8)", () => {
  it("lists agents/skills/hooks per disk engine; claude includes leader, codex omits it", () => {
    const cwd = tempRepo();
    const inv = buildEngineInventory(config({ engines: ["claude", "codex"] }), cwd);
    expect(Object.keys(inv).sort()).toEqual(["claude", "codex"]);
    expect(inv.claude.agents).toContain("leader");
    expect(inv.codex.agents).not.toContain("leader");
    // Same skills + hooks set for both (parity).
    expect(inv.codex.skills).toEqual(inv.claude.skills);
    expect(inv.codex.hooks).toEqual(inv.claude.hooks);
    expect(inv.claude.hooks).toContain("guard-destructive");
  });

  it("omits prose engines", () => {
    const cwd = tempRepo();
    const inv = buildEngineInventory(config({ engines: ["codex", "agents-md"] }), cwd);
    expect(Object.keys(inv)).toEqual(["codex"]);
  });
});
