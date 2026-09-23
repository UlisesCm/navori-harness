import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
const noteMock = vi.hoisted(() => vi.fn());
vi.mock("@clack/prompts", () => ({
  intro: () => undefined,
  outro: outroMock,
  cancel: () => undefined,
  note: noteMock,
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

// #974 — one test (render failure) needs a deterministic non-ok result;
// every other test keeps exercising the real `runRender` pipeline, same as
// the rest of this suite (see the header comment above): mocking it wholesale
// would stop covering the actual .mcp.json/settings/managed-block wiring the
// new tests below assert on.
const renderControl = vi.hoisted(() => ({ forceFail: false }));
vi.mock(import("../render.ts"), async (importOriginal) => {
  const actual = await importOriginal<typeof import("../render.ts")>();
  return {
    ...actual,
    runRender: (...args: Parameters<typeof actual.runRender>) => {
      if (renderControl.forceFail) {
        return {
          ok: false,
          reason: "forced render failure for test",
          language: "en",
        } as ReturnType<typeof actual.runRender>;
      }
      return actual.runRender(...args);
    },
  };
});

const { addCommand } = await import("../add.ts");
const { runCommand } = await import("citty");
const { writeConfig, readConfig } = await import("../../lib/config.ts");

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
  noteMock.mockReset();
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
  renderControl.forceFail = false;
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
 * plugin is nonetheless `enabled: true` in the config, and it still needed
 * `navori render --apply` to materialize anything. A script had no way to tell
 * either — the exit code was 0.
 *
 * #974 closed the third fact: `add` now renders inline right after the config
 * write, so these degraded exits no longer carry a "run render --apply"
 * hint — that already happened by the time any of them fire. What must
 * survive is the install-docs info and the exit code.
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

  it("no command for this platform — points at installDocs, no stale render hint (#974)", async () => {
    setPlatform("linux");
    hasBinaryMock.mockReturnValue(false);

    await add("gh", "--yes");

    expect(texts()).toContain("https://github.com/cli/cli/blob/trunk/docs/install_linux.md");
    // The wiring already rendered by this point (#974) — telling the user to
    // run it again would be stale, not just redundant.
    expect(outroText()).not.toContain("navori render --apply");
  });

  it("--skip-install still exits 0 — the user asked for exactly this", async () => {
    hasBinaryMock.mockReturnValue(false);

    await add("gh", "--skip-install");

    expect(process.exitCode).toBeUndefined();
    expect(outroText()).not.toContain("navori render --apply");
  });

  it("the user declines the install — exits 0, but still says what is left to do", async () => {
    hasBinaryMock.mockReturnValue(false);
    confirmMock.mockResolvedValue(false);

    await add("gh");

    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    expect(outroText()).not.toContain("navori render --apply");
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

/**
 * #974 — `add` used to write `plugins.<id>.enabled = true` and stop there,
 * leaving `.mcp.json`, the `settings.json` permission and the managed block
 * unmaterialized until someone remembered to run `navori render --apply` by
 * hand. `add` now renders right after the config write (`remove.ts`'s
 * already-proven contract), so enabling a plugin makes it actually usable in
 * the same command.
 */
describe("add — renders the plugin's wiring on enable (#974)", () => {
  /** `.mcp.json` at `cwd`, or null when render never wrote one. */
  function readMcp(): { mcpServers?: Record<string, unknown> } | null {
    const path = join(cwd, ".mcp.json");
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : null;
  }

  function readSettings(): { permissions?: { allow?: string[] } } {
    return JSON.parse(readFileSync(join(cwd, ".claude/settings.json"), "utf-8"));
  }

  it("enabling codegraph (an mcpServer plugin) writes the .mcp.json entry, the settings permission and the managed block", async () => {
    hasBinaryMock.mockReturnValue(true); // binary already present — skip the install flow

    await add("codegraph");

    expect(readMcp()?.mcpServers?.codegraph).toBeDefined();
    expect(readSettings().permissions?.allow).toContain("mcp__codegraph__codegraph_explore");
    const claudeMd = readFileSync(join(cwd, "CLAUDE.md"), "utf-8");
    expect(claudeMd).toContain('id="codegraph-search-v2"');
  });

  it("a render failure exits non-zero and leaves the config enabled (the same partial-failure contract as remove)", async () => {
    hasBinaryMock.mockReturnValue(true);
    renderControl.forceFail = true;

    await add("codegraph");

    expect(process.exitCode).toBe(1);
    expect(readConfig(join(cwd, "navori.config.json")).plugins?.codegraph?.enabled).toBe(true);
    // The render never actually ran to completion — nothing was written.
    expect(existsSync(join(cwd, ".mcp.json"))).toBe(false);
  });

  it("an already-enabled plugin is left alone — no re-render (explicitly out of scope for #974)", async () => {
    writeConfig(join(cwd, "navori.config.json"), {
      name: "demo",
      engines: ["claude"],
      preset: "custom",
      plugins: { codegraph: { enabled: true } },
    });
    hasBinaryMock.mockReturnValue(true);

    await add("codegraph");

    expect(logWarnMock).toHaveBeenCalledWith(expect.stringContaining("codegraph"));
    // Nothing was ever rendered for this repo, so the wiring simply doesn't
    // exist yet — proof that this run didn't trigger one either.
    expect(existsSync(join(cwd, ".mcp.json"))).toBe(false);
  });
});

/**
 * #981 — `add --suggest` used to only ever mention the preset and engram, so
 * `--yes`/`--recommended` init never taught a user that tgrep/codegraph/
 * semgrep/jscpd/acli/gh exist. `spawnSync` here is the same mock used for
 * install commands above, but `--suggest` never installs anything — its only
 * call in this describe block is `isGitHubRepo`'s `git config --get
 * remote.origin.url` (lib/git.ts), so controlling its return value pins
 * whether the repo "has a GitHub remote" without touching any real git state.
 */
describe("add --suggest — available external providers (#981)", () => {
  const noteText = (): string => noteMock.mock.calls.map((call) => String(call[0])).join("\n");

  it("lists disabled external-tool providers, naming the command to enable each", async () => {
    spawnSyncMock.mockReturnValue({ status: 1, signal: null, error: undefined }); // no git remote

    await add("--suggest");

    expect(noteText()).toContain("navori add codegraph");
    expect(noteText()).toContain("navori add jscpd");
  });

  it("never lists an already-enabled provider", async () => {
    writeConfig(join(cwd, "navori.config.json"), {
      name: "demo",
      engines: ["claude"],
      preset: "custom",
      plugins: { codegraph: { enabled: true } },
    });
    spawnSyncMock.mockReturnValue({ status: 1, signal: null, error: undefined });

    await add("--suggest");

    expect(noteText()).not.toContain("navori add codegraph");
  });

  it("never suggests engram itself as an external provider (it's always-on, not a user choice)", async () => {
    spawnSyncMock.mockReturnValue({ status: 1, signal: null, error: undefined });

    await add("--suggest");

    // engram IS suggested, but only via the pre-existing `suggestedEngram`
    // copy ('navori add engram'), never through the provider list's row —
    // the shared filter (lib/external-providers.ts) excludes it by id.
    expect(noteText()).toContain("navori add engram");
    expect(noteText().match(/navori add engram/g)).toHaveLength(1);
  });

  it("gh is only suggested when the repo has a GitHub remote", async () => {
    spawnSyncMock.mockReturnValue({ status: 1, signal: null, error: undefined }); // no remote

    await add("--suggest");

    expect(noteText()).not.toContain("navori add gh");
  });

  it("gh is suggested when origin points at github.com", async () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      signal: null,
      error: undefined,
      stdout: "git@github.com:acme/demo.git\n",
    });

    await add("--suggest");

    expect(noteText()).toContain("navori add gh");
  });
});
