import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NavoriConfig } from "../../lib/config/config.ts";

/**
 * #978 — `doctor` compares an enabled plugin's installed binary version
 * against `externalTool.pinnedVersion`. Informational only: it never feeds
 * `computeHealthVerdict` or `--strict` (same tier as `missingExternalTools`),
 * so this suite only exercises the scan function directly.
 */

const hasBinary = vi.fn();
vi.mock(import("../../lib/primitives/which.ts"), () => ({
  hasBinary: (n: string) => hasBinary(n),
}));

const execFileSync = vi.fn();
vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => execFileSync(...args),
}));

const { scanPinnedVersionDrift } = await import("../doctor.ts");

function config(plugins: Record<string, { enabled: boolean }>): NavoriConfig {
  return { plugins } as unknown as NavoriConfig;
}

beforeEach(() => {
  hasBinary.mockReset();
  execFileSync.mockReset();
});

describe("scanPinnedVersionDrift", () => {
  it("flags an installed version that doesn't match the manifest's pin", () => {
    hasBinary.mockReturnValue(true);
    execFileSync.mockReturnValue("1.5.0\n");
    const drift = scanPinnedVersionDrift(config({ codegraph: { enabled: true } }));
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({
      pluginId: "codegraph",
      binary: "codegraph",
      installedVersion: "1.5.0",
      pinnedVersion: "1.6.0",
    });
  });

  it("stays silent when the installed version matches the pin", () => {
    hasBinary.mockReturnValue(true);
    execFileSync.mockReturnValue("1.6.0\n");
    expect(scanPinnedVersionDrift(config({ codegraph: { enabled: true } }))).toEqual([]);
  });

  it("extracts the version from real --version output shapes", () => {
    hasBinary.mockReturnValue(true);
    execFileSync.mockReturnValue("codegraph version 1.5.0 (build abc)\n");
    const drift = scanPinnedVersionDrift(config({ codegraph: { enabled: true } }));
    expect(drift[0]?.installedVersion).toBe("1.5.0");
  });

  it("stays silent on unparseable --version output", () => {
    hasBinary.mockReturnValue(true);
    execFileSync.mockReturnValue("no idea what this binary is\n");
    expect(scanPinnedVersionDrift(config({ codegraph: { enabled: true } }))).toEqual([]);
  });

  it("stays silent when the binary is absent — missingExternalTools' job", () => {
    hasBinary.mockReturnValue(false);
    expect(scanPinnedVersionDrift(config({ codegraph: { enabled: true } }))).toEqual([]);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("ignores a disabled plugin", () => {
    hasBinary.mockReturnValue(true);
    execFileSync.mockReturnValue("1.5.0\n");
    expect(scanPinnedVersionDrift(config({ codegraph: { enabled: false } }))).toEqual([]);
    expect(hasBinary).not.toHaveBeenCalled();
  });

  it("ignores a plugin whose manifest declares no pinnedVersion (e.g. engram)", () => {
    hasBinary.mockReturnValue(true);
    execFileSync.mockReturnValue("engram 2.0.0\n");
    expect(scanPinnedVersionDrift(config({ engram: { enabled: true } }))).toEqual([]);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("stays silent when `--version` errors", () => {
    hasBinary.mockReturnValue(true);
    execFileSync.mockImplementation(() => {
      throw new Error("boom");
    });
    expect(scanPinnedVersionDrift(config({ codegraph: { enabled: true } }))).toEqual([]);
  });
});
