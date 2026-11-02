import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

/** Spec 0062 T7 (R84): what `scripts/js/dist-probe.mjs` installs and what it demands. */

interface Plan {
  argv: string[];
  manifest: Record<string, unknown>;
  linked: boolean;
  env?: Record<string, string>;
}
interface Probe {
  MANAGERS: string[];
  installPlan: (manager: string, scripts: boolean, tarballs: string[]) => Plan;
  delegationProbe: (list?: Array<{ path: string[] }>) => string[];
  blockingCase: () => { hook: string; engine: string; expected: { off: { status: number } } };
  isScript: (file: string) => boolean;
  hookPath: (node?: string) => string;
}

const repo = resolve(import.meta.dirname, "..", "..", "..", "..");
const probe = (await import(
  pathToFileURL(join(repo, "scripts", "js", "dist-probe.mjs")).href
)) as Probe;

describe("dist-probe", () => {
  // Covers: R84
  it("cada gestor responde con el binario, el binario por Node o legacy", () => {
    expect(probe.MANAGERS).toEqual(["npm", "pnpm", "bun"]);
    const tarballs = ["/d/navori.tgz", "/d/plat.tgz"];
    const linked = Object.fromEntries(
      probe.MANAGERS.flatMap((m) =>
        [true, false].map((scripts) => [
          `${m}-${scripts}`,
          probe.installPlan(m, scripts, tarballs).linked,
        ]),
      ),
    );
    // only an install that runs the postinstall and links bins to the file itself gets the binary
    expect(linked).toEqual({
      "npm-true": true,
      "npm-false": false,
      "pnpm-true": false,
      "pnpm-false": false,
      "bun-true": true,
      "bun-false": false,
    });
    for (const m of probe.MANAGERS) {
      expect(probe.installPlan(m, false, tarballs).argv).toContain("--ignore-scripts");
      expect(probe.installPlan(m, true, tarballs).argv).not.toContain("--ignore-scripts");
      expect(probe.installPlan(m, true, tarballs).argv.slice(-2)).toEqual(tarballs);
    }
    expect(probe.installPlan("bun", true, tarballs).manifest).toMatchObject({
      trustedDependencies: ["navori"],
    });
    expect(probe.installPlan("pnpm", true, tarballs).env).toEqual({
      PNPM_CONFIG_DANGEROUSLY_ALLOW_ALL_BUILDS: "true",
    });
    expect(() => probe.installPlan("yarn", true, tarballs)).toThrow("unknown manager");

    // F45: a permanent delegation entry when there is one, else a subcommand nobody ports
    expect(probe.delegationProbe([])).toEqual(["__navori-dist-probe"]);
    expect(probe.delegationProbe([{ path: ["codex", "trust"] }])).toEqual([
      "codex",
      "trust",
      "--help",
    ]);

    // the hook runs under Node's directory and the system's, never a package manager's tools
    expect(probe.hookPath("/opt/node/bin/node")).toBe(
      "/opt/node/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    );

    const blocking = probe.blockingCase();
    expect(blocking).toMatchObject({ hook: "guard-destructive.sh", engine: "claude" });
    expect(blocking.expected.off.status).toBe(2);

    const dir = mkdtempSync(join(tmpdir(), "navori-dist-probe-test-"));
    try {
      writeFileSync(join(dir, "launcher"), "#!/usr/bin/env node\n");
      writeFileSync(join(dir, "binary"), Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
      chmodSync(join(dir, "binary"), 0o755);
      expect(probe.isScript(join(dir, "launcher"))).toBe(true);
      expect(probe.isScript(join(dir, "binary"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
