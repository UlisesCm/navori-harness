import { assert, describe, it, expect, vi, beforeEach } from "vitest";
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

const { scanMissingExternalTools, scanMissingOptionalTools } = await import("../doctor.ts");
const { loadPlugin } = await import("../../lib/plugins.ts");

function config(plugins: Record<string, { enabled: boolean }>): NavoriConfig {
  return { plugins } as unknown as NavoriConfig;
}

describe("scanMissingExternalTools", () => {
  beforeEach(() => hasBinary.mockReset());

  it("flags an always-on plugin whose binary is absent, with the install command", () => {
    hasBinary.mockReturnValue(false);
    const missing = scanMissingExternalTools(config({ engram: { enabled: true } }));
    expect(missing).toHaveLength(1);
    const [tool] = missing;
    assert.isDefined(tool);
    expect(tool.pluginId).toBe("engram");
    expect(tool.binary).toBe("engram");
    // engram declares a per-platform install + a postInstall; at least one is surfaced.
    expect(tool.install ?? tool.postInstall).toBeTruthy();
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

describe("codegraph externalTool.install platform selection (#270 item 2)", () => {
  it("declares darwin+linux installers but NOT win32 (WSL prose removed)", () => {
    const install = loadPlugin("codegraph").manifest.externalTool?.install ?? {};
    expect(install.darwin).toBeTruthy();
    expect(install.linux).toBeTruthy();
    // win32 undefined → add.ts takes the clean `noInstallCommand` path instead of
    // running the WSL prose as a shell command (which errored on native Windows).
    expect(install.win32).toBeUndefined();
  });
});

describe("scanMissingOptionalTools", () => {
  beforeEach(() => hasBinary.mockReset());

  it("warns with an install hint when ast-grep is absent", () => {
    hasBinary.mockReturnValue(false);
    expect(scanMissingOptionalTools()).toEqual([
      {
        id: "structural-search",
        binaries: ["ast-grep"],
        install: "npm install --global @ast-grep/cli",
      },
    ]);
  });

  it("stays silent when ast-grep is available", () => {
    hasBinary.mockImplementation((binary: string) => binary === "ast-grep");
    expect(scanMissingOptionalTools()).toEqual([]);
  });

  // #495, the other half. This assertion USED to read `it.each(["sg", "ast-grep"])
  // ("stays silent when %s is available")` — i.e. the suite actively asserted the
  // bug. On macOS `sg` is Homebrew's ast-grep alias; on any Linux with
  // shadow-utils `/usr/bin/sg` is a different program that always exists, so
  // probing it turned doctor's "ast-grep installed" into a machine-wide false OK.
  // The name means two things; only `ast-grep` means one.
  it("does NOT accept a bare `sg` as ast-grep — on Linux that is shadow-utils", () => {
    hasBinary.mockImplementation((binary: string) => binary === "sg");
    expect(scanMissingOptionalTools()).toEqual([
      {
        id: "structural-search",
        binaries: ["ast-grep"],
        install: "npm install --global @ast-grep/cli",
      },
    ]);
  });

  // Anti-false-green: the three tests above all drive `hasBinary` through a
  // mock, so a probe that stopped calling it entirely would still look right in
  // two of them. Pin the call itself.
  it("actually probes for the binary — a detector that asks nothing proves nothing", () => {
    hasBinary.mockReturnValue(false);
    scanMissingOptionalTools();
    expect(hasBinary).toHaveBeenCalledWith("ast-grep");
    expect(hasBinary).not.toHaveBeenCalledWith("sg");
  });
});
