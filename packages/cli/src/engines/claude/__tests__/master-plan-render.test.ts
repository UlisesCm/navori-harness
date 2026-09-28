import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderClaudeEngine } from "../index.ts";
import { simulateContextDelivery } from "../../../lib/assets/doc-budgets.ts";
import type { NavoriConfig } from "../../../lib/config/config.ts";

const base = {
  name: "master-plan-demo",
  engines: ["claude"],
  preset: "custom",
  language: "es",
  branchBase: "main",
  commits: "conventional-es",
} as unknown as NavoriConfig;

const dirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "navori-master-render-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function contextFiles(cwd: string): string[] {
  return readdirSync(join(cwd, ".claude/context"))
    .filter((file) => file.endsWith(".md"))
    .sort();
}

describe("master-plan managed context (spec 0034 T11)", () => {
  // Covers: R37, R39
  it("matches the off → on → off render golden after close disables masterPlan", () => {
    const cwd = freshDir();
    const active = { ...base, harness: { planTiers: true, masterPlan: true } } as NavoriConfig;
    const closed = { ...base, harness: { planTiers: true, masterPlan: false } } as NavoriConfig;
    const file = join(cwd, ".claude/context/07-plan-maestro.md");

    renderClaudeEngine(cwd, closed);
    const off = contextFiles(cwd);
    expect(off).not.toContain("07-plan-maestro.md");

    renderClaudeEngine(cwd, active);
    const on = contextFiles(cwd);
    expect(on).toEqual([...off, "07-plan-maestro.md"].sort());
    expect(readFileSync(file, "utf8")).toContain('id="plan-maestro"');
    expect(readFileSync(file, "utf8")).toContain("only when the user explicitly asks");
    expect(existsSync(join(cwd, "CLAUDE.md"))).toBe(true);
    expect(readFileSync(join(cwd, "CLAUDE.md"), "utf8")).not.toContain('id="plan-maestro"');

    renderClaudeEngine(cwd, closed);
    expect(contextFiles(cwd)).toEqual(off);
    expect(existsSync(file)).toBe(false);
  });

  // Covers: R37, R39
  it("delivers plan-maestro inline with planTiers and masterPlan both enabled", () => {
    const cwd = freshDir();
    renderClaudeEngine(cwd, {
      ...base,
      harness: { planTiers: true, masterPlan: true },
    } as NavoriConfig);
    const files = contextFiles(cwd);
    expect(files.indexOf("05-planificacion.md")).toBeLessThan(files.indexOf("07-plan-maestro.md"));
    expect(files.indexOf("07-plan-maestro.md")).toBeLessThan(files.indexOf("10-orquestacion.md"));
    const delivery = simulateContextDelivery(
      files.map((file) => ({
        path: file,
        chars: readFileSync(join(cwd, ".claude/context", file), "utf8").length,
      })),
    );
    expect(delivery.find((entry) => entry.path === "07-plan-maestro.md")?.delivered).toBe("inline");
  });
});
