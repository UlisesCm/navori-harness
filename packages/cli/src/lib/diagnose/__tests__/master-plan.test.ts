import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { NavoriConfigSchema, type NavoriConfig } from "../../config/schema.ts";
import { scanMasterPlan } from "../master-plan.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, "..", "..", "..", "..", "dist", "index.js");
const dirs: string[] = [];

interface DoctorReport {
  masterPlan: Array<{
    kind:
      | "invalid-index"
      | "missing-raw-gitignore"
      | "flag-registry-desync"
      | "invalid-state"
      | "deliveries-pending";
    path?: string;
    detail?: string;
    repair?: "init" | "checkout" | "close";
  }>;
}

function repo(masterPlan = false): string {
  const cwd = mkdtempSync(join(tmpdir(), "navori-master-plan-doctor-"));
  dirs.push(cwd);
  writeFileSync(join(cwd, "navori.config.json"), JSON.stringify(config(masterPlan)));
  return cwd;
}

function config(masterPlan = false): NavoriConfig {
  return NavoriConfigSchema.parse({
    name: "master-plan-doctor",
    engines: ["claude"],
    preset: "custom",
    harness: { masterPlan },
  });
}

function writeIndex(cwd: string, state: "activa" | "cerrada"): string {
  const dir = "01-bootstrap";
  const master = join(cwd, "specs", "_master");
  mkdirSync(join(master, dir, "context", "raw"), { recursive: true });
  writeFileSync(
    join(master, "index.json"),
    JSON.stringify({
      version: 1,
      stages: [
        {
          number: 1,
          slug: "bootstrap",
          dir,
          state,
          openedAt: "2026-01-01",
          closedAt: state === "activa" ? null : "2026-01-02",
          spec: null,
        },
      ],
    }),
  );
  return join("specs", "_master", dir, "context", "raw", ".gitignore");
}

function writeDeliveryIndex(cwd: string): void {
  writeIndex(cwd, "activa");
  writeFileSync(
    join(cwd, "specs", "_master", "index.json"),
    JSON.stringify({
      version: 2,
      stages: [
        {
          number: 1,
          slug: "bootstrap",
          dir: "01-bootstrap",
          state: "activa",
          openedAt: "2026-01-01",
          closedAt: null,
          spec: null,
          workflow: "deliveries",
        },
      ],
    }),
  );
  writeFileSync(
    join(cwd, "specs", "_master", "01-bootstrap", "context", "raw", ".gitignore"),
    "*\n!.gitignore\n",
  );
}

function doctor(
  cwd: string,
  json = true,
): { status: number; report: DoctorReport; output: string } {
  const args = ["doctor", ...(json ? ["--json"] : []), "--cwd", cwd];
  const result = spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  return {
    status: result.status ?? -1,
    report: json ? (JSON.parse(result.stdout) as DoctorReport) : { masterPlan: [] },
    output: `${result.stdout}${result.stderr}`,
  };
}

beforeAll(() => {
  if (!existsSync(CLI)) throw new Error("CLI not built; run bun run build before this test");
});

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

