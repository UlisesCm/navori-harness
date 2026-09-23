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
vi.mock(import("../../lib/which.ts"), () => ({ hasBinary: hasBinaryMock }));

const spawnSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawnSync: spawnSyncMock }));

const confirmMock = vi.hoisted(() => vi.fn());
const outroMock = vi.hoisted(() => vi.fn());
const logInfoMock = vi.hoisted(() => vi.fn());
const logWarnMock = vi.hoisted(() => vi.fn());
vi.mock("@clack/prompts", () => ({
  intro: () => undefined,
  outro: outroMock,
  cancel: () => undefined,
  note: () => undefined,
  log: {
    message: () => undefined,
    info: logInfoMock,
    warn: logWarnMock,
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
let originalIsTTY: PropertyDescriptor | undefined;

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
  outroMock.mockReset();
  logInfoMock.mockReset();
  logWarnMock.mockReset();
  confirmMock.mockReset();
  confirmMock.mockResolvedValue(true);
  spawnSyncMock.mockReset();
  spawnSyncMock.mockReturnValue({ status: 0, signal: null, error: undefined });

  originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  setPlatform("darwin");

  // The runner's real stdin.isTTY varies between local and CI (#967) — pin it
  // so postInstall tests exercise the TTY-present path by default. The
  // no-TTY behavior gets its own dedicated test below.
  originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
  if (originalIsTTY) {
    Object.defineProperty(process.stdin, "isTTY", originalIsTTY);
  } else {
    Reflect.deleteProperty(process.stdin, "isTTY");
  }
  // `add` now signals failure via `process.exitCode` (#965). That is the
  // vitest process' OWN exit code: leaving it set would fail the whole run
  // with every test green.
  process.exitCode = undefined;
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
    // First call is the pre-install check (absent); second is the #960
    // post-install verification, which now sees the binary landed.
    hasBinaryMock.mockReturnValueOnce(false).mockReturnValue(true);

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

  it("no TTY on stdin — postInstall is skipped with a warning naming the exact command, even with --yes (#967)", async () => {
    hasBinaryMock.mockReturnValue(true);
    Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });

    await add("gh", "--yes");

    expect(confirmMock).not.toHaveBeenCalled();
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(logWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("gh auth status || gh auth login"),
    );
  });

  it("no TTY on stdin, binary absent — installs, then skips postInstall with a warning naming the command (#967)", async () => {
    // Pre-install check: absent. Post-install verification: landed.
    hasBinaryMock.mockReturnValueOnce(false).mockReturnValue(true);
    Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });

    await add("gh", "--yes");

    // The install itself doesn't need a TTY and must still run — only the
    // chained postInstall is guarded.
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    expect(spawnSyncMock.mock.calls[0]?.[0]).toBe("brew install gh");
    expect(logWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("gh auth status || gh auth login"),
    );
  });
});

/**
 * #960 — the install path used to declare success from the exit code alone
 * and threw away stderr (`stdio: "inherit"`), so a failure only ever
 * reached the user as "exited with status N". These tests pin: (1) a 0 exit
 * with the binary still unreachable is NOT success, (2) a normal success
 * still works once the binary lands, (3) a real failure carries the actual
 * stderr, and (4) `postInstall` keeps `stdio: "inherit"` — capturing it
 * would silently break interactive commands like `gh auth login`.
 */
