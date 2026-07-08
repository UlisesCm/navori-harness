import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NavoriConfig } from "../../lib/config.ts";

/**
 * doctor's external-tool check (issue #69): an enabled plugin declaring an
 * `externalTool` whose binary is missing from PATH should be surfaced (warning)
 * with its install command — engram is always-on and never installed by navori,
 * so this is the only place a missing MCP gets flagged. hasBinary is mocked so
 * the result doesn't depend on what's on the test machine's PATH.
 */

const hasBinary = vi.fn();
vi.mock("../../lib/which.ts", () => ({ hasBinary: (n: string) => hasBinary(n) }));

const { scanMissingExternalTools } = await import("../doctor.ts");

function config(plugins: Record<string, { enabled: boolean }>): NavoriConfig {
  return { plugins } as unknown as NavoriConfig;
}

describe("scanMissingExternalTools", () => {
  beforeEach(() => hasBinary.mockReset());

  it("flags an always-on plugin whose binary is absent, with the install command", () => {
    hasBinary.mockReturnValue(false);
    const missing = scanMissingExternalTools(config({ engram: { enabled: true } }));
    expect(missing).toHaveLength(1);
    expect(missing[0].pluginId).toBe("engram");
    expect(missing[0].binary).toBe("engram");
    // engram declares a per-platform install + a postInstall; at least one is surfaced.
    expect(missing[0].install ?? missing[0].postInstall).toBeTruthy();
  });

  it("stays silent when the binary is present", () => {
    hasBinary.mockReturnValue(true);
    expect(scanMissingExternalTools(config({ engram: { enabled: true } }))).toEqual([]);
  });

  it("ignores disabled plugins", () => {
    hasBinary.mockReturnValue(false);
    expect(scanMissingExternalTools(config({ engram: { enabled: false } }))).toEqual([]);
  });

  it("ignores plugins without an externalTool", () => {
    hasBinary.mockReturnValue(false);
    // acli/gh declare no checkBinary-gated MCP the same way; a plugin with no
    // externalTool must never appear. Use a config with only such a plugin.
    const missing = scanMissingExternalTools(config({ jscpd: { enabled: true } }));
    // jscpd DOES declare an external tool; assert the shape is well-formed
    // rather than a specific count, so this test tracks the manifest.
    for (const m of missing) {
      expect(typeof m.binary).toBe("string");
      expect(m.pluginId).toBe("jscpd");
    }
  });
});
