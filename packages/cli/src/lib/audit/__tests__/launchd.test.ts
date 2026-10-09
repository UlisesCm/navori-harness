import { describe, it, expect, afterEach, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LAUNCH_AGENT_LABEL,
  buildLaunchAgent,
  collectLogDir,
  installLaunchAgent,
  installedArgv,
  isLaunchdPlatform,
  launchAgentPath,
  receiverArgv,
  uninstallLaunchAgent,
} from "../launchd.ts";

// Lifecycle tests inject a fake launchctl and isolate HOME; no real job runs.

describe("launchd lifecycle (R12)", () => {
  const originalHome = process.env.HOME;
  let home: string;

  function setupPlist(): string {
    const path = launchAgentPath();
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(path, "original plist", { mode: 0o600 });
    return path;
  }

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  function isolatedHome(): void {
    home = mkdtempSync(join(tmpdir(), "navori-launchd-lifecycle-"));
    process.env.HOME = home;
  }

  // Covers: R10, R11, R12
  it("precreates private supervisor files before fake bootstrap under umask 000", () => {
    isolatedHome();
    const parent = join(home, "Library", "LaunchAgents");
    mkdirSync(parent, { recursive: true });
    chmodSync(parent, 0o755);
    const originalMode = statSync(parent).mode;
    const originalUmask = process.umask(0);
    let loaded = false;
    const controller = vi.fn((args: string[]): { ok: boolean; message: string } => {
      if (args[0] === "print")
        return loaded
          ? { ok: true, message: "" }
          : { ok: false, message: "Could not find service" };
      if (args[0] === "bootstrap") {
        expect(statSync(collectLogDir()).mode & 0o777).toBe(0o700);
        expect(statSync(launchAgentPath()).mode & 0o777).toBe(0o600);
        for (const name of ["collect.out.log", "collect.err.log"]) {
          const file = join(collectLogDir(), name);
          expect(statSync(file).isFile()).toBe(true);
          expect(statSync(file).mode & 0o777).toBe(0o600);
        }
        expect(statSync(parent).mode).toBe(originalMode);
        loaded = true;
      }
      return { ok: true, message: "" };
    });
    try {
      expect(installLaunchAgent(controller)).toMatchObject({ loaded: true, replaced: false });
      expect(controller.mock.calls.some(([args]) => args[0] === "bootstrap")).toBe(true);
    } finally {
      process.umask(originalUmask);
    }
  });

  // Covers: R10, R11, R12
  it.each([
    "public-plist",
    "public-log",
    "symlink-log",
    "nonregular-log",
    "public-log-directory",
  ] as const)("refuses %s unchanged before bootstrap", (unsafe: string) => {
    isolatedHome();
    const plist = setupPlist();
    const dir = collectLogDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const log = join(dir, "collect.out.log");
    const sentinel = join(home, "sentinel.log");
    writeFileSync(sentinel, "private sentinel", { mode: 0o600 });
    if (unsafe === "public-plist") chmodSync(plist, 0o644);
    if (unsafe === "public-log") writeFileSync(log, "public sentinel", { mode: 0o644 });
    if (unsafe === "symlink-log") symlinkSync(sentinel, log);
    if (unsafe === "nonregular-log") mkdirSync(log, { mode: 0o700 });
    if (unsafe === "public-log-directory") chmodSync(dir, 0o755);
    const plistBefore = readFileSync(plist);
    const plistMode = statSync(plist).mode;
    const directoryMode = statSync(dir).mode;
    const controller = vi.fn((_args: string[]): { ok: boolean; message: string } => ({
      ok: false,
      message: "Could not find service",
    }));
    expect(installLaunchAgent(controller).loaded).toBe(false);
    expect(controller.mock.calls.some(([args]) => args[0] === "bootstrap")).toBe(false);
    expect(readFileSync(plist)).toEqual(plistBefore);
    expect(statSync(plist).mode).toBe(plistMode);
    expect(statSync(dir).mode).toBe(directoryMode);
    expect(readFileSync(sentinel, "utf8")).toBe("private sentinel");
    if (unsafe === "public-log") {
      expect(readFileSync(log, "utf8")).toBe("public sentinel");
      expect(statSync(log).mode & 0o777).toBe(0o644);
    }
    if (unsafe === "nonregular-log") expect(statSync(log).isDirectory()).toBe(true);
  });

  // Covers: R12
  it("preserves the plist and reports failed bootout on uninstall", () => {
    isolatedHome();
    const path = setupPlist();
    const controller = vi.fn((args: string[]) =>
      args[0] === "print" ? { ok: true, message: "" } : { ok: false, message: "permission denied" },
    );
    expect(uninstallLaunchAgent(controller)).toMatchObject({
      removed: false,
      unloaded: false,
      error: expect.stringContaining("permission denied"),
    });
    expect(readFileSync(path, "utf8")).toBe("original plist");
  });

  // Covers: R12
  it("does not replace a loaded job if bootout fails", () => {
    isolatedHome();
    const path = setupPlist();
    const controller = vi.fn((args: string[]) =>
      args[0] === "print" ? { ok: true, message: "" } : { ok: false, message: "permission denied" },
    );
    expect(installLaunchAgent(controller)).toMatchObject({
      loaded: false,
      message: expect.stringContaining("permission denied"),
    });
    expect(readFileSync(path, "utf8")).toBe("original plist");
    expect(controller.mock.calls.some(([args]) => args[0] === "bootstrap")).toBe(false);
  });

  // Covers: R12
  it("preserves declaration on query failure instead of treating it as absent", () => {
    isolatedHome();
    const path = setupPlist();
    const controller = vi.fn(() => ({ ok: false, message: "I/O error" }));
    expect(uninstallLaunchAgent(controller).error).toContain("I/O error");
    expect(installLaunchAgent(controller).loaded).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("original plist");
    expect(controller).toHaveBeenCalledTimes(2);
  });

  // Covers: R12
  it("refuses removal or replacement when bootout returns success but the job remains loaded", () => {
    isolatedHome();
    const path = setupPlist();
    const controller = vi.fn((_args: string[]) => ({ ok: true, message: "" }));
    expect(uninstallLaunchAgent(controller).error).toContain("did not unload");
    expect(installLaunchAgent(controller)).toMatchObject({
      loaded: false,
      message: expect.stringContaining("did not unload"),
    });
    expect(readFileSync(path, "utf8")).toBe("original plist");
    expect(controller.mock.calls.some(([args]) => args[0] === "bootstrap")).toBe(false);
  });

  // Covers: R12
  it("unloads a loaded job even if its declaration is already missing", () => {
    isolatedHome();
    let loaded = true;
    const controller = vi.fn((args: string[]) => {
      if (args[0] === "print")
        return loaded
          ? { ok: true, message: "" }
          : { ok: false, message: "Could not find service" };
      loaded = false;
      return { ok: true, message: "" };
    });
    expect(uninstallLaunchAgent(controller)).toMatchObject({ removed: false, unloaded: true });
    expect(controller.mock.calls.some(([args]) => args[0] === "bootout")).toBe(true);
  });

  // Covers: R12
  it("removes an absent job declaration and reports bootstrap failure", () => {
    isolatedHome();
    const path = setupPlist();
    const absent = { ok: false, message: "Could not find service" };
    expect(uninstallLaunchAgent(() => absent)).toMatchObject({ removed: true, unloaded: false });
    expect(existsSync(path)).toBe(false);
    const controller = vi.fn((args: string[]) =>
      args[0] === "print" ? absent : { ok: false, message: "bootstrap denied" },
    );
    expect(installLaunchAgent(controller)).toMatchObject({
      loaded: false,
      message: "bootstrap denied",
    });
    expect(existsSync(path)).toBe(true);
  });

  // Covers: R12
  it("does not report a healthy install when bootstrap succeeds but print stays absent", () => {
    isolatedHome();
    const controller = vi.fn((args: string[]) =>
      args[0] === "print"
        ? { ok: false, message: "Could not find service" }
        : { ok: true, message: "" },
    );
    expect(installLaunchAgent(controller)).toMatchObject({
      loaded: false,
      message: expect.stringContaining("did not load"),
    });
  });

  // Covers: R12
  it("removes only after confirmed unload and can replace a loaded job", () => {
    isolatedHome();
    const path = setupPlist();
    let loaded = true;
    const controller = vi.fn((args: string[]) => {
      if (args[0] === "print")
        return loaded
          ? { ok: true, message: "" }
          : { ok: false, message: "Could not find service" };
      if (args[0] === "bootout") loaded = false;
      if (args[0] === "bootstrap") loaded = true;
      return { ok: true, message: "" };
    });
    expect(installLaunchAgent(controller)).toMatchObject({ loaded: true, replaced: true });
    expect(readFileSync(path, "utf8")).not.toBe("original plist");
    expect(uninstallLaunchAgent(controller)).toMatchObject({ removed: true, unloaded: true });
    expect(existsSync(path)).toBe(false);
  });
});

