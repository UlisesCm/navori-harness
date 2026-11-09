import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contractDigest } from "../../master/delivery-checks.ts";
import type { DeliveryParts } from "../../master/delivery-schema.ts";
import { cleanupTempDirs, git, mkTemp } from "../../__tests__/helpers/tmp-git.ts";
import { runPlanMigrate } from "../migrate.ts";
import { canonicalSliceId, checkPlan } from "../plan.ts";
import { runPlanStatus } from "../report.ts";
import { checkIncoming, marksOf, readPlanState } from "../state.ts";

const BRANCHES = ["slice/s01-cuenta", "slice/s02-historial", "slice/s03-cupon"];
const render = (): { ok: boolean } => ({ ok: true });
let repo: string;

/** A valid v1 deliveries `parts.json` with one delivery per branch. */
function partsJson(branches: string[]): string {
  const parts: DeliveryParts = {
    version: 2,
    workflow: "deliveries",
    revision: 1,
    digest: "0".repeat(64),
    sources: [
      {
        id: "source",
        path: "source.txt",
        digest: createHash("sha256").update("RN-1").digest("hex"),
        locator: "RN-1",
        requirements: ["RN-1"],
        uiBearing: false,
      },
    ],
    requirements: [{ id: "RN-1", sourceId: "source", disposition: "in-scope", reason: null }],
    design: { ui: "none", reason: "CLI only" },
    deliveries: branches.map((branch, i) => ({
      id: `E${i + 1}`,
      title: `Entrega ${i + 1}`,
      outcome: i === 2 ? "Entrega sin actor" : `Socio → resultado ${i + 1}`,
      partIds: [`P${i + 1}`],
      dependsOn: [],
      git: { branch, base: "dev", integrationTarget: "dev", prTarget: "dev" },
    })),
    parts: branches.map((_, i) => ({
      id: `P${i + 1}`,
      deliveryId: `E${i + 1}`,
      title: `Parte ${i + 1}`,
      objective: "Objetivo",
      scope: ["x"],
      outOfScope: [],
      dependsOn: [],
      sourceIds: ["source"],
      requirementIds: ["RN-1"],
      spec: i === 0 ? "specs/01-cuenta" : null,
      foundation: false,
      acceptance: [
        { id: "A1", method: "command", description: "ok", command: "true", expected: "exit 0" },
      ],
      questions: [],
    })),
  };
  parts.digest = contractDigest(parts);
  return JSON.stringify(parts);
}

/** Branches `name` off dev with a commit and merges it into qa the way GitHub does. */
function mergeToQa(n: number, name: string): void {
  git(repo, "checkout", "-q", "-B", name, "origin/dev");
  git(repo, "commit", "-q", "--allow-empty", "-m", `feat: ${name}`);
  git(repo, "push", "-q", "-f", "origin", name);
  git(repo, "checkout", "-q", "-B", "qa", "origin/qa");
  git(repo, "merge", "-q", "--no-ff", "-m", `Merge pull request #${n} from u/${name}`, name);
  git(repo, "push", "-q", "origin", "qa");
}

function stage(branches: string[]): void {
  const dir = join(repo, "specs", "_master", "02-mvp");
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(repo, "specs", "01-cuenta"), { recursive: true });
  writeFileSync(
    join(repo, "specs", "01-cuenta", "spec.md"),
    "# Cuenta\n\n## Guion de aceptación\n\n1. Abre\n",
  );
  writeFileSync(join(dir, "parts.json"), partsJson(branches));
  writeFileSync(
    join(repo, "specs", "_master", "index.json"),
    JSON.stringify({
      version: 2,
      stages: [
        {
          number: 2,
          slug: "mvp",
          dir: "02-mvp",
          state: "activa",
          openedAt: "2026-01-01",
          closedAt: null,
          spec: null,
          workflow: "deliveries",
        },
      ],
    }),
  );
}

beforeEach(() => {
  const origin = mkTemp("mg-origin-");
  git(origin, "init", "-q", "--bare", "-b", "main");
  repo = mkTemp("mg-repo-");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "remote", "add", "origin", origin);
  writeFileSync(
    join(repo, "navori.config.json"),
    `${JSON.stringify({ name: "demo", engines: ["claude"], preset: "custom", branchBase: "dev" }, null, 2)}\n`,
  );
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "push", "-q", "origin", "main");
  for (const b of ["dev", "qa"]) {
    git(repo, "branch", "-f", b, "main");
    git(repo, "push", "-q", "-f", "origin", b);
  }
  stage(BRANCHES);
  BRANCHES.forEach((b, i) => mergeToQa(i + 1, b));
});
afterEach(cleanupTempDirs);

