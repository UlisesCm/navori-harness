import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  refreshRun: vi.fn(),
  fetchLatest: vi.fn<() => Promise<string | undefined>>(),
  plan: vi.fn(),
  spawn: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock("../refresh.ts", async () => {
  const { defineCommand } = await import("citty");
  return {
    refreshCommand: defineCommand({
      meta: { name: "refresh" },
      args: { cwd: { type: "string" }, yes: { type: "boolean" } },
      run: (ctx) => mocks.refreshRun(ctx.args),
    }),
  };
});
vi.mock("../../lib/primitives/update-notice.ts", () => ({
  fetchLatestVersion: mocks.fetchLatest,
  installPlan: mocks.plan,
}));
vi.mock("../../lib/render/bundled-assets.ts", () => ({ readCliVersion: () => "1.0.0" }));
vi.mock("node:child_process", () => ({ spawnSync: mocks.spawn }));
vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  isCancel: () => false,
  confirm: mocks.confirm,
  log: { info: vi.fn(), error: vi.fn(), message: vi.fn() },
}));

import { updateCommand, UPDATE_REEXEC_ENV } from "../update.ts";

const globalPlan = {
  kind: "global",
  install: ["npm", "i", "-g", "navori@latest"],
  exec: (a: string[]) => ["navori", ...a],
};
const npxPlan = { kind: "npx", exec: (a: string[]) => ["npx", "navori@latest", ...a] };

type Args = { cwd?: string; yes?: boolean; "cli-only"?: boolean };
let cwd: string;
let prefix: string;
const ttyOrig = [process.stdin.isTTY, process.stdout.isTTY];
const setTty = (value: boolean): void => {
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value });
};
const go = (args: Args = {}) =>
  updateCommand.run!({ args: { cwd, ...args }, rawArgs: [], cmd: updateCommand } as never);

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-update-cli-"));
  mocks.spawn.mockReturnValue({ status: 0 });
  mocks.plan.mockReturnValue(globalPlan);
  setTty(true);
  process.exitCode = undefined;
  delete process.env[UPDATE_REEXEC_ENV];
  prefix = mkdtempSync(join(tmpdir(), "navori-prefix-"));
  process.env.npm_config_prefix = prefix;
});
afterEach(() => {
  vi.clearAllMocks();
  rmSync(cwd, { recursive: true, force: true });
  rmSync(prefix, { recursive: true, force: true });
  delete process.env.npm_config_prefix;
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: ttyOrig[0] });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: ttyOrig[1] });
  process.exitCode = undefined;
});

function installGlobalBin(): void {
  mkdirSync(join(prefix, "bin"), { recursive: true });
  writeFileSync(join(prefix, "bin", "navori"), "");
}

describe("navori update", () => {
  it("unresolvable global bin: no PATH guess, no refresh, exit 0 after a successful install", async () => {
    mocks.fetchLatest.mockResolvedValue("1.1.0");
    await go({ yes: true });
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBeUndefined();
  });

  it("always forwards the absolute resolved --cwd (relative and omitted)", async () => {
    mocks.fetchLatest.mockResolvedValue("1.1.0");
    mocks.plan.mockReturnValue({
      kind: "devDependency",
      install: ["npm", "install", "--save-dev", "navori@latest"],
      cwd: "/some/manifest",
      exec: (a: string[]) => ["npm", "exec", "--no", "--", "navori", ...a],
    });
    const orig = process.cwd();
    process.chdir(cwd);
    try {
      await updateCommand.run!({ args: { yes: true }, rawArgs: [], cmd: updateCommand } as never);
      await updateCommand.run!({
        args: { yes: true, cwd: "." },
        rawArgs: [],
        cmd: updateCommand,
      } as never);
    } finally {
      process.chdir(orig);
    }
    const real =
      process.platform === "darwin"
        ? await import("node:fs").then((f) => f.realpathSync(cwd))
        : cwd;
    for (const i of [1, 3]) {
      const argv = mocks.spawn.mock.calls[i]![1] as string[];
      expect(argv.slice(-4)).toEqual(["refresh", "--cwd", real, "--yes"]);
    }
  });

  it("up to date: skips install and runs refresh in-process", async () => {
    mocks.fetchLatest.mockResolvedValue("1.0.0");
    await go();
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.refreshRun).toHaveBeenCalledTimes(1);
  });

  it("offline: continues with refresh", async () => {
    mocks.fetchLatest.mockResolvedValue(undefined);
    await go();
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.refreshRun).toHaveBeenCalledTimes(1);
  });

  it("newer + confirm: installs via argv array, then re-execs refresh with the loop guard", async () => {
    mocks.fetchLatest.mockResolvedValue("1.1.0");
    mocks.confirm.mockResolvedValue(true);
    installGlobalBin();
    await go({ yes: false });
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    expect(mocks.spawn.mock.calls[0]).toMatchObject([
      "npm",
      ["i", "-g", "navori@latest"],
      { shell: false },
    ]);
    const [bin, argv, opts] = mocks.spawn.mock.calls[1]!;
    expect(bin).toBe(join(prefix, "bin", "navori"));
    expect(argv).toEqual(["refresh", "--cwd", cwd]);
    expect(opts.env[UPDATE_REEXEC_ENV]).toBe("1");
    expect(mocks.refreshRun).not.toHaveBeenCalled();
  });

  it("newer + decline: installs nothing and does not refresh", async () => {
    mocks.fetchLatest.mockResolvedValue("1.1.0");
    mocks.confirm.mockResolvedValue(false);
    await go();
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.refreshRun).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("--yes: no prompt, forwards --yes to the new binary", async () => {
    mocks.fetchLatest.mockResolvedValue("1.1.0");
    installGlobalBin();
    await go({ yes: true });
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.spawn.mock.calls[1]![1]).toEqual(["refresh", "--cwd", cwd, "--yes"]);
  });

  it("--cli-only: installs and stops, with or without an update", async () => {
    mocks.fetchLatest.mockResolvedValue("1.1.0");
    await go({ yes: true, "cli-only": true });
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    mocks.fetchLatest.mockResolvedValue("1.0.0");
    await go({ "cli-only": true });
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(mocks.refreshRun).not.toHaveBeenCalled();
  });

  it("install failure: non-zero exit and no refresh", async () => {
    mocks.fetchLatest.mockResolvedValue("1.1.0");
    mocks.spawn.mockReturnValue({ status: 1 });
    await go({ yes: true });
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(mocks.refreshRun).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("non-TTY without --yes: never prompts, never installs, exits non-zero", async () => {
    setTty(false);
    mocks.fetchLatest.mockResolvedValue("1.1.0");
    await go();
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("loop guard: the re-executed binary skips the registry check", async () => {
    process.env[UPDATE_REEXEC_ENV] = "1";
    await go();
    expect(mocks.fetchLatest).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.refreshRun).toHaveBeenCalledTimes(1);
  });

  it("npx: nothing to install, re-execs npx navori@latest refresh", async () => {
    mocks.plan.mockReturnValue(npxPlan);
    mocks.fetchLatest.mockResolvedValue("1.1.0");
    await go();
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(mocks.spawn.mock.calls[0]![0]).toBe("npx");
    expect(mocks.spawn.mock.calls[0]![1]).toEqual(["navori@latest", "refresh", "--cwd", cwd]);
  });
});
