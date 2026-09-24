import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InstallResult } from "../../lib/audit/launchd.ts";

/**
 * #1014 — `global collect install` reported success from `launchctl` alone,
 * never from the receiver itself: a receiver that crash-looped on every
 * restart (launchd's cwd `/` making `repoFromCwd` reject the repo name, the
 * bug this issue fixes at the source in `audit.ts`) still got a green outro.
 * `confirmReceiverUp` is the fix — bounded retries against the receiver's own
 * `/healthz` — and it is tested twice: as a pure function with injected
 * probe/delay (no real network, no real sleep), and through the command with
 * `launchd.ts` mocked so no test touches the developer's real
 * `~/Library/LaunchAgents` or runs `launchctl`.
 *
 * `@clack/prompts` is mocked too: it turns `p.outro`/`p.log.warn` into spies,
 * which is also how A3 (the `${check}` interpolation bug — it printed the
 * function's own minified source instead of a checkmark) is pinned without
 * scraping ANSI-coded stdout.
 */

const isLaunchdPlatformMock = vi.hoisted(() => vi.fn(() => true));
const installLaunchAgentMock = vi.hoisted(() => vi.fn<() => InstallResult>());
const probeReceiverMock = vi.hoisted(() => vi.fn<(port?: number) => Promise<boolean>>());
const collectLogDirMock = vi.hoisted(() => vi.fn(() => "/fake/.navori/logs"));

vi.mock(import("../../lib/audit/launchd.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    isLaunchdPlatform: isLaunchdPlatformMock,
    installLaunchAgent: installLaunchAgentMock,
    probeReceiver: probeReceiverMock,
    collectLogDir: collectLogDirMock,
  };
});

const outroMock = vi.hoisted(() => vi.fn());
const cancelMock = vi.hoisted(() => vi.fn());
const logWarnMock = vi.hoisted(() => vi.fn());
const logSuccessMock = vi.hoisted(() => vi.fn());
vi.mock("@clack/prompts", () => ({
  intro: () => undefined,
  outro: outroMock,
  cancel: cancelMock,
  note: () => undefined,
  log: {
    message: () => undefined,
    info: () => undefined,
    warn: logWarnMock,
    success: logSuccessMock,
  },
}));

const { runCommand } = await import("citty");
const { globalCommand, confirmReceiverUp } = await import("../global.ts");

/** A successful `installLaunchAgent()` result: written, loaded, not a dev build. */
function okInstallResult(): InstallResult {
  return {
    plistPath: "/fake/home/Library/LaunchAgents/com.navori.audit-collect.plist",
    argv: ["/usr/bin/node", "/usr/local/bin/navori", "audit", "--collect"],
    port: 4318,
    loaded: true,
    message: "",
    replaced: false,
  };
}

describe("confirmReceiverUp — bounded retries, injectable (#1014, A2)", () => {
  it("returns true on the first successful probe without sleeping", async () => {
    const probe = vi.fn().mockResolvedValue(true);
    const delay = vi.fn().mockResolvedValue(undefined);
    expect(await confirmReceiverUp(4318, probe, delay)).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
  });

  it("recovers once the receiver comes up mid-retry", async () => {
    let calls = 0;
    const probe = vi.fn().mockImplementation(async () => {
      calls += 1;
      return calls >= 3;
    });
    const delay = vi.fn().mockResolvedValue(undefined);
    expect(await confirmReceiverUp(4318, probe, delay)).toBe(true);
    expect(probe).toHaveBeenCalledTimes(3);
    // One sleep between each failed probe, never after the one that succeeded.
    expect(delay).toHaveBeenCalledTimes(2);
  });

  it("gives up after a bounded number of attempts on a dead receiver", async () => {
    const probe = vi.fn().mockResolvedValue(false);
    const delay = vi.fn().mockResolvedValue(undefined);
    expect(await confirmReceiverUp(4318, probe, delay)).toBe(false);
    // Bounded: a small, fixed ceiling — not an infinite loop that would hang
    // `install` forever on a receiver that never comes up.
    expect(probe.mock.calls.length).toBeGreaterThan(1);
    expect(probe.mock.calls.length).toBeLessThanOrEqual(10);
    expect(delay.mock.calls.length).toBe(probe.mock.calls.length - 1);
  });
});

describe("global collect install confirms with probeReceiver (#1014, A2/A3)", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "navori-collect-install-"));
    process.env.HOME = home;
    isLaunchdPlatformMock.mockReturnValue(true);
    installLaunchAgentMock.mockReturnValue(okInstallResult());
    outroMock.mockClear();
    cancelMock.mockClear();
    logWarnMock.mockClear();
    logSuccessMock.mockClear();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    probeReceiverMock.mockReset();
  });

  it("probes before the green outro, and never prints the check function's own source (A2/A3)", async () => {
    probeReceiverMock.mockResolvedValue(true);
    await runCommand(globalCommand, { rawArgs: ["collect", "install"] });

    expect(probeReceiverMock).toHaveBeenCalled();
    expect(outroMock).toHaveBeenCalledTimes(1);
    const outroText = String(outroMock.mock.calls[0]?.[0] ?? "");
    // The A3 defect: `${check}` (no call) interpolates the function's own
    // minified source instead of a checkmark.
    expect(outroText).not.toContain("function");
    expect(outroText).toContain("127.0.0.1:4318");
  });

  it("warns naming the log dir and exits 1 when the receiver never answers (A2, loaded-but-dead)", async () => {
    probeReceiverMock.mockResolvedValue(false);
    const exit = vi.spyOn(process, "exit").mockImplementation(((): never => {
      throw new Error("process.exit");
    }) as never);

    await expect(runCommand(globalCommand, { rawArgs: ["collect", "install"] })).rejects.toThrow(
      "process.exit",
    );
    // Asserted BEFORE restoring: `mockRestore` also clears the recorded calls.
    expect(exit).toHaveBeenCalledWith(1);
    exit.mockRestore();

    expect(outroMock).not.toHaveBeenCalled();
    const warned = logWarnMock.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
    expect(warned).toContain("/fake/.navori/logs");
  }, 10_000);
});
