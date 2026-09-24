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

/**
 * Spec 0032 lote 3 (#1011) — T11's contracts over the RENDERED prose: the
 * architect's method/artifact, `solution-design`'s driver-first ladder,
 * `spec-bootstrap`'s architect line, and the orchestrator's plan-tiers
 * doctrine (workplan handoffs, and R24/R25 verified on the rendered output,
 * not the raw asset, since R24 is exactly what the `planTiers` render toggle
 * changes).
 *
 * Covers: R10, R23, R24, R25, R26, R27, R28, R36, R37
 */
describe("architect/solution-design/spec-bootstrap/orchestrator — rendered plan-tiers contracts (T11)", () => {
  function render(cwd: string, planTiers: boolean): void {
    const config = planTiers
      ? ({ ...CONFIG_BASE, harness: { planTiers: true } } as unknown as NavoriConfig)
      : CONFIG_BASE;
    renderClaudeEngine(cwd, config);
  }

  it("R26/R28: architect's rendered body carries the method, the artifact sections and the level-3 design.md line, regardless of planTiers (architect always renders — R33)", () => {
    for (const planTiers of [false, true]) {
      const cwd = freshDir();
      render(cwd, planTiers);
      const architect = readFileSync(join(cwd, ".claude/agents/architect.md"), "utf-8");
      expect(architect).toContain(
        "Derive the decision drivers from the project's own rules (DIRECTION, CLAUDE.md, EXTENDING, `quality-attributes`) before you list any option.",
      );
      expect(architect).toContain(
        "Explore at least three rungs — the existing pattern, an extension, a new abstraction. A discarded rung gets one line with its evidence; a surviving one is developed in full.",
      );
      expect(architect).toContain(
        "Recommend the option that best fits the drivers, not the cheapest by default.",
      );
      expect(architect).toContain("Verify every 'already exists' claim against `origin/main`.");
      expect(architect).toContain("Decision drivers");
      expect(architect).toContain("Options");
      expect(architect).toContain("Recommendation");
      expect(architect).toContain("Durable knowledge");
      expect(architect).toContain("You propose the destination; you never write it.");
      expect(architect).toContain("specs/<feature>/design.md");
      expect(architect).toContain("spec-bootstrap");
    }
  });

  it("R25: the rendered architect never claims to write the workplan or decompose into tasks", () => {
    const cwd = freshDir();
    render(cwd, true);
    const architect = readFileSync(join(cwd, ".claude/agents/architect.md"), "utf-8");
    expect(architect).toMatch(/never decompose into (implementer )?tasks/i);
    expect(architect).not.toMatch(/writes? the workplan/i);
  });

  it("R27: solution-design's rendered Process derives decision drivers before the ladder and verifies existing claims against origin/main", () => {
    const cwd = freshDir();
    render(cwd, true);
    const solutionDesign = readFileSync(
      join(cwd, ".claude/skills/solution-design/SKILL.md"),
      "utf-8",
    ).replace(/\s+/g, " ");
    expect(solutionDesign).toContain(
      "Before any option, derive the decision drivers from the project's own rules; the ladder " +
        "`existing pattern > small extension > new abstraction > new subsystem` is one driver, not the default winner.",
    );
    expect(solutionDesign).toContain("Verify every 'already exists' claim against `origin/main`.");
  });

  it("R28: spec-bootstrap's rendered Order has the architect apply solution-design for design.md", () => {
    const cwd = freshDir();
    render(cwd, true);
    const specBootstrap = readFileSync(
      join(cwd, ".claude/skills/spec-bootstrap/SKILL.md"),
      "utf-8",
    );
    expect(specBootstrap).toContain(
      "The `architect` writes `design.md`, applying `solution-design`.",
    );
  });

  it("R23/R24: planTiers on drops the orchestrator-runs-solution-design paragraph from the rendered context, and the level-2 row routes through architect/auditor/user/verdict instead", () => {
    const off = freshDir();
    render(off, false);
    const orquestacionOff = readFileSync(join(off, CONTEXT_DIR, "10-orquestacion.md"), "utf-8");
    expect(orquestacionOff).toContain("`architect` applies `solution-design` and writes");

    const on = freshDir();
    render(on, true);
    const orquestacionOn = readFileSync(join(on, CONTEXT_DIR, "10-orquestacion.md"), "utf-8");
    // R24: the orchestrator no longer applies solution-design itself once
    // planTiers is on — that paragraph is gone from its rendered doctrine.
    expect(orquestacionOn).not.toContain("`architect` applies `solution-design`");
    const planificacion = readFileSync(join(on, CONTEXT_DIR, "05-planificacion.md"), "utf-8");
    expect(planificacion).toContain(
      "`architect` → `auditor` challenge → user picks → your verdict → level-2 workplan. Skill `plan-advanced`",
    );
  });

  it("R10/R36/R37: the rendered orchestrator names the workplan handoff files and the out-of-scope-change rule, only under planTiers", () => {
    const off = freshDir();
    render(off, false);
    const orchestratorOff = readFileSync(join(off, ".claude/agents/orchestrator.md"), "utf-8");
    expect(orchestratorOff).not.toContain("workplan_<feature>.gate.jsonl");

    const on = freshDir();
    render(on, true);
    const orchestratorOn = readFileSync(join(on, ".claude/agents/orchestrator.md"), "utf-8");
    expect(orchestratorOn).toContain(
      "`.claude/progress/workplan_<feature>.json` — the workplan source, written by you; " +
        "`workplan_<feature>.md` is `navori plan render`'s output, and `workplan_<feature>.gate.jsonl` the gate's log",
    );
    expect(orchestratorOn).toContain(
      "Planning tiers: the `planificacion` block decides the level; the `plan-simple` / `plan-advanced` skills carry the procedure.",
    );
  });
});

