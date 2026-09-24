import { describe, it, expect, vi, afterEach } from "vitest";
import type { OtelReceiver, ReceiverStats } from "../../lib/audit/collect.ts";

/**
 * #1014 — `audit --collect` used to resolve the repo from `cwd` BEFORE
 * checking the `--collect` flag: `repoFromCwd("/")` returns `""` (an empty
 * basename), and `repoAuditDir("")` rejects it as `invalid-repo-name`. That
 * ran on every launchd start (its cwd is `/`), so the receiver crash-looped
 * before it ever opened its port — the receiver is global and routes events
 * by session id, so it never needed the repo in the first place.
 *
 * `startReceiver` is mocked so this never binds the real port 4318; the
 * "interrupted" wait is unblocked with `process.emit("SIGTERM")` — an
 * in-process event, not a real OS signal — so the test controls exactly when
 * the receiver stops without a real timer.
 */

const startReceiverMock = vi.hoisted(() => vi.fn<() => Promise<OtelReceiver>>());
vi.mock(import("../../lib/audit/collect.ts"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, startReceiver: startReceiverMock };
});

const { runCommand } = await import("citty");
const { auditCommand } = await import("../audit.ts");

/** A fake receiver that never actually opens a socket. */
function fakeReceiver(): OtelReceiver {
  const stats: ReceiverStats = { written: 0, discarded: 0, sessions: 0 };
  return {
    url: "http://127.0.0.1:4318/v1/logs",
    endpoint: "127.0.0.1:4318",
    port: 4318,
    stats: () => stats,
    close: async () => undefined,
  };
}

afterEach(() => {
  startReceiverMock.mockReset();
});

describe("audit --collect does not resolve the repo from cwd (#1014, A1)", () => {
  it("starts the receiver from a cwd with no usable repo name, like launchd's '/'", async () => {
    startReceiverMock.mockResolvedValue(fakeReceiver());
    // Defensive, not incidental: on the pre-fix code this path called
    // `process.exit(1)` for real (`repoAuditDir("")` throwing
    // `invalid-repo-name`), which would kill the test worker instead of
    // failing the assertion below. Spied so a regression fails loud instead.
    const exit = vi.spyOn(process, "exit").mockImplementation(((): never => {
      throw new Error("process.exit");
    }) as never);

    try {
      const run = runCommand(auditCommand, { rawArgs: ["--cwd", "/", "--json", "--collect"] });
      // Give the run loop one tick to reach `startReceiver` and register its
      // SIGINT/SIGTERM listeners before the interrupt is emitted.
      await new Promise((r) => setTimeout(r, 0));
      process.emit("SIGTERM");
      await run;
    } finally {
      exit.mockRestore();
    }

    // The whole point: it got far enough to call `startReceiver` at all,
    // which on the pre-fix code never happened — `repoAuditDir("")` threw and
    // `process.exit(1)`'d first.
    expect(startReceiverMock).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
  });
});
