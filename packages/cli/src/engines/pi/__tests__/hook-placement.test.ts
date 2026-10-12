import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NavoriConfigSchema } from "../../../lib/config/schema.ts";
import { ENGINE_OUTPUTS, engineOwnedPaths } from "../../../lib/diagnose/health.ts";
import { activePiHookBindings, type PiHookBinding } from "../hook-bindings.ts";
import { piOwnershipVerdict, renderPiEngine } from "../index.ts";
import {
  ownsPiManifest,
  piManifestSchemaVersion,
  serializePiManifest,
  type PiManifestHook,
} from "../owned-file.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const config = NavoriConfigSchema.parse({
  name: "pi-placement",
  preset: "custom",
  engines: ["pi"],
  branchBase: "main",
  qualityGate: { fast: "bun test", full: "bun test" },
});
const GUARD: PiHookBinding = {
  script: "guard-destructive",
  on: "tool_call",
  tools: ["bash"],
  scope: "all",
  class: "enforced",
  interactive: true,
  timeoutMs: 30_000,
};
const GATE: PiHookBinding = {
  script: "quality-gate-pre-commit",
  on: "tool_call",
  tools: ["bash"],
  scope: "all",
  class: "enforced",
  interactive: true,
  timeoutMs: 600_000,
  when: (cfg) => Boolean(cfg.qualityGate?.fast),
};
const HOOK = ".pi/navori/hooks/guard-destructive.sh";
const dir = (): string => {
  const path = mkdtempSync(join(tmpdir(), "navori-pi-placement-"));
  dirs.push(path);
  return path;
};
const manifest = (cwd: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(cwd, ".pi/navori.json"), "utf8")) as Record<string, unknown>;

