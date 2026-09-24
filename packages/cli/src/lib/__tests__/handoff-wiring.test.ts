// Covers: R13, R17
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getCoreRoot } from "../render/bundled-assets.ts";
import { adaptHarnessTextForCodex } from "../../engines/codex/compat.ts";
import { NavoriConfigSchema, type NavoriConfig } from "../config/schema.ts";
import { REQUIRED_IMPL_KEYS } from "../handoff/schema.ts";

/**
 * Spec 0033 D3/T8 — the render-side half of `navori handoff check`: the
 * prose that orders the command, its Codex retargeting, the pre-approval and
 * the parity between the advisory hook's hardcoded key list and the single
 * schema (`REQUIRED_IMPL_KEYS`). `lib/handoff/__tests__/check.test.ts` covers
 * the command itself; this file only covers that every engine's render
 * ORDERS it the same way (R17) — invocation stays advisory in both, per
 * design.md's explicit limit on R17.
 */

const CORE_ASSETS = resolve(getCoreRoot(), "core-assets");
const read = (rel: string): string => readFileSync(resolve(CORE_ASSETS, rel), "utf-8");

function codexConfig(): NavoriConfig {
  return NavoriConfigSchema.parse({ name: "handoff-demo", engines: ["codex"], preset: "custom" });
}

describe("orquestacion.md orders the preflight before dispatch (R14, R17)", () => {
  const block = read("managed/orquestacion.md");

  it("invokes navori handoff check with --dir .claude/progress and --json", () => {
    expect(block).toContain("navori handoff check");
    expect(block).toContain("--dir .claude/progress");
    expect(block).toContain("--json");
  });

  it('only continues on "status":"ok"', () => {
    expect(block).toContain('"status":"ok"');
  });

  it("retargets to .codex/progress in the Codex render, same pattern as receipt (R17)", () => {
    const adapted = adaptHarnessTextForCodex(block, codexConfig());
    expect(adapted).toContain("navori handoff check");
    expect(adapted).toContain("--dir .codex/progress");
    expect(adapted).not.toContain(".claude/progress");
  });
});

describe("scribe.md preflights the handoff before writing (R16, R17)", () => {
  it("scribeOwnsMarkdown ON runs --for scribe, --cwd and --json, and blocks without status ok", () => {
    const scribe = read("agents/scribe.md");
    expect(scribe).toContain("navori handoff check");
    expect(scribe).toContain("--for scribe");
    expect(scribe).toContain("--json");
    expect(scribe).toMatch(/BLOCKED/);
  });
});

describe("implementer.md registers head in the Closing report (R13)", () => {
  it('the JSON contract carries "head"', () => {
    const implementer = read("agents/implementer.md");
    expect(implementer).toContain('"head"');
  });
});

describe("orchestrator.md cross-references the block's rule without repeating it (R14)", () => {
  it("the scribe leg names the handoff check", () => {
    const orchestrator = read("agents/orchestrator.md");
    const scribeLeg = orchestrator.split("\n").find((line) => line.includes("scribe` leg")) ?? "";
    expect(scribeLeg).toMatch(/handoff/i);
  });
});

describe("settings-base.json pre-approves the command (R17)", () => {
  it("allows Bash(navori handoff check:*)", () => {
    const settings = JSON.parse(read("settings/settings-base.json")) as {
      permissions: { allow: string[] };
    };
    expect(settings.permissions.allow).toContain("Bash(navori handoff check:*)");
  });
});

describe("subagent-stop-handoff.sh stays advisory and in parity with REQUIRED_IMPL_KEYS (R17)", () => {
  const hook = read("hooks/subagent-stop-handoff.sh");

  it("never emits a blocking decision (stays advisory)", () => {
    // The doc comment SAYS "NEVER returns `decision: block`" in prose — that
    // phrase must not be confused with an actual emission. What would make
    // this hook blocking is a JSON payload with a quoted decision field.
    expect(hook).not.toMatch(/"decision"\s*:\s*"(block|deny)"/);
    expect(hook).not.toMatch(/"permissionDecision"\s*:\s*"deny"/);
  });

  it("its hardcoded required-key list matches REQUIRED_IMPL_KEYS exactly", () => {
    const match = /const required = \[([^\]]*)\];/.exec(hook);
    expect(match, "subagent-stop-handoff.sh's `required` array not found").not.toBeNull();
    const keys = (match?.[1] ?? "")
      .split(",")
      .map((k) => k.trim().replace(/^"|"$/g, ""))
      .filter(Boolean);
    expect(keys.sort()).toEqual([...REQUIRED_IMPL_KEYS].sort());
  });
});
