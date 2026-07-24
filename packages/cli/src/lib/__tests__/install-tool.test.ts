import { describe, it, expect, beforeEach, vi } from "vitest";

// Hermetic: never look up a real PATH binary, never shell out. hasBinary is
// mocked per-case and the ShellRunner is injected as a spy.
vi.mock("../which.ts", () => ({ hasBinary: vi.fn() }));
// A declined interactive confirm resolves to false (drives the "skipped" case);
// isCancel stays real.
vi.mock("@clack/prompts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@clack/prompts")>();
  return { ...actual, confirm: vi.fn(async () => false) };
});

const { hasBinary } = await import("../which.ts");
const { installExternalTool } = await import("../install-tool.ts");

type Tool = Parameters<typeof installExternalTool>[0];

const engramTool = {
  name: "engram",
  checkBinary: "engram",
  install: {
    darwin: "brew install gentleman-programming/tap/engram",
    linux: "curl -fsSL https://example.test/install.sh | bash",
  },
  postInstall: "claude plugin install engram",
} as unknown as Tool;

beforeEach(() => {
  vi.mocked(hasBinary).mockReset();
});

describe("installExternalTool", () => {
  it("(a) returns already-present and never runs the installer when the binary exists", async () => {
    vi.mocked(hasBinary).mockReturnValue(true);
    const run = vi.fn();
    const result = await installExternalTool(engramTool, { assumeYes: true, platform: "linux", run });
    expect(result).toEqual({ tool: "engram", status: "already-present" });
    expect(run).not.toHaveBeenCalled();
  });

  it("(b) installs (command + postInstall) when absent + assumeYes + a platform command exists", async () => {
    vi.mocked(hasBinary).mockReturnValue(false);
    const run = vi.fn();
    const result = await installExternalTool(engramTool, { assumeYes: true, platform: "linux", run });
    expect(result.status).toBe("installed");
    expect(result.command).toBe("curl -fsSL https://example.test/install.sh | bash");
    expect(run.mock.calls.map((c) => c[0])).toEqual([
      "curl -fsSL https://example.test/install.sh | bash",
      "claude plugin install engram",
    ]);
  });

  it("(c) returns failed (never throws) when the runner throws — stays non-fatal", async () => {
    vi.mocked(hasBinary).mockReturnValue(false);
    const run = vi.fn(() => {
      throw new Error("boom");
    });
    const result = await installExternalTool(engramTool, { assumeYes: true, platform: "linux", run });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("boom");
    // postInstall must not run once the install command fails
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("(d) returns no-command with no runner call when the platform has no install command", async () => {
    vi.mocked(hasBinary).mockReturnValue(false);
    const run = vi.fn();
    const result = await installExternalTool(engramTool, { assumeYes: true, platform: "win32", run });
    expect(result).toEqual({ tool: "engram", status: "no-command" });
    expect(run).not.toHaveBeenCalled();
  });

  it("returns skipped when interactive confirm is declined", async () => {
    vi.mocked(hasBinary).mockReturnValue(false);
    const run = vi.fn();
    const result = await installExternalTool(engramTool, { assumeYes: false, platform: "linux", run });
    expect(result.status).toBe("skipped");
    expect(run).not.toHaveBeenCalled();
  });
});
