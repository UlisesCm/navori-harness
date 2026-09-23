import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getCoreRoot } from "../lib/bundled-assets.ts";
import { conditionOrchestration } from "../lib/render-plan.ts";
import { NavoriConfigSchema, type NavoriConfig } from "../lib/schema.ts";

/**
 * Spec 0030 (#985) Lote 2 — contract assertions on the prose assets T3-T5
 * rewrote, rendered under both `harness.scribeOwnsMarkdown` states. The flag
 * OFF branch pins that the rendered output is byte-identical to the
 * pre-spec text (R13); the flag ON branch pins the new contract (R1, R2, R5,
 * R6, R7, R8, R9).
 */

const CORE_ASSETS = resolve(getCoreRoot(), "core-assets");
const read = (rel: string): string => readFileSync(resolve(CORE_ASSETS, rel), "utf-8");

function config(scribeOwnsMarkdown: boolean): NavoriConfig {
  return NavoriConfigSchema.parse({
    name: "scribe-markdown-demo",
    engines: ["claude"],
    preset: "custom",
    harness: { scribeOwnsMarkdown },
  });
}

function renderedAgent(id: string, scribeOwnsMarkdown: boolean): string {
  return conditionOrchestration(read(`agents/${id}.md`), config(scribeOwnsMarkdown));
}

function renderedManaged(id: string, scribeOwnsMarkdown: boolean): string {
  return conditionOrchestration(read(`managed/${id}.md`), config(scribeOwnsMarkdown));
}

function renderedSkill(id: string, scribeOwnsMarkdown: boolean): string {
  return conditionOrchestration(read(`skills/${id}.md`), config(scribeOwnsMarkdown));
}

// Covers: R1, R2
describe("implementer.md — flag OFF keeps the current contract (R13)", () => {
  it("still instructs writing impl_<feature>.md and gives no JSON contract", () => {
    const off = renderedAgent("implementer", false);
    expect(off).toContain("Write `.claude/progress/impl_<feature>.md`");
    expect(off).toContain("done -> .claude/progress/impl_<feature>.md");
    expect(off).not.toContain("impl_<feature>.json");
    expect(off).not.toContain("markdownRequests");
  });
});

describe("implementer.md — flag ON carries the R1/R2 contract", () => {
  const on = renderedAgent("implementer", true);

  // Covers: R1
  it("states the .md/.mdx prohibition explicitly and gives no instruction to write one", () => {
    expect(on).toMatch(/SHALL NOT create or edit any file whose name ends in `\.md` or `\.mdx`/);
    expect(on).not.toContain("Write `.claude/progress/impl_<feature>.md`");
    expect(on).not.toMatch(/Write.*impl_<feature>\.md/);
  });

  // Covers: R2
  it("writes impl_<feature>.json with every required key and returns its path", () => {
    expect(on).toContain("impl_<feature>.json");
    expect(on).toContain("done -> .claude/progress/impl_<feature>.json");
    for (const key of [
      '"feature"',
      '"status"',
      '"worktree"',
      '"branch"',
      '"commits"',
      '"filesTouched"',
      '"verification"',
      '"markdownRequests"',
    ]) {
      expect(on, `missing R2 key ${key}`).toContain(key);
    }
  });
});

// Covers: R5, R6, R7
describe("scribe.md — flag OFF keeps the serializer-only contract (R13)", () => {
  it("still says 'not yet wired' and excludes user documentation", () => {
    const off = renderedAgent("scribe", false);
    expect(off).toContain("ahead of the typed-handoff migration");
    expect(off).toContain("user-authored documentation");
    expect(off).not.toContain("markdownRequests");
  });
});