describe("add — install verification + stderr capture (#960)", () => {
  it("install exits 0 but the binary never lands on PATH — not declared a success, names the probable cause", async () => {
    // Pre-install check: absent. Post-install verification: still absent.
    hasBinaryMock.mockReturnValue(false);

    await add("gh", "--yes");

    // Only the install ran — a failed verification must not chain postInstall.
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    expect(spawnSyncMock.mock.calls[0]?.[0]).toBe("brew install gh");
  });

  it("install exits 0 and the binary lands on PATH — normal success, postInstall still runs", async () => {
    hasBinaryMock.mockReturnValueOnce(false).mockReturnValue(true);

    await add("gh", "--yes");

    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
    expect(spawnSyncMock.mock.calls[0]?.[0]).toBe("brew install gh");
    expect(spawnSyncMock.mock.calls[1]?.[0]).toBe("gh auth status || gh auth login");
  });

  it("install fails with stderr — the error carries the real message, not just the exit code", async () => {
    hasBinaryMock.mockReturnValue(false);
    spawnSyncMock.mockReturnValue({
      status: 1,
      signal: null,
      error: undefined,
      stderr: "brew: command not found: gh (formula removed)",
    });

    await add("gh", "--yes");

    // The install command was invoked with stderr piped (captured) while
    // stdin/stdout stay inherited — long installs (brew/npm/pnpm) must still
    // show live progress, only stderr is captured for the error message.
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    const [, options] = spawnSyncMock.mock.calls[0] ?? [];
    expect((options as { stdio?: unknown } | undefined)?.stdio).toEqual([
      "inherit",
      "inherit",
      "pipe",
    ]);
  });

  it("postInstall keeps stdio: inherit — capturing it would break gh auth login", async () => {
    hasBinaryMock.mockReturnValue(true);

    await add("gh");

    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    expect(spawnSyncMock.mock.calls[0]?.[0]).toBe("gh auth status || gh auth login");
    const [, options] = spawnSyncMock.mock.calls[0] ?? [];
    expect((options as { stdio?: unknown } | undefined)?.stdio).toBe("inherit");
  });
});

/**
 * #965 — when no install command exists for the platform, `add` used to print
 * "install it manually" (no destination) and then close with the plain success
 * outro, `Listo`. Three facts were lost at once: nothing was installed, the
 * plugin is nonetheless `enabled: true` in the config, and it still needs
 * `navori render --apply` to materialize anything. A script had no way to tell
 * either — the exit code was 0.
 *
 * `gh` on linux is the live instance of that cell (upstream documents Linux
 * per distro, so the manifest carries `installDocs`, not a command).
 */
describe("add — degraded exits when nothing got installed (#965)", () => {
  const texts = (): string =>
    [...outroMock.mock.calls, ...logInfoMock.mock.calls, ...logWarnMock.mock.calls]
      .map((call) => String(call[0]))
      .join("\n");
  const outroText = (): string => outroMock.mock.calls.map((call) => String(call[0])).join("\n");

  it("no command for this platform — exits non-zero instead of closing on success", async () => {
    setPlatform("linux");
    hasBinaryMock.mockReturnValue(false);

    await add("gh", "--yes");

    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("no command for this platform — points at installDocs and keeps the render hint", async () => {
    setPlatform("linux");
    hasBinaryMock.mockReturnValue(false);

    await add("gh", "--yes");

    expect(texts()).toContain("https://github.com/cli/cli/blob/trunk/docs/install_linux.md");
    // The hint every successful exit carries. Without it the plugin is enabled
    // on paper and never materializes a file.
    expect(outroText()).toContain("navori render --apply");
  });

  it("--skip-install still exits 0 — the user asked for exactly this", async () => {
    hasBinaryMock.mockReturnValue(false);

    await add("gh", "--skip-install");

    expect(process.exitCode).toBeUndefined();
    expect(outroText()).toContain("navori render --apply");
  });

  it("the user declines the install — exits 0, but still says what is left to do", async () => {
    hasBinaryMock.mockReturnValue(false);
    confirmMock.mockResolvedValue(false);

    await add("gh");

    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    expect(outroText()).toContain("navori render --apply");
  });

  it("install ran and the binary never landed — exits non-zero", async () => {
    hasBinaryMock.mockReturnValue(false);

    await add("gh", "--yes");

    expect(spawnSyncMock.mock.calls[0]?.[0]).toBe("brew install gh");
    expect(process.exitCode).toBe(1);
  });

  it("on a platform navori has no matrix for, it never runs another OS's command", async () => {
    // Pre-#965 this folded into win32 and offered `winget install --id
    // GitHub.cli` — through spawnSync(cmd, { shell: true }) — on FreeBSD.
    setPlatform("freebsd");
    hasBinaryMock.mockReturnValue(false);

    await add("gh", "--yes");

    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
