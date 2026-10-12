import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NavoriConfigSchema } from "../config/schema.ts";
import { scanPiHealth, selectsPowershell } from "../diagnose/pi-health.ts";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const piConfig = NavoriConfigSchema.parse({
  name: "pi-health",
  preset: "custom",
  engines: ["pi"],
  branchBase: "main",
  qualityGate: { fast: "bun test", full: "bun test" },
});

/** A project plus an isolated Pi agent dir, so the user's real Pi settings never leak into a test. */
function fixture(): { cwd: string; agentDir: string } {
  const root = mkdtempSync(join(tmpdir(), "navori-pi-health-"));
  dirs.push(root);
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(join(cwd, ".pi/extensions"), { recursive: true });
  mkdirSync(agentDir);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  return { cwd, agentDir };
}

describe("navori doctor Pi diagnosis", () => {
  // Covers: R15
  it("reports nothing unless Pi is enabled, and nothing for a verified Pi", () => {
    const { cwd } = fixture();
    const claudeOnly = NavoriConfigSchema.parse({ ...piConfig, engines: ["claude"] });
    expect(scanPiHealth(cwd, claudeOnly, () => "1.0.0")).toBeNull();
    expect(scanPiHealth(cwd, piConfig, () => "1.1.0")).toEqual({
      versionUnverified: null,
      powershellDefault: false,
      foreignExtensions: [],
    });
    // No `pi` binary on PATH is "nothing to check", never an error.
    expect(scanPiHealth(cwd, piConfig, () => null)?.versionUnverified).toBeNull();
  });

  // Covers: R15
  it("diagnoses a version below the floor, a prerelease and a newer prerelease", () => {
    const { cwd } = fixture();
    for (const found of ["0.87.1", "1.0.9", "1.1.0-rc.1", "1.2.0-beta.3"]) {
      expect(scanPiHealth(cwd, piConfig, () => found)?.versionUnverified).toEqual({
        found,
        min: "1.1.0",
      });
    }
    expect(scanPiHealth(cwd, piConfig, () => "1.2.0")?.versionUnverified).toBeNull();
  });

  // Covers: R15
  it("detects powershell in defaultTools, the project value overriding the user one", () => {
    const { cwd, agentDir } = fixture();
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ defaultTools: ["read", "powershell"] }),
    );
    expect(scanPiHealth(cwd, piConfig, () => "1.1.0")?.powershellDefault).toBe(true);
    writeFileSync(
      join(cwd, ".pi/settings.json"),
      JSON.stringify({ defaultTools: ["read", "bash"] }),
    );
    expect(scanPiHealth(cwd, piConfig, () => "1.1.0")?.powershellDefault).toBe(false);
    writeFileSync(
      join(cwd, ".pi/settings.json"),
      JSON.stringify({ defaultTools: ["+powershell"] }),
    );
    expect(scanPiHealth(cwd, piConfig, () => "1.1.0")?.powershellDefault).toBe(true);
    // An unreadable settings file is ignored rather than guessed at.
    writeFileSync(join(cwd, ".pi/settings.json"), "{ not json");
    expect(scanPiHealth(cwd, piConfig, () => "1.1.0")?.powershellDefault).toBe(true);
    expect(selectsPowershell(["powershell", "-powershell"])).toBe(false);
    expect(selectsPowershell(undefined)).toBe(false);
  });

  // Covers: R15
  it("lists project extensions that are not Navori's, from the directory and the setting", () => {
    const { cwd } = fixture();
    writeFileSync(join(cwd, ".pi/extensions/navori.ts"), "export default () => {};\n");
    expect(scanPiHealth(cwd, piConfig, () => "1.1.0")?.foreignExtensions).toEqual([]);
    writeFileSync(join(cwd, ".pi/extensions/other.ts"), "export default () => {};\n");
    writeFileSync(
      join(cwd, ".pi/settings.json"),
      JSON.stringify({ extensions: ["./vendor/ext.ts", "-builtin:mcp", "builtin:codemode"] }),
    );
    expect(scanPiHealth(cwd, piConfig, () => "1.1.0")?.foreignExtensions).toEqual([
      "./vendor/ext.ts",
      ".pi/extensions/other.ts",
    ]);
  });
});
