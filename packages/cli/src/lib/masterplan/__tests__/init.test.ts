import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, mkTemp } from "../../__tests__/helpers/tmp-git.ts";
import { writeConfig } from "../../config/config.ts";
import { runPlanInit } from "../init.ts";
import { checkPlan, parsePlan } from "../plan.ts";
import { hasPlan } from "../report.ts";

afterEach(cleanupTempDirs);

const render = (): { ok: boolean } => ({ ok: true });

/** A repo with a canonical config (what `writeConfig` produces). */
function repoWith(extra: Record<string, unknown> = {}): string {
  const cwd = mkTemp("mp-init-");
  writeConfig(join(cwd, "navori.config.json"), {
    name: "demo",
    engines: ["claude"],
    preset: "custom",
    version: "1.0.0",
    language: "es",
    branchBase: "dev",
    commits: "conventional-es",
    ...extra,
  } as Parameters<typeof writeConfig>[1]);
  return cwd;
}

const configOf = (cwd: string): string => readFileSync(join(cwd, "navori.config.json"), "utf8");
const planOf = (cwd: string): string => readFileSync(join(cwd, "specs/_plan/PLAN.md"), "utf8");

describe("runPlanInit", () => {
  it("creates an empty PLAN.md, turns the flag on and renders; check fails only on the index", () => {
    const cwd = repoWith();
    let rendered = 0;
    const out = runPlanInit(cwd, "demo", {
      render: () => {
        rendered += 1;
        return { ok: true };
      },
    });
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("specs/_plan/PLAN.md");
    expect(hasPlan(cwd)).toBe(true);
    expect(planOf(cwd)).toMatch(/^# Plan: demo\n/);
    expect(parsePlan(planOf(cwd)).acceptance.target).toBe("dev");
    expect(rendered).toBe(1);
    expect(JSON.parse(configOf(cwd)).harness).toEqual({ masterPlan: true });
    expect(configOf(cwd)).toBe(`${JSON.stringify(JSON.parse(configOf(cwd)), null, 2)}\n`);
    expect(checkPlan(planOf(cwd)).map((f) => f.message)).toEqual(["Slices: índice vacío"]);
  });

  it("never overwrites an existing plan: it prints the status instead", () => {
    const cwd = repoWith();
    runPlanInit(cwd, "demo", { render });
    const edited = planOf(cwd).replace("# Plan: demo", "# Plan: demo\n\nmine");
    writeFileSync(join(cwd, "specs/_plan/PLAN.md"), edited);
    const out = runPlanInit(cwd, "other", { render });
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("ya existe");
    expect(planOf(cwd)).toBe(edited);
  });

  it("writes the English template for an English config", () => {
    const cwd = repoWith({ language: "en" });
    runPlanInit(cwd, "demo", { render });
    expect(planOf(cwd)).toContain("## Goal");
    expect(parsePlan(planOf(cwd)).acceptance.branch).toBe("qa");
    expect(checkPlan(planOf(cwd)).map((f) => f.message)).toEqual(["Slices: índice vacío"]);
  });

  it("leaves a hand-formatted config byte-identical, prints the exact edit and fails", () => {
    const cwd = repoWith();
    const handFormatted = `${JSON.stringify(JSON.parse(configOf(cwd)))}\n`;
    writeFileSync(join(cwd, "navori.config.json"), handFormatted);
    let rendered = false;
    const out = runPlanInit(cwd, "demo", {
      render: () => {
        rendered = true;
        return { ok: true };
      },
    });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('"harness": { "masterPlan": true }');
    expect(out.stderr).toContain("navori render --apply");
    expect(out.stderr).toContain("specs/_plan/PLAN.md ya está creado");
    expect(configOf(cwd)).toBe(handFormatted);
    expect(rendered).toBe(false);
    // The plan exists now, so a re-run re-reports the flag instead of staying silent.
    expect(runPlanInit(cwd, "demo", { render }).code).toBe(1);
    expect(configOf(cwd)).toBe(handFormatted);
  });

  it("fails visibly on a missing config, a bad slug and a missing slug", () => {
    const empty = mkTemp("mp-init-empty-");
    const missing = runPlanInit(empty, "demo", { render });
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("navori.config.json");
    expect(existsSync(join(empty, "specs"))).toBe(false);
    const cwd = repoWith();
    expect(runPlanInit(cwd, "Bad Slug", { render }).stderr).toContain("kebab-case");
    expect(runPlanInit(cwd, undefined, { render }).stderr).toContain("slug");
    expect(hasPlan(cwd)).toBe(false);
  });

  it("fails when the render fails", () => {
    const out = runPlanInit(repoWith(), "demo", { render: () => ({ ok: false, reason: "boom" }) });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("boom");
  });
});
