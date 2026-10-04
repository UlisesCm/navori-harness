import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UninstallResult } from "../../lib/audit/launchd.ts";

const uninstallMock = vi.hoisted(() => vi.fn<() => UninstallResult>());
vi.mock(import("../../lib/audit/launchd.ts"), async (importOriginal) => ({
  ...(await importOriginal()),
  isLaunchdPlatform: () => true,
  uninstallLaunchAgent: uninstallMock,
}));

const outroMock = vi.hoisted(() => vi.fn());
const warnMock = vi.hoisted(() => vi.fn());
vi.mock("@clack/prompts", () => ({
  intro: () => undefined,
  outro: outroMock,
  cancel: () => undefined,
  note: () => undefined,
  log: {
    message: () => undefined,
    info: () => undefined,
    warn: warnMock,
    success: () => undefined,
  },
}));

const { runCommand } = await import("citty");
const { globalCommand } = await import("../global.ts");

describe("global collect uninstall (R12)", () => {
  const originalHome = process.env.HOME;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "navori-collect-uninstall-"));
    process.env.HOME = home;
    outroMock.mockClear();
    warnMock.mockClear();
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
    uninstallMock.mockReset();
  });

  // Covers: R12
  it("exits 1 without a success outro when unload fails", async () => {
    uninstallMock.mockReturnValue({
      plistPath: "/fake/agent.plist",
      removed: false,
      unloaded: false,
      error: "launchctl bootout failed: denied",
    });
    const exit = vi.spyOn(process, "exit").mockImplementation(((): never => {
      throw new Error("process.exit");
    }) as never);
    try {
      await expect(
        runCommand(globalCommand, { rawArgs: ["collect", "uninstall"] }),
      ).rejects.toThrow("process.exit");
      expect(exit).toHaveBeenCalledWith(1);
      expect(warnMock).toHaveBeenCalledWith("launchctl bootout failed: denied");
      expect(outroMock).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
    }
  });

  // Covers: R12
  it("reports success only when unload and removal are confirmed", async () => {
    uninstallMock.mockReturnValue({
      plistPath: "/fake/agent.plist",
      removed: true,
      unloaded: true,
    });
    await runCommand(globalCommand, { rawArgs: ["collect", "uninstall"] });
    expect(warnMock).not.toHaveBeenCalled();
    expect(outroMock).toHaveBeenCalledTimes(1);
    expect(String(outroMock.mock.calls[0]?.[0])).toContain("/fake/agent.plist");
  });
});
