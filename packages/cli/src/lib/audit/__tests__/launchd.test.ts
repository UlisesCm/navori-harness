import { describe, it, expect, afterEach } from "vitest";
import { createServer } from "node:http";
import {
  LAUNCH_AGENT_LABEL,
  buildLaunchAgent,
  installedArgv,
  isLaunchdPlatform,
  probeReceiver,
  receiverArgv,
} from "../launchd.ts";
import { startReceiver, type OtelReceiver } from "../collect.ts";

/**
 * What is NOT tested here, deliberately: `installLaunchAgent` and
 * `uninstallLaunchAgent`.
 *
 * Both write into the developer's real `~/Library/LaunchAgents` and shell out
 * to `launchctl`, so a suite that exercised them would load a background agent
 * on whoever ran `pnpm test`. The parts that can be wrong without a machine —
 * the plist's contents, the command it pins, and reading it back — are pure and
 * are covered; the two that cannot are thin wrappers over `launchctl` whose
 * failure the command already surfaces verbatim.
 */

const open: OtelReceiver[] = [];

afterEach(async () => {
  while (open.length > 0) await open.pop()?.close();
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