describe("Pi hook placement and manifest v2", () => {
  // Covers: R2, R15
  it("installs exactly the bound scripts under .pi/navori/hooks and declares them in the manifest", () => {
    const cwd = dir();
    const result = renderPiEngine(cwd, config, { hookBindings: [GUARD, GATE] });
    expect(result.written.map((w) => w.path)).toEqual(
      expect.arrayContaining([
        HOOK,
        ".pi/navori/hooks/quality-gate-pre-commit.sh",
        ".pi/navori.json",
      ]),
    );
    // Executable, marker-managed shell, and the Pi identity arm is expanded in (not a runtime include).
    expect(statSync(join(cwd, HOOK)).mode & 0o111).not.toBe(0);
    const script = readFileSync(join(cwd, HOOK), "utf8");
    expect(script).toContain("# navori:managed start");
    expect(script).not.toContain("navori:include");
    const current = manifest(cwd);
    expect(current.schemaVersion).toBe(2);
    expect(current.hooks).toEqual([
      {
        script: "guard-destructive",
        path: HOOK,
        on: "tool_call",
        tools: ["bash"],
        scope: "all",
        class: "enforced",
        interactive: true,
        timeoutMs: 30_000,
      },
      expect.objectContaining({ script: "quality-gate-pre-commit", timeoutMs: 600_000 }),
    ]);
    // Whole-file destinations only, sorted; mixed files (AGENTS.md, skills) are not whole-file owned.
    const owned = current.ownedPaths as string[];
    expect(owned).toEqual(
      expect.arrayContaining([
        ".pi/extensions/navori.ts",
        ".pi/navori.json",
        ".pi/navori/hooks/guard-destructive.sh",
        ".pi/navori/hooks/quality-gate-pre-commit.sh",
      ]),
    );
    expect(owned.some((path) => path.startsWith(".pi/agents/"))).toBe(true);
    expect(owned).toEqual([...owned].sort());
    expect(owned).not.toContain("AGENTS" + ".md");
    // The shared permission source, not a Pi copy of it.
    const rules = current.permissionRules as { ask: string[]; deny: string[] };
    expect(rules.ask).toContain("Bash(git reset --hard*)");
    expect(rules.deny).toContain("Bash(sudo rm *)");
    expect(ownsPiManifest(readFileSync(join(cwd, ".pi/navori.json"), "utf8"))).toBe(true);
    // Idempotent re-render.
    const again = renderPiEngine(cwd, config, { hookBindings: [GUARD, GATE] });
    expect(again.written.filter((w) => w.path.startsWith(".pi/"))).toEqual([]);
  });

  // Covers: R15
  it("honors `when` and never installs a script without a binding row", () => {
    const cwd = dir();
    renderPiEngine(cwd, NavoriConfigSchema.parse({ ...config, qualityGate: undefined }), {
      hookBindings: [GUARD, GATE],
    });
    expect(existsSync(join(cwd, HOOK))).toBe(true);
    expect(existsSync(join(cwd, ".pi/navori/hooks/quality-gate-pre-commit.sh"))).toBe(false);
    const bare = dir();
    // With no binding row no script is placed (the real table is exercised by the lifecycle and guard suites).
    renderPiEngine(bare, config, { hookBindings: [] });
    expect(existsSync(join(bare, ".pi/navori/hooks"))).toBe(false);
    expect((manifest(bare).hooks as unknown[]).length).toBe(0);
    renderPiEngine(bare, config);
    // The default render installs exactly the scripts of the binding table, no more.
    const bound = activePiHookBindings(config).map((b) => b.script);
    expect(
      readdirSync(join(bare, ".pi/navori/hooks"))
        .map((name) => name.replace(/\.sh$/, ""))
        .sort(),
    ).toEqual([...bound].sort());
    expect((manifest(bare).hooks as Array<{ script: string }>).map((h) => h.script)).toEqual(bound);
    expect(activePiHookBindings(config, [GUARD, GATE]).map((b) => b.script)).toEqual([
      "guard-destructive",
      "quality-gate-pre-commit",
    ]);
  });

  // Covers: R15
  it("prunes a script whose binding is gone and keeps the user section across renders", () => {
    const cwd = dir();
    renderPiEngine(cwd, config, { hookBindings: [GUARD, GATE] });
    const path = join(cwd, HOOK);
    writeFileSync(path, readFileSync(path, "utf8") + "\n# my own rule\n");
    const result = renderPiEngine(cwd, config, { hookBindings: [GUARD] });
    expect(existsSync(join(cwd, ".pi/navori/hooks/quality-gate-pre-commit.sh"))).toBe(false);
    expect(result.written.map((w) => w.path)).toContain(
      ".pi/navori/hooks/quality-gate-pre-commit.sh",
    );
    expect(readFileSync(path, "utf8")).toContain("# my own rule");
    expect((manifest(cwd).hooks as PiManifestHook[]).map((h) => h.script)).toEqual([
      "guard-destructive",
    ]);
  });

  // Covers: R15
  it("an edited managed block in a hook copy stops the whole Pi generation", () => {
    const cwd = dir();
    renderPiEngine(cwd, config, { hookBindings: [GUARD] });
    const path = join(cwd, HOOK);
    const edited = readFileSync(path, "utf8").replace("set -euo pipefail", "set -euo pipefail\n:");
    writeFileSync(path, edited);
    const before = readFileSync(join(cwd, ".pi/navori.json"), "utf8");
    const result = renderPiEngine(cwd, config, { hookBindings: [GUARD, GATE] });
    expect(result.skipped.some((skip) => skip.path === HOOK)).toBe(true);
    expect(result.warnings.join("\n")).toMatch(/not committed/);
    // Nothing of Pi was written, not the new script, not the manifest, not the extension.
    expect(readFileSync(path, "utf8")).toBe(edited);
    expect(readFileSync(join(cwd, ".pi/navori.json"), "utf8")).toBe(before);
    expect(existsSync(join(cwd, ".pi/navori/hooks/quality-gate-pre-commit.sh"))).toBe(false);
  });

  // Covers: R15
  it("manifest v2 validates strictly, upgrades v1 and refuses to downgrade a newer schema", () => {
    const base = {
      agents: ["scout"],
      hooks: [],
      ownedPaths: [".pi/navori.json"],
      permissionRules: { ask: [], deny: [] },
    };
    const v2 = serializePiManifest({ schemaVersion: 2, ...base });
    expect(ownsPiManifest(v2)).toBe(true);
    expect(piManifestSchemaVersion(v2)).toBe(2);
    // Tampering with any v2 field, or a malformed hook entry, is foreign.
    expect(ownsPiManifest(v2.replace('".pi/navori.json"', '".pi/other.json"'))).toBe(false);
    const hook: PiManifestHook = {
      script: "guard-destructive",
      path: HOOK,
      on: "tool_call",
      scope: "all",
      class: "enforced",
      interactive: false,
      timeoutMs: 1000,
    };
    expect(ownsPiManifest(serializePiManifest({ schemaVersion: 2, ...base, hooks: [hook] }))).toBe(
      true,
    );
    for (const bad of [
      { ...hook, path: ".pi/navori/hooks/other.sh" },
      { ...hook, script: "../x", path: ".pi/navori/hooks/../x.sh" },
      { ...hook, class: "blocking" as never },
      { ...hook, timeoutMs: 0 },
    ]) {
      expect(ownsPiManifest(serializePiManifest({ schemaVersion: 2, ...base, hooks: [bad] }))).toBe(
        false,
      );
    }
    // A v1 manifest is still ours (a render upgrades it), and a schema newer than this CLI is not.
    expect(ownsPiManifest(serializePiManifest({ schemaVersion: 1, agents: ["scout"] }))).toBe(true);
    const future = v2.replace('"schemaVersion": 2', '"schemaVersion": 3');
    expect(ownsPiManifest(future)).toBe(false);
    expect(piManifestSchemaVersion(future)).toBe(3);
    const cwd = dir();
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi/navori.json"), future);
    const result = renderPiEngine(cwd, config, { hookBindings: [GUARD] });
    expect(result.skipped.find((skip) => skip.path === ".pi/navori.json")?.status).toBe(
      "downgrade-skipped",
    );
    expect(readFileSync(join(cwd, ".pi/navori.json"), "utf8")).toBe(future);
    expect(existsSync(join(cwd, HOOK))).toBe(false);
    expect(existsSync(join(cwd, ".pi/extensions/navori.ts"))).toBe(false);
  });

  // Covers: R15
  it("ENGINE_OUTPUTS covers .pi/navori hooks and ownership answers for a disabled Pi", () => {
    const pi = ENGINE_OUTPUTS.find((entry) => entry.engine === "pi")!;
    expect(pi.markers).toContainEqual({
      kind: "recursive",
      dir: ".pi/navori/hooks",
      ext: ".sh",
      style: "shell",
    });
    expect(engineOwnedPaths("pi")).toContain(".pi");
    const cwd = dir();
    renderPiEngine(cwd, config, { hookBindings: [GUARD] });
    expect(piOwnershipVerdict(cwd, HOOK)).toBe("ours");
    const path = join(cwd, HOOK);
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace("set -euo pipefail", "set -euo pipefail\n:"),
    );
    expect(piOwnershipVerdict(cwd, HOOK)).toBe("modified");
    writeFileSync(path, "#!/bin/bash\necho mine\n");
    expect(piOwnershipVerdict(cwd, HOOK)).toBe("foreign");
  });
});