describe("launchd agent (#697)", () => {
  it("declara RunAtLoad y KeepAlive, que es lo que lo mantiene arriba", () => {
    const plist = buildLaunchAgent(["/usr/bin/node", "/opt/navori", "audit", "--collect"], "/logs");
    expect(plist).toContain(`<string>${LAUNCH_AGENT_LABEL}</string>`);
    // KeepAlive is the issue: a receiver that dies at 3am takes the third
    // source of every session with it until somebody notices.
    expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
    // RunAtLoad is the other half — the machine that rebooted.
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(plist).toContain("<string>--collect</string>");
    expect(plist).toContain("<string>/logs/collect.err.log</string>");
  });

  it("escapa el XML de una ruta con caracteres de markup", () => {
    // A repo under a path with `&` writes a plist launchd refuses to parse,
    // and the failure surfaces as "the agent never loaded" with no reason.
    const plist = buildLaunchAgent(["/usr/bin/node", "/Users/a/R&D/<x>/navori"], "/logs");
    expect(plist).toContain("<string>/Users/a/R&amp;D/&lt;x&gt;/navori</string>");
    expect(plist).not.toContain("R&D");
  });

  it("fija el intérprete además del entry, porque launchd no hereda PATH", () => {
    const argv = receiverArgv();
    expect(argv[0]).toBe(process.execPath);
    expect(argv.slice(2)).toEqual(["audit", "--collect"]);
  });

  it("lee de vuelta el comando que el plist instalado corre", async () => {
    // `installedArgv` reads the FILE, which is the only thing that can answer
    // "does the installed agent still point at a navori that exists".
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const argv = ["/usr/bin/node", "/Users/a/R&D/navori", "audit", "--collect"];
    const dir = mkdtempSync(join(tmpdir(), "navori-launchd-"));
    const file = join(dir, "agent.plist");
    writeFileSync(file, buildLaunchAgent(argv, "/logs"), "utf-8");

    // The reader is exercised through the same escaping the writer applied.
    const home = process.env.HOME;
    process.env.HOME = dir;
    try {
      // `installedArgv` composes its own path, so the round trip is asserted on
      // the parser directly with a file placed where it looks.
      const { mkdirSync, copyFileSync } = await import("node:fs");
      mkdirSync(join(dir, "Library", "LaunchAgents"), { recursive: true });
      copyFileSync(file, join(dir, "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`));
      expect(installedArgv()).toEqual(argv);
    } finally {
      process.env.HOME = home;
    }
  });

  it("solo se declara soportado en darwin", () => {
    expect(isLaunchdPlatform()).toBe(process.platform === "darwin");
  });
});
