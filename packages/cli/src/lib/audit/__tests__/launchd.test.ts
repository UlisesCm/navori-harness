import { describe, it, expect, afterEach, vi } from "vitest";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LAUNCH_AGENT_LABEL,
  buildLaunchAgent,
  installLaunchAgent,
  installedArgv,
  isLaunchdPlatform,
  launchAgentPath,
  probeReceiver,
  receiverArgv,
  uninstallLaunchAgent,
} from "../launchd.ts";
import { startReceiver, type OtelReceiver } from "../collect.ts";

// Lifecycle tests inject a fake launchctl and isolate HOME; no real job runs.

const open: OtelReceiver[] = [];

afterEach(async () => {
  while (open.length > 0) await open.pop()?.close();
});

describe("launchd lifecycle (R12)", () => {
  const originalHome = process.env.HOME;
  let home: string;

  function setupPlist(): string {
    const path = launchAgentPath();
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(path, "original plist");
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

/** A port nobody is listening on: opened to reserve a number, then released. */
async function deadPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", () => done()));
  const address = probe.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((done) => probe.close(() => done()));
  return port;
}

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

describe("probeReceiver (#697)", () => {
  it("reconoce al receptor de navori por su propia ruta de salud", async () => {
    const r = await startReceiver({ port: 0 });
    open.push(r);
    expect(await probeReceiver(r.port)).toBe(true);
  });

  it("dice que no cuando nadie escucha", async () => {
    expect(await probeReceiver(await deadPort())).toBe(false);
  });

  it("no confunde al receptor con otro servidor en el mismo puerto", async () => {
    // The ugly false positive: an operator who already runs an OTLP collector
    // on 4318 would read a green check while every navori event went into
    // somebody else's pipeline. A bare connection cannot tell them apart.
    const impostor = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok"}');
    });
    await new Promise<void>((done) => impostor.listen(0, "127.0.0.1", () => done()));
    const address = impostor.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    expect(await probeReceiver(port)).toBe(false);

    await new Promise<void>((done) => impostor.close(() => done()));
  });
});