/**
 * Spec 0032 lote 3 (#1011) — T9/T10's implementer/reviewer/resolve-ticket
 * plan-tiers wiring, rendered so the [planTiers] conditional's on/off
 * behavior is verified against the actual output, not just the raw asset.
 *
 * Covers: R20, R21
 */
describe("implementer/reviewer/resolve-ticket — rendered plan-tiers wiring (T10)", () => {
  it("R20: the rendered implementer only carries the workplan/acceptance protocol under planTiers", () => {
    const off = freshDir();
    renderClaudeEngine(off, CONFIG_BASE);
    const implementerOff = readFileSync(join(off, ".claude/agents/implementer.md"), "utf-8");
    expect(implementerOff).not.toContain(
      "under `acceptance` (`id`, `command`, `exitCode`, `excerpt`)",
    );

    const on = freshDir();
    renderClaudeEngine(on, {
      ...CONFIG_BASE,
      harness: { planTiers: true },
    } as unknown as NavoriConfig);
    const implementerOn = readFileSync(join(on, ".claude/agents/implementer.md"), "utf-8");
    expect(implementerOn).toContain(
      "When the encargo opens with `workplan: <feature>`, read " +
        "`.claude/progress/workplan_<feature>.json`, run each assigned `A<n>` command and report " +
        "it in `impl_<feature>.json` under `acceptance` (`id`, `command`, `exitCode`, `excerpt`). " +
        "A file outside the workplan's files is a blocker to report, not a change to make.",
    );
  });

  it("R21: the rendered reviewer only requires classify --diff evidence under planTiers", () => {
    const off = freshDir();
    renderClaudeEngine(off, CONFIG_BASE);
    const reviewerOff = readFileSync(join(off, ".claude/agents/reviewer.md"), "utf-8");
    expect(reviewerOff).not.toContain("navori plan classify <feature> --diff");

    const on = freshDir();
    renderClaudeEngine(on, {
      ...CONFIG_BASE,
      harness: { planTiers: true },
    } as unknown as NavoriConfig);
    const reviewerOn = readFileSync(join(on, ".claude/agents/reviewer.md"), "utf-8");
    expect(reviewerOn).toContain(
      "With a workplan: an assigned `A<n>` without evidence in `acceptance`, a file outside the " +
        "workplan's files without a covering decision, or `navori plan classify <feature> --diff` " +
        "returning a higher level than declared → `CHANGES_REQUESTED`.",
    );
  });

  it("R22: the rendered resolve-ticket points level 2 at plan-advanced and opens the encargo with workplan: <feature>, only under planTiers", () => {
    const off = freshDir();
    renderClaudeEngine(off, CONFIG_BASE);
    const resolveTicketOff = readFileSync(
      join(off, ".claude/skills/resolve-ticket/SKILL.md"),
      "utf-8",
    );
    expect(resolveTicketOff).not.toContain("plan-advanced");

    const on = freshDir();
    renderClaudeEngine(on, {
      ...CONFIG_BASE,
      harness: { planTiers: true },
    } as unknown as NavoriConfig);
    const resolveTicketOn = readFileSync(
      join(on, ".claude/skills/resolve-ticket/SKILL.md"),
      "utf-8",
    );
    expect(resolveTicketOn).toContain("plan-advanced");
    expect(resolveTicketOn).toContain("the encargo opens with `workplan: <feature>`");
  });
});

/**
 * Spec 0032 lote 4 (#1011), T12 — this repo turns `harness.planTiers` on and
 * relies on core's always-on architect default (no `harness.architect`,
 * `models.architect` or `effort.architect` override left behind).
 *
 * Covers: R29, R31
 */
describe("this repo's navori.config.json — R29, R31", () => {
  const REPO_CONFIG_PATH = join(import.meta.dirname, "..", "..", "..", "..", "navori.config.json");

  it("R31: harness.planTiers is on", () => {
    const config = JSON.parse(readFileSync(REPO_CONFIG_PATH, "utf-8")) as NavoriConfig;
    expect(config.harness?.planTiers).toBe(true);
  });

  it("R29: no harness.architect, models.architect or effort.architect override — core's always-on default applies", () => {
    const config = JSON.parse(readFileSync(REPO_CONFIG_PATH, "utf-8")) as NavoriConfig & {
      harness?: { architect?: unknown };
    };
    expect(config.harness?.architect).toBeUndefined();
    expect(config.models?.architect).toBeUndefined();
    expect(config.effort?.architect).toBeUndefined();
  });

  it("R29: design.md registers the architect's admission per spec 0031 R3", () => {
    const designPath = join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "..",
      "specs",
      "0032-planificacion-por-niveles",
      "design.md",
    );
    const design = readFileSync(designPath, "utf-8");
    expect(design).toContain("Admisión del architect (spec 0031 R3)");
  });
});