const planFile = (): string => join(repo, "specs", "_plan", "PLAN.md");

describe("runPlanMigrate", () => {
  it("--write turns three merged deliveries into S1-S3 integrado, keeping their numbers", () => {
    const out = runPlanMigrate(repo, { write: true, render });
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("E2 → S2 (rama slice/s02-historial)");
    expect(readFileSync(planFile(), "utf8")).toContain("| S2 | Socio → resultado 2 |");
    expect(JSON.parse(readFileSync(join(repo, "navori.config.json"), "utf8")).harness).toEqual({
      masterPlan: true,
    });
    const state = readPlanState(repo, { fetch: false });
    expect(state.slices.map((s) => `${s.id}:${s.state}`)).toEqual([
      "S1:integrado",
      "S2:integrado",
      "S3:integrado",
    ]);
    expect(state.warnings.filter((w) => w.includes("huérfana"))).toEqual([]);
    expect(out.stderr).toContain("S3: sin");
  });

  it("an unmerged slice/s02 branch that is not E2's becomes S4 with a rename notice", () => {
    git(repo, "checkout", "-q", "-B", "slice/s02-entrega-2-wip", "origin/dev");
    git(repo, "commit", "-q", "--allow-empty", "-m", "wip");
    git(repo, "push", "-q", "origin", "slice/s02-entrega-2-wip");
    git(repo, "checkout", "-q", "-B", "slice/s03-otro", "origin/dev");
    git(repo, "commit", "-q", "--allow-empty", "-m", "[S3] sigue siendo S3");
    git(repo, "push", "-q", "origin", "slice/s03-otro");
    const out = runPlanMigrate(repo);
    expect(out.stdout).toContain("slice/s02-entrega-2-wip → S4");
    expect(out.stdout).not.toContain("slice/s03-otro");
    expect(out.stderr).toContain("renombra la rama a slice/s04-entrega-2-wip antes del PR");
  });

  it("dry-run writes nothing; never touches navori/acceptance; keeps an existing PLAN.md", () => {
    const out = runPlanMigrate(repo);
    expect(out.stdout).toContain("| S1 |");
    expect(existsSync(planFile())).toBe(false);
    expect(runPlanMigrate(repo, { write: true, render }).code).toBe(0);
    const before = readFileSync(planFile(), "utf8");
    const again = runPlanMigrate(repo, { write: true, render });
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("ya existe");
    expect(readFileSync(planFile(), "utf8")).toBe(before);
    expect(git(repo, "branch", "-a", "--list", "*navori/acceptance*")).toBe("");
  });

  it("fails before writing when two deliveries land on the same ID", () => {
    stage(["slice/s01-a", "slice/S1-b", "slice/s03-c"]);
    const out = runPlanMigrate(repo, { write: true, render });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("S1 duplicado");
    expect(existsSync(planFile())).toBe(false);
  });

  it("a stage that is already closed is not migrated", () => {
    const file = join(repo, "specs", "_master", "index.json");
    writeFileSync(
      file,
      readFileSync(file, "utf8")
        .replace('"activa"', '"cerrada"')
        .replace('"closedAt":null', '"closedAt":"2026-02-01"'),
    );
    expect(runPlanMigrate(repo, { stage: 2 }).stderr).toContain("cerrada");
  });
});

