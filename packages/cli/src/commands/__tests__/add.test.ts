import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * #953 — "the binary is on PATH" and "the plugin's setup is done" are
 * different facts. `add.ts` used to treat them as the same thing: once
 * `hasBinary` found the binary, it returned before ever looking at
 * `postInstall`, so a preinstalled `gh` never ran `gh auth status` and the
 * `publisher` agent failed at runtime on `gh pr create`. Worse, a FAILED
 * postInstall (binary installed, postInstall crashed) left the binary on
 * PATH, so retrying `add` hit the same early return forever — the
 * regression pinned by the last test below.
 *
 * `hasBinary` and `spawnSync` are mocked so no real install ever runs.
 * `@clack/prompts` is mocked so `confirm` is a spy instead of a real
 * terminal prompt — its call count is the signal that the postInstall
 * offer was reached.
 */

const hasBinaryMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/which.ts", () => ({ hasBinary: hasBinaryMock }));

const spawnSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawnSync: spawnSyncMock }));

const confirmMock = vi.hoisted(() => vi.fn());
vi.mock("@clack/prompts", () => ({
  intro: () => undefined,
  outro: () => undefined,
  cancel: () => undefined,
  note: () => undefined,
  log: {
    message: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    success: () => undefined,
    step: () => undefined,
  },
  confirm: confirmMock,
  isCancel: () => false,
  spinner: () => ({ start: () => undefined, message: () => undefined, stop: () => undefined }),
}));

const { addCommand } = await import("../add.ts");
const { runCommand } = await import("citty");
const { writeConfig } = await import("../../lib/config.ts");

let cwd: string;
let originalPlatform: PropertyDescriptor | undefined;

/** gh's manifest omits a linux installer; pin darwin so the install branch
 * (test 3) is deterministic across the CI matrix. */
function setPlatform(platform: string): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

async function add(...argv: string[]): Promise<void> {
  await runCommand(addCommand, { rawArgs: [...argv, "--cwd", cwd] });
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-add-"));
  writeConfig(join(cwd, "navori.config.json"), {
    name: "demo",
    engines: ["claude"],
    preset: "custom",
  });

  hasBinaryMock.mockReset();
  confirmMock.mockReset();
  confirmMock.mockResolvedValue(true);
  spawnSyncMock.mockReset();
  spawnSyncMock.mockReturnValue({ status: 0, signal: null, error: undefined });

  originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  setPlatform("darwin");
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
});

describe("add — postInstall reachability (#953)", () => {
  it("binary present + plugin WITH postInstall (gh) — offers and runs it", async () => {
    hasBinaryMock.mockReturnValue(true);

    await add("gh");

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    expect(spawnSyncMock.mock.calls[0]?.[0]).toBe("gh auth status || gh auth login");
  });

  it("binary present + plugin WITHOUT postInstall (semgrep) — unchanged, no prompt", async () => {
    hasBinaryMock.mockReturnValue(true);

    await add("semgrep");

    expect(confirmMock).not.toHaveBeenCalled();
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("binary absent — installs, then runs postInstall, in that order", async () => {
    hasBinaryMock.mockReturnValue(false);

    await add("gh", "--yes");

    expect(confirmMock).not.toHaveBeenCalled(); // --yes skips prompts entirely
    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
    expect(spawnSyncMock.mock.calls[0]?.[0]).toBe("brew install gh");
    expect(spawnSyncMock.mock.calls[1]?.[0]).toBe("gh auth status || gh auth login");
  });

  it("--skip-install runs neither install nor postInstall (binary absent)", async () => {
    hasBinaryMock.mockReturnValue(false);

    await add("gh", "--skip-install");

    expect(confirmMock).not.toHaveBeenCalled();
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("--skip-install also skips the postInstall offer (binary already present)", async () => {
    hasBinaryMock.mockReturnValue(true);

    await add("gh", "--skip-install");

    expect(confirmMock).not.toHaveBeenCalled();
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("a failed postInstall stays reachable on the next run — the regression this issue fixes", async () => {
    hasBinaryMock.mockReturnValue(true);
    spawnSyncMock.mockReturnValue({ status: 1, signal: null, error: undefined }); // postInstall fails

    await add("gh");
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);

    // Before the fix, `if (installed) return` short-circuited BEFORE
    // postInstall was ever considered again — this second call proves it
    // is offered again instead of being silently skipped forever.
    await add("gh");
    expect(confirmMock).toHaveBeenCalledTimes(2);
    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
  });
});
