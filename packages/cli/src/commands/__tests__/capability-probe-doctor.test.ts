import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NavoriConfig } from "../../lib/config/config.ts";

/**
 * #1060 — `doctor` runs a plugin's declared `externalTool.capabilityProbe`
 * against its installed binary and warns when the probe's output is missing
 * any of `mustContain` (e.g. jscpd < 5.1.1 lacking `--baseline-from-ref`).
 * Same tier as `scanPinnedVersionDrift` (#978): informational only, never
 * feeds `computeHealthVerdict` or `--strict` — this suite exercises the scan
 * function directly, not the exit code.
 */

const hasBinary = vi.fn();
vi.mock(import("../../lib/primitives/which.ts"), () => ({
  hasBinary: (n: string) => hasBinary(n),
}));

const execFileSync = vi.fn();
vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => execFileSync(...args),
}));

const { scanExternalToolCapabilities } = await import("../doctor.ts");

function config(plugins: Record<string, { enabled: boolean }>): NavoriConfig {
  return { plugins } as unknown as NavoriConfig;
}

beforeEach(() => {
  hasBinary.mockReset();
  execFileSync.mockReset();
});

describe("scanExternalToolCapabilities", () => {
  it("flags a binary whose probe output is missing a required capability", () => {
    hasBinary.mockReturnValue(true);
    execFileSync.mockReturnValue("Usage: jscpd [options]\n  --min-tokens <n>\n");
    const gaps = scanExternalToolCapabilities(config({ jscpd: { enabled: true } }));
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      pluginId: "jscpd",
      binary: "jscpd",
      minVersion: "5.1.1",
    });
    expect(gaps[0]?.missing).toEqual(
      expect.arrayContaining(["--baseline-from-ref", "--fail-on-new-clones"]),
    );
  });

  it("stays silent when the probe output contains every required capability", () => {
    hasBinary.mockReturnValue(true);
    execFileSync.mockReturnValue(
      "Usage: jscpd [options]\n  --baseline-from-ref <ref>\n  --fail-on-new-clones [<n>]\n",
    );
    expect(scanExternalToolCapabilities(config({ jscpd: { enabled: true } }))).toEqual([]);
  });

  it("stays silent when the binary is absent — missingExternalTools' job", () => {
    hasBinary.mockReturnValue(false);
    expect(scanExternalToolCapabilities(config({ jscpd: { enabled: true } }))).toEqual([]);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("ignores a disabled plugin", () => {
    hasBinary.mockReturnValue(true);
    execFileSync.mockReturnValue("Usage: jscpd\n");
    expect(scanExternalToolCapabilities(config({ jscpd: { enabled: false } }))).toEqual([]);
    expect(hasBinary).not.toHaveBeenCalled();
  });

  it("ignores a plugin whose manifest declares no capabilityProbe (e.g. engram)", () => {
    hasBinary.mockReturnValue(true);
    execFileSync.mockReturnValue("engram 2.0.0\n");
    expect(scanExternalToolCapabilities(config({ engram: { enabled: true } }))).toEqual([]);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("stays silent when the probe itself throws (e.g. --help exits non-zero)", () => {
    hasBinary.mockReturnValue(true);
    execFileSync.mockImplementation(() => {
      throw new Error("boom");
    });
    expect(scanExternalToolCapabilities(config({ jscpd: { enabled: true } }))).toEqual([]);
  });
});
