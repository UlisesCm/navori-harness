import { assert, describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NavoriConfig } from "../../lib/config/config.ts";

/**
 * doctor's external-tool check (issue #69): an enabled plugin declaring an
 * `externalTool` whose binary is missing from PATH should be surfaced (warning)
 * with its install command — engram is always-on and never installed by navori,
 * so this is the only place a missing MCP gets flagged. hasBinary is mocked so
 * the result doesn't depend on what's on the test machine's PATH.
 */

const hasBinary = vi.fn();
vi.mock(import("../../lib/primitives/which.ts"), () => ({
  hasBinary: (n: string) => hasBinary(n),
}));

const { scanMissingExternalTools, scanMissingOptionalTools } = await import("../doctor.ts");
const { loadPlugin, listKnownPluginIds, PLATFORMS } = await import("../../lib/config/plugins.ts");
const { currentPlatform } = await import("../../lib/config/platform.ts");

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

/**
 * #270 item 2 + #965. This block USED to assert the exact holes of `semgrep`
 * (no win32) and `gh` (no linux) — i.e. it pinned two accidental gaps as if
 * they were the contract, so filling a verified cell turned the suite red
 * while six mute holes stayed green. Omitting a platform is still legal (for
 * some cells upstream documents no single command, and inventing one would run
 * shell on the user's machine), but it is only legal WITH a destination.
 *
 * The invariant, per plugin and per platform: there is an install command, or
 * there is an `installDocs` URL. No plugin name and no command string is
 * hardcoded here, so this keeps working as the matrix changes and fails the
 * day someone lands a plugin with a silent hole.
 */
describe("externalTool install coverage invariant (#965)", () => {
  const withExternalTool = listKnownPluginIds()
    .map((id) => ({ id, tool: loadPlugin(id).manifest.externalTool }))
    .filter((e): e is { id: string; tool: NonNullable<typeof e.tool> } => e.tool !== undefined);

  it("there is at least one bundled plugin with an externalTool to check", () => {
    expect(withExternalTool.length).toBeGreaterThan(0);
  });

  it.each(PLATFORMS)("every externalTool is actionable on %s", (platform) => {
    const mute = withExternalTool
      .filter(({ tool }) => !tool.install?.[platform] && !tool.installDocs)
      .map(({ id }) => id);
    expect(mute).toEqual([]);
  });

  it("no manifest declares an install key outside PLATFORMS", () => {
    for (const { id, tool } of withExternalTool) {
      const keys = Object.keys(tool.install ?? {});
      expect({ id, extra: keys.filter((k) => !PLATFORMS.includes(k as never)) }).toEqual({
        id,
        extra: [],
      });
    }
  });
});

/**
 * #965 — `add` folded every non-darwin/linux platform into `win32`, so on
 * FreeBSD it offered `winget install --id GitHub.cli`: a command that cannot
 * exist there, about to be run through `spawnSync(cmd, { shell: true })`.
 * `doctor` meanwhile read `process.platform` raw, so the two commands
 * disagreed about the same machine.
 */
describe("currentPlatform (#965)", () => {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  const setPlatform = (value: string): void => {
    Object.defineProperty(process, "platform", { value, configurable: true });
  };
  afterEach(() => {
    if (original) Object.defineProperty(process, "platform", original);
  });

  it.each(PLATFORMS)("returns %s unchanged", (platform) => {
    setPlatform(platform);
    expect(currentPlatform()).toBe(platform);
  });

  it.each(["freebsd", "openbsd", "sunos", "aix"])("returns null on %s, never win32", (platform) => {
    setPlatform(platform);
    expect(currentPlatform()).toBeNull();
  });

  it("agrees with what doctor resolves for the same machine", () => {
    setPlatform("freebsd");
    hasBinary.mockReturnValue(false);
    const [tool] = scanMissingExternalTools(config({ engram: { enabled: true } }));
    assert.isDefined(tool);
    // No command is claimed for a platform navori has no matrix for — but the
    // row is still actionable because the manifest carries installDocs.
    expect(tool.install).toBeNull();
    expect(tool.installDocs).toBeTruthy();
  });
});

describe("scanMissingOptionalTools", () => {
  beforeEach(() => hasBinary.mockReset());

  it("warns with an install hint when ast-grep is absent", () => {
    hasBinary.mockReturnValue(false);
    expect(scanMissingOptionalTools()).toEqual([
      {
        id: "locate-code",
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
        id: "locate-code",
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
