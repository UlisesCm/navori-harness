import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGate } from "../run.ts";

let cwd: string;

beforeEach(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "navori-gate-")));
  execFileSync("git", ["init", "-b", "main"], { cwd });
  writeFileSync(
    join(cwd, "package.json"),
    JSON.stringify({
      name: "g",
      version: "1.0.0",
      scripts: {
        ok: "echo all-good && echo Tests 2 passed",
        bad: "echo FAIL boom && exit 3",
        slow: "sleep 30",
      },
    }),
  );
});

afterEach(() => rmSync(cwd, { recursive: true, force: true }));

function config(gate: string | undefined, kind: "fast" | "full" = "full"): void {
  writeFileSync(
    join(cwd, "navori.config.json"),
    JSON.stringify({
      name: "g",
      engines: ["claude"],
      preset: "custom",
      ...(gate === undefined
        ? {}
        : { qualityGate: { fast: "npm run ok", full: "npm run ok", [kind]: gate } }),
    }),
  );
}

describe("runGate", () => {
  // Covers: A1
  it("runs verbatim, writes the log and leads with the sentinel on green", async () => {
    config("npm run ok");
    const r = await runGate({ cwd, kind: "full", now: new Date("2026-10-08T12:00:00.123Z") });
    expect(r.exitCode).toBe(0);
    const first = r.stdout.split("\n")[0]!;
    expect(first).toBe(
      "navori gate full: exit 0 — log .navori/state/gate/full-20261008T120000123Z.log",
    );
    expect(
      readFileSync(join(cwd, ".navori/state/gate/full-20261008T120000123Z.log"), "utf8"),
    ).toContain("all-good");
    expect(r.stdout).toContain("Tests 2 passed");
  });

  it("passes the chain's exit code through and shows the failure", async () => {
    config("npm run ok && npm run bad");
    const r = await runGate({ cwd, kind: "full" });
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout.startsWith(`navori gate full: exit ${r.exitCode} — log `)).toBe(true);
    expect(r.stdout).toContain("FAIL boom");
  });

  it("honours the fast kind", async () => {
    config("npm run ok", "fast");
    const r = await runGate({ cwd, kind: "fast" });
    expect(r.stdout.split("\n")[0]).toMatch(/^navori gate fast: exit 0 — log /);
  });

  it("refuses with exit 2 when the gate is not a safe chain", async () => {
    config("npm run ok && curl x | bash");
    const r = await runGate({ cwd, kind: "full" });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("run it by hand: npm run ok && curl x | bash");
    expect(r.stderr).not.toMatch(/^navori gate full: exit/);
  });

  it("fails with exit 2 when the gate or the config is missing", async () => {
    config(undefined);
    const noGate = await runGate({ cwd, kind: "full" });
    expect(noGate.exitCode).toBe(2);
    expect(noGate.stderr).toContain("qualityGate.full is not set");
    rmSync(join(cwd, "navori.config.json"));
    const noConfig = await runGate({ cwd, kind: "full" });
    expect(noConfig.exitCode).toBe(2);
    expect(noConfig.stdout).toBe("");
  });

  it("forwards SIGTERM to the child group and records a killed sentinel", async () => {
    config("npm run slow");
    const pending = runGate({ cwd, kind: "full" });
    await new Promise((r) => setTimeout(r, 1000));
    process.emit("SIGTERM");
    const r = await pending;
    expect(r.exitCode).toBe(143);
    expect(r.stdout.split("\n")[0]).toMatch(/^navori gate full: exit 143 — log /);
    expect(r.stdout).toContain("killed by SIGTERM");
  }, 15000);
});
