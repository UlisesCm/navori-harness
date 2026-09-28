import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderCodexEngine } from "../../engines/codex/index.ts";
import { NavoriConfigSchema } from "../../lib/config/schema.ts";

/**
 * `navori codex trust` (spec 0035 T9) writes OUTSIDE the repo, to the
 * developer's `~/.codex/config.toml` — a critical area. `safeHomedir` is
 * mocked so every test writes/reads a throwaway fake home, never the real
 * `~/.codex`; `NAVORI_BACKUP_ROOT` (set globally by vitest.setup.ts) already
 * isolates `~/.navori/backups`. `@clack/prompts` is mocked so no test needs a
 * real TTY, and `codex app-server` is never spawned (`defaultVerify` is
 * replaced by a no-op `verify` when calling `runCodexTrust` directly).
 */
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock(import("../../lib/primitives/home.ts"), () => ({ safeHomedir: () => home.dir }));

const confirmMock = vi.hoisted(() => vi.fn());
vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  note: vi.fn(),
  confirm: confirmMock,
  isCancel: () => false,
  log: {
    message: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    step: vi.fn(),
  },
}));

const { runCodexTrust } = await import("../codex.ts");
const p = await import("@clack/prompts");

function writeRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "navori-codex-trust-repo-"));
  const input = { name: "cx", engines: ["codex"], preset: "custom", branchBase: "main" };
  writeFileSync(join(cwd, "navori.config.json"), JSON.stringify(input));
  renderCodexEngine(cwd, NavoriConfigSchema.parse(input));
  return cwd;
}

function homeConfigPath(): string {
  return join(home.dir, ".codex", "config.toml");
}

const noopVerify = async () => null;

let cwd: string;
let backupRootDir: string;

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "navori-codex-trust-home-"));
  cwd = writeRepo();
  confirmMock.mockReset();
  vi.mocked(p.cancel).mockClear();
  vi.mocked(p.outro).mockClear();
  vi.mocked(p.log.success).mockClear();
  vi.mocked(p.log.warn).mockClear();
  backupRootDir = process.env.NAVORI_BACKUP_ROOT ?? "";
});

afterEach(() => {
  rmSync(home.dir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function backupFileCount(): number {
  if (!existsSync(backupRootDir)) return 0;
  return readdirSync(backupRootDir).filter((f) => f.startsWith("codex-config-")).length;
}

describe("navori codex trust — safe writes to ~/.codex/config.toml (spec 0035 T9)", () => {
  // Covers: R20
  it("refuses trust when the project's hook command was edited", async () => {
    const path = join(cwd, ".codex/config.toml");
    writeFileSync(
      path,
      readFileSync(path, "utf-8").replace("guard-destructive.sh", "wrong-guard.sh"),
    );
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);
    await expect(runCodexTrust(cwd, { yes: true, verify: noopVerify })).rejects.toThrow(
      "process.exit",
    );
    expect(exit).toHaveBeenCalledWith(1);
    exit.mockRestore();
    expect(existsSync(homeConfigPath())).toBe(false);
  });
  // Covers: R14, R15
  it("no confirmation writes nothing and makes no backup", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    confirmMock.mockResolvedValue(false);
    const before = backupFileCount();

    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);
    await expect(runCodexTrust(cwd, { verify: noopVerify })).rejects.toThrow("process.exit");
    expect(exit).toHaveBeenCalledWith(1);
    exit.mockRestore();

    expect(existsSync(homeConfigPath())).toBe(false);
    expect(backupFileCount()).toBe(before);
  });

  // Covers: R15
  it("non-TTY without --yes exits non-zero and writes nothing", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);
    await expect(runCodexTrust(cwd, { verify: noopVerify })).rejects.toThrow("process.exit");
    expect(exit).toHaveBeenCalledWith(1);
    exit.mockRestore();

    expect(confirmMock).not.toHaveBeenCalled();
    expect(existsSync(homeConfigPath())).toBe(false);
  });

  // Covers: R13, R14
  it("second run is a no-op — approves once, idempotent after", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    confirmMock.mockResolvedValue(true);

    await runCodexTrust(cwd, { yes: true, verify: noopVerify });
    expect(existsSync(homeConfigPath())).toBe(true);
    const afterFirst = readFileSync(homeConfigPath(), "utf-8");
    const backupsAfterFirst = backupFileCount();

    await runCodexTrust(cwd, { yes: true, verify: noopVerify });
    const afterSecond = readFileSync(homeConfigPath(), "utf-8");

    expect(afterSecond).toBe(afterFirst);
    expect(backupFileCount()).toBe(backupsAfterFirst); // no new backup — nothing was written
    expect(vi.mocked(p.outro)).toHaveBeenLastCalledWith(
      expect.stringContaining("ya está aprobado"),
    );
  });

  // Covers: R14
  it("aborts if the config changed after the confirmation was shown", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    confirmMock.mockImplementation(async () => {
      // Simulates a concurrent writer (another `navori codex trust`, or the
      // user running `/hooks`) landing WHILE the confirmation is up.
      mkdirSync(join(home.dir, ".codex"), { recursive: true });
      writeFileSync(homeConfigPath(), '[projects."/somewhere/else"]\ntrust_level = "trusted"\n');
      return true;
    });

    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);
    await expect(runCodexTrust(cwd, { verify: noopVerify })).rejects.toThrow("process.exit");
    expect(exit).toHaveBeenCalledWith(1);
    exit.mockRestore();

    // Nothing of ours was written — only the concurrent writer's content survives.
    const text = readFileSync(homeConfigPath(), "utf-8");
    expect(text).toContain("/somewhere/else");
    expect(text).not.toContain(cwd);
  });

  it("preserves an existing file's mode 0600 and backs it up before writing", async () => {
    mkdirSync(join(home.dir, ".codex"), { recursive: true });
    writeFileSync(homeConfigPath(), "# pre-existing\n", { mode: 0o600 });
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    confirmMock.mockResolvedValue(true);

    await runCodexTrust(cwd, { yes: true, verify: noopVerify });

    const { statSync } = await import("node:fs");
    expect(statSync(homeConfigPath()).mode & 0o777).toBe(0o600);
    expect(backupFileCount()).toBeGreaterThan(0);
    const written = readFileSync(homeConfigPath(), "utf-8");
    expect(written).toContain("# pre-existing");
    expect(written).toContain(`[projects."`);
  });
});