describe("scribe.md — flag ON carries the R5/R6/R7 contract", () => {
  const on = renderedAgent("scribe", true);

  it("has no 'not yet wired' disclaimer and no 'you do not investigate' rule", () => {
    expect(on).not.toContain("ahead of the typed-handoff migration");
    expect(on).not.toContain("not yet wired");
    expect(on).not.toMatch(/you do not investigate/i);
    expect(on).not.toContain("user-authored documentation");
  });

  // Covers: R5
  it("renders impl_<feature>.md from impl_<feature>.json", () => {
    expect(on).toContain("impl_<feature>.json");
    expect(on).toMatch(/render.*impl_<feature>\.md/i);
  });

  // Covers: R6
  it("reports BLOCKED and fabricates no artifact on invalid or mismatched payload", () => {
    expect(on).toMatch(/BLOCKED/);
    expect(on).toMatch(/create NO `\.md` artifact|create no `?\.md`? artifact/i);
    expect(on).toMatch(/feature.*doesn't match|doesn't match.*feature/i);
  });

  // Covers: R7
  it("applies markdownRequests in the producer's worktree/branch with its own commit", () => {
    expect(on).toContain("markdownRequests");
    expect(on).toMatch(/intent/);
    expect(on).toMatch(/evidence/);
    expect(on).toMatch(/commit it yourself|separate from the producer's/);
  });
});

// Covers: R8, R9
describe("orchestrator.md + orquestacion.md — flag OFF keeps the current chain (R13)", () => {
  it("orchestrator.md: no scribe leg, no per-dispatch model rule", () => {
    const off = renderedAgent("orchestrator", false);
    expect(off).not.toContain("The `scribe` leg");
    expect(off).not.toContain("model: sonnet");
    expect(off).toContain("impl_<feature>.md");
    expect(off).not.toContain("impl_<feature>.json");
  });

  it("orquestacion.md: implementer then reviewer only", () => {
    const off = renderedManaged("orquestacion", false);
    expect(off).toContain("then **1 fresh `reviewer`**");
    expect(off).not.toContain("`scribe`");
  });
});

describe("orchestrator.md + orquestacion.md — flag ON shows the chain and model choice", () => {
  const orchOn = renderedAgent("orchestrator", true);
  const orquestOn = renderedManaged("orquestacion", true);

  // Covers: R9
  it("chains implementer -> scribe -> reviewer for changes carrying markdownRequests", () => {
    expect(orchOn).toMatch(/implementer.*scribe.*reviewer/s);
    expect(orchOn).toContain("prose-only change (no code) skips the `implementer`");
    expect(orquestOn).toMatch(/`scribe`.*markdownRequests/s);
  });

  // Covers: R9
  it("the reviewer judges the complete diff including the scribe's commit", () => {
    expect(orchOn.toLowerCase()).toMatch(/scribe.*commit|reviewer.*scribe/s);
  });

  // Covers: R8
  it("model is chosen per dispatch: cheap handoff render vs sonnet on shipped-diff prose", () => {
    expect(orchOn).toContain("model: sonnet");
    expect(orchOn).toMatch(/\{\{models\.scribe\}\}/);
  });
});

// Covers: R9
describe("resolve-ticket.md — phase 4/5 reflect the scribe leg only when the flag is on", () => {
  it("flag OFF: implementer alone produces impl_<feature>.md", () => {
    const off = renderedSkill("resolve-ticket", false);
    expect(off).toContain("Produces `impl_<feature>.md`");
    expect(off).not.toContain("impl_<feature>.json");
  });

  it("flag ON: implementer produces JSON, scribe renders the .md and applies requests", () => {
    const on = renderedSkill("resolve-ticket", true);
    expect(on).toContain("impl_<feature>.json");
    expect(on).toMatch(/scribe.*renders.*impl_<feature>\.md/i);
  });
});

describe("verify-before-done.md — the implementer's done-claim path follows the flag", () => {
  it("flag OFF: done -> impl_<feature>.md", () => {
    expect(renderedSkill("verify-before-done", false)).toContain("done -> impl_<feature>.md");
  });

  it("flag ON: done -> impl_<feature>.json", () => {
    expect(renderedSkill("verify-before-done", true)).toContain("done -> impl_<feature>.json");
  });
});