describe("doctor master-plan diagnostics", () => {
  it("shows deliveries readiness and corrupt state in both JSON and human output", () => {
    const cwd = repo(true);
    writeDeliveryIndex(cwd);
    const statePath = join(cwd, "specs", "_master", "01-bootstrap", "state.json");
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 2,
        workflow: "deliveries",
        phase: "context",
        mode: null,
        signal: {
          commits: null,
          firstCommit: null,
          filesChangedSinceFirst: null,
          framework: null,
          libraries: [],
          suggested: "template",
        },
        history: [],
      }),
    );
    expect(doctor(cwd).report.masterPlan).toContainEqual({
      kind: "deliveries-pending",
      detail: expect.stringContaining("not ready"),
    });
    expect(doctor(cwd, false).output).toContain("not ready for delivery");
    writeFileSync(statePath, "{}");
    expect(doctor(cwd).report.masterPlan).toContainEqual({
      kind: "invalid-state",
      detail: expect.stringContaining("01-bootstrap"),
    });
    expect(doctor(cwd, false).output).toContain("_master/state.json");
  });
  // Covers: R4, R49, R50
  it("scans every registry state directly for coverage", () => {
    const invalid = repo();
    mkdirSync(join(invalid, "specs", "_master"), { recursive: true });
    writeFileSync(join(invalid, "specs", "_master", "index.json"), "not json");
    expect(scanMasterPlan(invalid, config())).toMatchObject([{ kind: "invalid-index" }]);

    const activeMissing = repo(true);
    const activePath = writeIndex(activeMissing, "activa");
    expect(scanMasterPlan(activeMissing, config(true))).toContainEqual({
      kind: "missing-raw-gitignore",
      path: activePath,
      repair: "init",
    });

    const closedMissing = repo();
    const closedPath = writeIndex(closedMissing, "cerrada");
    expect(scanMasterPlan(closedMissing, config())).toContainEqual({
      kind: "missing-raw-gitignore",
      path: closedPath,
      repair: "checkout",
    });

    const flagEnabled = repo(true);
    writeIndex(flagEnabled, "cerrada");
    writeFileSync(
      join(flagEnabled, "specs", "_master", "01-bootstrap", "context", "raw", ".gitignore"),
      "*\n!.gitignore\n",
    );
    expect(scanMasterPlan(flagEnabled, config(true))).toContainEqual({
      kind: "flag-registry-desync",
      repair: "close",
    });

    const flagDisabled = repo();
    writeIndex(flagDisabled, "activa");
    writeFileSync(
      join(flagDisabled, "specs", "_master", "01-bootstrap", "context", "raw", ".gitignore"),
      "*\n!.gitignore\n",
    );
    expect(scanMasterPlan(flagDisabled, config())).toContainEqual({
      kind: "flag-registry-desync",
      repair: "init",
    });

    const absent = repo();
    expect(scanMasterPlan(absent, config())).toEqual([]);
  });

  // Covers: R4, R49, R50
  it("warns about an invalid registry without exiting 2", () => {
    const cwd = repo();
    mkdirSync(join(cwd, "specs", "_master"), { recursive: true });
    writeFileSync(join(cwd, "specs", "_master", "index.json"), "not json");

    const result = doctor(cwd);
    expect(result.status).toBe(0);
    expect(result.report.masterPlan).toMatchObject([{ kind: "invalid-index" }]);
    expect(doctor(cwd, false).output).toContain("index.json inválido");
  });

  // Covers: R4, R49, R50
  it("warns with init when an active stage lacks raw/.gitignore", () => {
    const cwd = repo(true);
    const path = writeIndex(cwd, "activa");

    const result = doctor(cwd);
    expect(result.status).toBe(0);
    expect(result.report.masterPlan).toContainEqual({
      kind: "missing-raw-gitignore",
      path,
      repair: "init",
    });
    expect(doctor(cwd, false).output).toContain("navori master init");
  });

  // Covers: R4, R49, R50
  it("warns with git checkout when a closed stage lacks raw/.gitignore", () => {
    const cwd = repo();
    const path = writeIndex(cwd, "cerrada");

    const result = doctor(cwd);
    expect(result.status).toBe(0);
    expect(result.report.masterPlan).toContainEqual({
      kind: "missing-raw-gitignore",
      path,
      repair: "checkout",
    });
    expect(doctor(cwd, false).output).toContain(`git checkout -- ${path}`);
  });

  // Covers: R4, R49, R50
  it("warns with close when the flag is enabled without an active stage", () => {
    const cwd = repo(true);
    writeIndex(cwd, "cerrada");
    writeFileSync(
      join(cwd, "specs", "_master", "01-bootstrap", "context", "raw", ".gitignore"),
      "*\n!.gitignore\n",
    );

    const result = doctor(cwd);
    expect(result.status).toBe(0);
    expect(result.report.masterPlan).toContainEqual({
      kind: "flag-registry-desync",
      repair: "close",
    });
    expect(doctor(cwd, false).output).toContain("navori master close");
  });

  // Covers: R4, R49, R50
  it("warns with init when an active stage has its flag disabled", () => {
    const cwd = repo();
    writeIndex(cwd, "activa");
    writeFileSync(
      join(cwd, "specs", "_master", "01-bootstrap", "context", "raw", ".gitignore"),
      "*\n!.gitignore\n",
    );

    const result = doctor(cwd);
    expect(result.status).toBe(0);
    expect(result.report.masterPlan).toContainEqual({
      kind: "flag-registry-desync",
      repair: "init",
    });
    expect(doctor(cwd, false).output).toContain("navori master init");
  });

  // Covers: R4, R49, R50
  it("has no row for a coherent registry or a repo without _master", () => {
    const coherent = repo(true);
    writeIndex(coherent, "activa");
    writeFileSync(
      join(coherent, "specs", "_master", "01-bootstrap", "context", "raw", ".gitignore"),
      "*\n!.gitignore\n",
    );
    writeFileSync(
      join(coherent, "specs", "_master", "01-bootstrap", "state.json"),
      JSON.stringify({
        version: 1,
        phase: "context",
        mode: null,
        signal: {
          commits: null,
          firstCommit: null,
          filesChangedSinceFirst: null,
          framework: null,
          libraries: [],
          suggested: "template",
        },
        history: [],
      }),
    );
    expect(doctor(coherent)).toMatchObject({
      status: 0,
      report: { masterPlan: [] },
    });

    const absent = repo();
    expect(doctor(absent)).toMatchObject({ status: 0, report: { masterPlan: [] } });
  });
});
