import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, git, mkTemp } from "../../__tests__/helpers/tmp-git.ts";
import { hasPlan, runPlanCheck, runPlanStatus } from "../report.ts";

const PLAN = `# Plan: Demo

## Objetivo

Un socio ficticio usa la app.

## Aceptación

- Entorno: qa — https://qa.example.test
- Rama de aceptación: qa
- Rama destino: dev

## Slices

| ID | Actor → resultado | Spec |
|---|---|---|
| S1 | Socio → se registra | specs/s1/spec.md |
| S2 | Socio → ve su historial | specs/s2/spec.md |
`;

let repo: string;

beforeEach(() => {
  const origin = mkTemp("mp-origin-");
  git(origin, "init", "-q", "--bare", "-b", "main");
  repo = mkTemp("mp-repo-");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  for (const b of ["main", "qa", "dev"]) git(repo, "push", "-q", "origin", `HEAD:${b}`);
  mkdirSync(join(repo, "specs", "_plan"), { recursive: true });
  mkdirSync(join(repo, "specs", "s1"), { recursive: true });
  writeFileSync(join(repo, "specs", "_plan", "PLAN.md"), PLAN);
  writeFileSync(
    join(repo, "specs", "s1", "spec.md"),
    "# S1\n\n## Guion de aceptación\n\n1. Entra.\n",
  );
  git(repo, "checkout", "-q", "-b", "qa");
  git(repo, "commit", "-q", "--allow-empty", "-m", "[S1] registro");
  git(repo, "commit", "-q", "--allow-empty", "-m", "[S2] historial");
  git(repo, "push", "-q", "origin", "qa");
});
afterEach(cleanupTempDirs);

describe("hasPlan", () => {
  it("is true only when PLAN.md exists", () => {
    expect(hasPlan(repo)).toBe(true);
    expect(hasPlan(mkTemp("mp-empty-"))).toBe(false);
  });
});

describe("runPlanStatus", () => {
  it("prints one line per slice with the WIP count", () => {
    const out = runPlanStatus(repo, {});
    expect(out.code).toBe(0);
    expect(out.stdout).toMatch(/WIP 2\/1: S1, S2/);
    expect(out.stdout).toMatch(/S1\s+integrado\s+Socio → se registra/);
  });

  it("lists the acceptance scripts for a QA round and warns about a slice without one", () => {
    const out = runPlanStatus(repo, { qa: true });
    expect(out.stdout).toMatch(/https:\/\/qa\.example\.test/);
    expect(out.stdout).toMatch(/S1.*specs\/s1\/spec\.md/);
    expect(out.stderr).toMatch(/S2 sin guion/);
  });

  it("--line is one local line with the counts, open rejection tasks and no fetch", () => {
    git(repo, "remote", "set-url", "origin", join(repo, "no-such-remote"));
    const out = runPlanStatus(repo, { line: true, fetch: true });
    expect(out.code).toBe(0);
    expect(out.stderr).toBe("");
    expect(out.stdout).toMatch(/^Plan maestro — estado local, sin fetch: 2 integrado\. Detalle/);
    expect(out.stdout.trim()).not.toContain("\n");
    expect(runPlanStatus(repo, { line: true, lang: "en" }).stdout).toMatch(/^Master plan — local/);
  });

  it("--line counts rejection notes as tasks and handles an empty index", () => {
    const mark = (n: number): void => {
      git(repo, "checkout", "-q", "--orphan", "navori/acceptance");
      writeFileSync(
        join(repo, "acceptance.jsonl"),
        `${JSON.stringify({ id: "S2", verdict: "rejected", at: "2026-01-01T00:00:00Z", env: "qa", commit: git(repo, "rev-parse", "qa").trim(), by: "user", notes: Array.from({ length: n }, (_, i) => `n${i}`) })}\n`,
      );
      git(repo, "add", "acceptance.jsonl");
      git(repo, "commit", "-q", "-m", "log");
      git(repo, "checkout", "-q", "qa");
    };
    mark(2);
    const out = runPlanStatus(repo, { line: true });
    expect(out.stdout).toMatch(
      /1 integrado · 1 en curso; 2 tarea\(s\) abierta\(s\) de rechazo \(S2\)/,
    );
    writeFileSync(join(repo, "specs", "_plan", "PLAN.md"), "# Plan: x\n\n## Slices\n\n");
    expect(runPlanStatus(repo, { line: true }).stdout).toMatch(/sin fetch: índice vacío/);
  });

  it("prints JSON and the detail of one slice", () => {
    expect(JSON.parse(runPlanStatus(repo, { json: true }).stdout).counted).toEqual(["S1", "S2"]);
    expect(runPlanStatus(repo, { id: "S9" }).code).toBe(1);
  });
});

describe("runPlanCheck", () => {
  it("fails on plan errors and on a WIP breach, and passes otherwise", () => {
    const plain = runPlanCheck(repo, {});
    expect(plain.code).toBe(0);
    expect(plain.stderr).toMatch(/2 integrados sin aceptar \(WIP 1\)/);
    git(repo, "checkout", "-q", "-b", "slice/S3-cupon", "origin/dev");
    git(repo, "commit", "-q", "--allow-empty", "-m", "[S3] cupón");
    const blocked = runPlanCheck(repo, { incoming: "HEAD" });
    expect(blocked.code).toBe(1);
    expect(blocked.stderr).toMatch(/S3.*S1, S2 sin aceptar \(WIP 1\)/);
    writeFileSync(
      join(repo, "specs", "_plan", "PLAN.md"),
      PLAN.replace("- Rama destino: dev\n", ""),
    );
    expect(runPlanCheck(repo, {}).stderr).toMatch(/Rama destino/);
  });
});
