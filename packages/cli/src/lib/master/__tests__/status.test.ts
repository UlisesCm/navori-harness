// Covers: R31, R36, R40, R44, R46, R47, R54, R61
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createSeedConfigHelper } from "./test-utils.ts";
import {
  readMasterStatus,
  renderMasterParts,
  renderStatusMd,
  statusLine,
  writeMasterStatus,
} from "../status.ts";
import { runMasterCheck } from "../checks.ts";

let cwd: string;
const part = (state: string, evidence: unknown = null) => ({
  id: "P1",
  title: "Title\nwith control",
  objective: "Build",
  scope: [],
  outOfScope: [],
  dependsOn: [],
  seedRequirements: [],
  acceptance: [
    {
      id: "A1",
      description: "Works",
      method: "manual",
      manual: { check: "review", how: "inspect" },
      evidence,
    },
  ],
  inheritedFrom: null,
  state,
  reason: state === "diferida" ? "later" : null,
  spec: null,
  issue: null,
});

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-master-status-"));
  execFileSync("git", ["init", "-q"], { cwd });
  createSeedConfigHelper(cwd)({ harness: { masterPlan: true } });
  const base = join(cwd, "specs", "_master");
  mkdirSync(join(base, "01-mvp"), { recursive: true });
  writeFileSync(
    join(base, "index.json"),
    JSON.stringify({
      version: 1,
      stages: [
        {
          number: 1,
          slug: "mvp",
          dir: "01-mvp",
          state: "activa",
          openedAt: "2026-01-01",
          closedAt: null,
          spec: null,
        },
      ],
    }),
  );
  writeFileSync(
    join(base, "01-mvp", "state.json"),
    JSON.stringify({
      version: 1,
      phase: "executing",
      mode: "template",
      signal: {
        commits: null,
        firstCommit: null,
        filesChangedSinceFirst: null,
        framework: null,
        libraries: [],
        suggested: "template",
      },
      outcome: null,
      history: [],
    }),
  );
  writeFileSync(
    join(base, "01-mvp", "parts.json"),
    JSON.stringify({ version: 1, parts: [part("hecho")] }),
  );
  writeFileSync(
    join(base, "01-mvp", "MASTER.md"),
    "# Master\n\n## Entrega en partes\n\nPending\n\n## Preguntas abiertas\n\nNinguna\n",
  );
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe("master status", () => {
  // Covers: R31, R36, R40, R47, R61
  it("downgrades unevidenced done and renders identical bytes twice", () => {
    const first = writeMasterStatus(cwd);
    expect(first.parts[0]?.effective).toBe("parcial");
    expect(first.blockers).toContain("P1.A1: sin evidencia");
    expect(first.closable).toBe(false);
    const path = join(cwd, "specs/_master/01-mvp/STATUS.md");
    const bytes = readFileSync(path, "utf8");
    writeMasterStatus(cwd);
    expect(readFileSync(path, "utf8")).toBe(bytes);
    expect(bytes).toContain("01-mvp");
    expect(readFileSync(join(cwd, "specs/_master/01-mvp/MASTER.md"), "utf8")).toContain(
      "navori:master-parts hash=",
    );
    expect(runMasterCheck(cwd).failures).not.toContain("01-mvp/STATUS.md differs from its render");
    writeFileSync(path, `${bytes}tampered`);
    expect(runMasterCheck(cwd).failures).toContain("01-mvp/STATUS.md differs from its render");
  });

  // Covers: R44, R46, R54
  it("reports active part and sanitizes the line title", () => {
    const status = readMasterStatus(cwd);
    expect(status.activePart).toBe("P1");
    expect(statusLine(status, "specs")).toContain('P1 "Title with control"');
    expect(statusLine(status, "specs")).not.toContain("\n");
    expect(renderStatusMd(status)).toContain("Discrepancias");
  });

  // Covers: R31, R40, R47
  it("keeps deferred dispositions final and reports allDone separately", () => {
    writeFileSync(
      join(cwd, "specs/_master/01-mvp/parts.json"),
      JSON.stringify({ version: 1, parts: [part("diferida")] }),
    );
    const status = readMasterStatus(cwd);
    expect(status.parts[0]?.effective).toBe("diferida");
    expect(status.allDone).toBe(false);
    expect(status.closable).toBe(true);
  });

  // Covers: R31, R40, R61
  it("derives a linked part from task checkboxes and criterion evidence", () => {
    const spec = join(cwd, "specs/demo");
    mkdirSync(spec);
    writeFileSync(join(spec, "tasks.md"), "- [x] first\n- [x] second\n");
    const linked = { ...part("pendiente"), spec: "specs/demo" };
    writeFileSync(
      join(cwd, "specs/_master/01-mvp/parts.json"),
      JSON.stringify({ version: 1, parts: [linked] }),
    );
    expect(readMasterStatus(cwd).parts[0]).toMatchObject({
      effective: "parcial",
      tasksDone: 2,
      tasksTotal: 2,
    });
    expect(readMasterStatus(cwd).blockers).toContain("P1.A1: sin evidencia");
  });

  // Covers: R31, R54
  it("renders a stable master-parts hash", () => {
    const parts = JSON.parse(
      readFileSync(join(cwd, "specs/_master/01-mvp/parts.json"), "utf8"),
    ).parts;
    expect(renderMasterParts(parts, "template")).toBe(renderMasterParts(parts, "template"));
  });

  // Covers: R47, R54, R61
  it("does not let orphan evidence block closure", () => {
    const input = part("hecho") as ReturnType<typeof part>;
    input.acceptance = [
      {
        id: "A1",
        description: "Works",
        method: "manual",
        manual: { check: "review", how: "inspect" },
        evidence: { kind: "approval", approvedBy: "user", date: "2026-01-01" },
      },
    ];
    writeFileSync(
      join(cwd, "specs/_master/01-mvp/parts.json"),
      JSON.stringify({ version: 1, parts: [input] }),
    );
    expect(readMasterStatus(cwd).closable).toBe(true);
    expect(readMasterStatus(cwd).allDone).toBe(true);
  });

  // Covers: R46, R54
  it("returns null stage after closure and rejects an absent index", () => {
    const path = join(cwd, "specs/_master/index.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        stages: [
          {
            number: 1,
            slug: "mvp",
            dir: "01-mvp",
            state: "cerrada",
            openedAt: "2026-01-01",
            closedAt: "2026-01-02",
            spec: null,
          },
        ],
      }),
    );
    expect(readMasterStatus(cwd).stage).toBeNull();
    rmSync(path);
    expect(() => readMasterStatus(cwd)).toThrow("no index.json");
  });

  // Covers: R36, R54
  it("refuses a derived STATUS.md symlink outside the repository", () => {
    const outside = mkdtempSync(join(tmpdir(), "navori-master-escape-"));
    try {
      const external = join(outside, "external.md");
      writeFileSync(external, "untouched");
      symlinkSync(external, join(cwd, "specs/_master/01-mvp/STATUS.md"));
      expect(() => writeMasterStatus(cwd)).toThrow("outside repository");
      expect(readFileSync(external, "utf8")).toBe("untouched");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