describe("canonical slice IDs", () => {
  it("S01, [s1] and Slice: S1 are the same slice", () => {
    expect(canonicalSliceId("S01")).toBe("S1");
    expect(marksOf("feat: x\n\nSlice: S01")).toEqual(["S1"]);
    expect(marksOf("[s1] x")).toEqual(["S1"]);
    expect(marksOf("Merge pull request #1 from u/slice/s01-cuenta")).toEqual(["S1"]);
  });

  it("a [S01] title passes the WIP title rule on a slice/s01- branch; a bare title does not", () => {
    runPlanMigrate(repo, { write: true, render });
    git(repo, "checkout", "-q", "-B", "dev", "origin/dev");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "plan");
    git(repo, "push", "-q", "origin", "dev");
    const check = (title: string) =>
      checkIncoming(repo, "HEAD", "dev", { fetch: false, branch: "slice/s01-cuenta", title });
    expect(check("[S01] cuenta").ok).toBe(true);
    expect(check("cuenta")).toMatchObject({ ok: false, titleMissing: "S1" });
  });

  it("reports a mark outside PLAN.md as an orphan mark", () => {
    runPlanMigrate(repo, { write: true, render });
    git(repo, "checkout", "-q", "-B", "qa", "origin/qa");
    git(repo, "commit", "-q", "--allow-empty", "-m", "[S9] extra");
    git(repo, "push", "-q", "origin", "qa");
    const out = runPlanStatus(repo, { fetch: false });
    expect(out.stderr).toContain("S9: marca huérfana");
  });

  it("hasScript reads spec.md inside a directory spec (no EISDIR)", () => {
    runPlanMigrate(repo, { write: true, render });
    const out = runPlanStatus(repo, { qa: true, fetch: false });
    expect(out.code).toBe(0);
    expect(out.stderr).not.toContain("S1 sin guion");
    expect(out.stderr).toContain("S2 sin guion");
  });
});

describe("data-driven git arguments", () => {
  const CLI = fileURLToPath(new URL("../../../index.ts", import.meta.url));

  /** A legacy stage whose single part carries `commit` as run evidence. */
  function legacyStage(commit: string): void {
    const evidence = { kind: "run", command: "true", result: "ok", commit, date: "2026-01-01" };
    const criterion = {
      id: "A1",
      description: "ok",
      method: "comando",
      command: { run: "true", expected: "0" },
      evidence,
    };
    const part = { id: "P1", title: "Parte", objective: "Socio → algo", state: "hecho" };
    writeFileSync(
      join(repo, "specs", "_master", "02-mvp", "parts.json"),
      JSON.stringify({ version: 1, parts: [{ ...part, acceptance: [criterion] }] }),
    );
    const file = join(repo, "specs", "_master", "index.json");
    writeFileSync(file, readFileSync(file, "utf8").replace(',"workflow":"deliveries"', ""));
  }

  it("a legacy evidence commit that looks like an option writes no file and warns", () => {
    const pwned = join(repo, "pwned");
    legacyStage(`--output=${pwned}`);
    const out = runPlanMigrate(repo);
    expect(existsSync(pwned)).toBe(false);
    expect(out.stderr).toContain("no es un SHA");
  });

  it("a legacy commit with several marks warns instead of taking the first silently", () => {
    git(repo, "commit", "-q", "--allow-empty", "-m", "[S5] [S6] dos");
    legacyStage(git(repo, "rev-parse", "HEAD").trim());
    expect(runPlanMigrate(repo).stderr).toContain("varias marcas (S5, S6)");
  });

  it("a Commit column that looks like an option is a check error and runs no git", () => {
    runPlanMigrate(repo, { write: true, render });
    const pwned = join(repo, "pwned");
    const text = readFileSync(planFile(), "utf8").replace(
      "| S1 | Socio → resultado 1 | specs/01-cuenta | |",
      `| S1 | Socio → resultado 1 | specs/01-cuenta | --output=${pwned} |`,
    );
    const errors = checkPlan(text).map((f) => f.message);
    expect(errors).toContain("S1: el Commit debe ser un SHA hexadecimal");
    writeFileSync(planFile(), text);
    expect(() => readPlanState(repo, { fetch: false })).toThrow("no es un SHA");
    expect(existsSync(pwned)).toBe(false);
  });

  it("slice/s00- is not S0: it takes the next free number", () => {
    stage(["slice/s00-a", "slice/s02-b", "slice/s03-c"]);
    const out = runPlanMigrate(repo);
    expect(out.stdout).toContain("E1 → S4");
    expect(out.stderr).toContain("S0, que no existe");
    expect(marksOf("[S0] x")).toEqual([]);
  });

  it("a non-numeric --stage fails instead of using the active stage", () => {
    const run = spawnSync("bun", [CLI, "master", "migrate", "--stage", "abc", "--cwd", repo], {
      encoding: "utf8",
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("--stage debe ser");
  });
});
