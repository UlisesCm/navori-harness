import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCommand } from "citty";
import { preflightReviewEdits } from "../../lib/handoff/review-edit-binding.ts";
import { executeReviewPreflight, receiptCommand } from "../receipt.ts";

vi.mock(import("../../lib/handoff/review-edit-binding.ts"), async (load) => ({
  ...(await load()),
  preflightReviewEdits: vi.fn(),
}));
beforeEach(() => {
  process.exitCode = 0;
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});
afterEach(() => {
  process.exitCode = 0;
  vi.restoreAllMocks();
});

describe("receipt review preflight", () => {
  it("prints structured diagnostics and returns nonzero before any expensive review", () => {
    vi.mocked(preflightReviewEdits).mockReturnValue({
      status: "error",
      reason: "unsupported-host-hook",
    });
    executeReviewPreflight({ feature: "demo", hostCwd: "/host", cwd: "/target", json: true });
    expect(preflightReviewEdits).toHaveBeenCalledWith({
      feature: "demo",
      hostCwd: "/host",
      cwd: "/target",
      json: true,
    });
    expect(process.stdout.write).toHaveBeenCalledWith(
      '{"status":"error","reason":"unsupported-host-hook"}\n',
    );
    expect(process.exitCode).toBe(1);
  });

  it("wires typed host-cwd and defaults the target to the actual process cwd", async () => {
    vi.mocked(preflightReviewEdits).mockReturnValue({
      status: "ok",
      reason: "bound-review-output",
    });
    await runCommand(receiptCommand, {
      rawArgs: ["review", "preflight", "demo", "--host-cwd", "/host", "--json"],
    });
    expect(preflightReviewEdits).toHaveBeenLastCalledWith(
      expect.objectContaining({ feature: "demo", hostCwd: "/host", cwd: process.cwd() }),
    );
    expect(process.exitCode).toBe(0);
  });
});
