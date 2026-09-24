import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { renderClaudeEngine } from "../engines/claude/index.ts";
import type { NavoriConfig } from "../lib/config/config.ts";
import {
  simulateContextDelivery,
  SESSION_CONTEXT_DELIVERY_BUDGET_CHARS,
  type ContextDeliveryFile,
} from "../lib/assets/doc-budgets.ts";

/**
 * Spec 0032 (#1011) — `harness.planTiers` flips the `planificacion` managed
 * block on and swaps the "architectural pass" paragraph out of `orquestacion`.
 *
 * Covers: R6, R7, R8, R18, R22
 */

const CONFIG_BASE = {
  name: "plan-tiers-demo",
  engines: ["claude"],
  preset: "custom",
  version: "1.0.0",
  language: "es",
  branchBase: "main",
  commits: "conventional-es",
} as unknown as NavoriConfig;

const CONTEXT_DIR = ".claude/context";

const dirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "navori-plan-tiers-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Every `.claude/context/*.md` file, sorted the way the SessionStart hook
 * globs them — alphabetical, which the numeric prefix turns into delivery
 * order (`engines/claude/index.ts`, `ORCHESTRATOR_CONTEXT_ORDER`). */
function contextFiles(cwd: string): ContextDeliveryFile[] {
  const dir = join(cwd, CONTEXT_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => {
      const content = readFileSync(join(dir, f), "utf-8");
      return { path: `${CONTEXT_DIR}/${f}`, chars: content.length };
    });
}

describe("harness.planTiers off (default) — R30 byte-for-byte", () => {
  it("renders no planificacion context file, and orquestacion keeps the architect paragraph", () => {
    const cwd = freshDir();
    renderClaudeEngine(cwd, CONFIG_BASE);
    expect(existsSync(join(cwd, CONTEXT_DIR, "05-planificacion.md"))).toBe(false);
    const orquestacion = readFileSync(join(cwd, CONTEXT_DIR, "10-orquestacion.md"), "utf-8");
    expect(orquestacion).toContain("`architect` applies `solution-design` and writes");
  });
});

describe("harness.planTiers on — R6, R8, R22: the block reaches the injected context", () => {
  function configWithTiers(): NavoriConfig {
    return { ...CONFIG_BASE, harness: { planTiers: true } } as unknown as NavoriConfig;
  }

  it("writes 05-planificacion.md ahead of 10-orquestacion.md, and drops the architectural paragraph there", () => {
    const cwd = freshDir();
    renderClaudeEngine(cwd, configWithTiers());
    const files = readdirSync(join(cwd, CONTEXT_DIR)).sort();
    expect(files).toContain("05-planificacion.md");
    expect(files.indexOf("05-planificacion.md")).toBeLessThan(files.indexOf("10-orquestacion.md"));

    const planificacion = readFileSync(join(cwd, CONTEXT_DIR, "05-planificacion.md"), "utf-8");
    expect(planificacion).toContain("Planning tiers");
    expect(planificacion).toMatch(/\| 0 \|.*\| 1 \|.*\| 2 \|.*\| 3 \|/s);

    const orquestacion = readFileSync(join(cwd, CONTEXT_DIR, "10-orquestacion.md"), "utf-8");
    expect(orquestacion).not.toContain("`architect` applies `solution-design`");
  });

  it("R6/R8/R22: the planificacion body is DELIVERED INLINE to the SessionStart context, not just written to disk", () => {
    const cwd = freshDir();
    renderClaudeEngine(cwd, configWithTiers());
    const files = contextFiles(cwd);
    expect(files.length).toBeGreaterThan(0);

    const delivered = simulateContextDelivery(files);
    const planificacion = delivered.find((f) => f.path.endsWith("05-planificacion.md"));
    expect(
      planificacion,
      "05-planificacion.md must be part of the delivered context set",
    ).toBeDefined();
    expect(
      planificacion!.delivered,
      "the block degraded to a pointer — it never reaches `hook_additional_context` whole",
    ).toBe("inline");
    // Sanity: the block is nowhere near the delivery budget on its own (T6's
    // 250-word ceiling is a small fraction of the 8000-char session budget).
    expect(planificacion!.chars).toBeLessThan(SESSION_CONTEXT_DELIVERY_BUDGET_CHARS);
  });
});
