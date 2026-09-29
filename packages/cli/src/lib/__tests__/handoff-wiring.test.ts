// Covers: R13, R17
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
const DOCS = fileURLToPath(new URL("../../../../../docs/", import.meta.url));
const readDoc = (name: string): string => readFileSync(resolve(DOCS, name), "utf-8");

function codexConfig(): NavoriConfig {
  return NavoriConfigSchema.parse({ name: "handoff-demo", engines: ["codex"], preset: "custom" });
}

describe("orquestacion.md orders the preflight before dispatch (R14, R17)", () => {
  const block = read("managed/orquestacion.md");

  // Covers: R15, R18
  it("does not require an implementation handoff before its first producer exists", () => {
    const mechanics = block.split("### The mechanics\n")[1]?.split("\n### ")[0] ?? "";
    expect(mechanics).toMatch(/first (researcher|producer)/i);
    expect(mechanics).toMatch(/(?:architect|scout|auditor)/i);
    expect(mechanics).toMatch(/impl_<feature>\.json/);
    expect(mechanics).not.toMatch(/\*\*Before dispatching\*\*, run `navori handoff check/);
  });

  // Covers: R15, R18
  it("requires the check for consumers while keeping the plan precondition independent", () => {
    const mechanics = block.split("### The mechanics\n")[1]?.split("\n### ")[0] ?? "";
    const planning = read("managed/planificacion.md");
    expect(mechanics).toMatch(/before dispatching.*(?:scribe|reviewer)/i);
    expect(mechanics).toContain('"status":"ok"');
    expect(mechanics).toMatch(/plan(?:ning)? precondition/i);
    expect(planning).toContain("Before dispatching the `implementer`");
    expect(planning).toContain("plan check");
  });

  // Covers: R1, R9, R12
  it("invokes navori handoff check in the neutral root with --json", () => {
    expect(block).toContain("navori handoff check");
    expect(block).toContain("--dir .navori/state/handoffs");
    expect(block).toContain("--json");
  });

  it('only continues on "status":"ok"', () => {
    expect(block).toContain('"status":"ok"');
  });

  it("retains the neutral handoff root in the Codex render (R17)", () => {
    const adapted = adaptHarnessTextForCodex(block, codexConfig());
    expect(adapted).toContain("navori handoff check");
    expect(adapted).toContain("--dir .navori/state/handoffs");
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

describe("Spec 0036 migration guidance", () => {
  // Covers: R7, R10
  it("distinguishes checkout-local runtime state from versioned project knowledge", () => {
    const direction = readDoc("DIRECTION.md");
    expect(direction).toContain(".navori/state/handoffs/");
    expect(direction).toContain(".navori/state/hooks/");
    expect(direction).toContain("progress/current.md");
    expect(direction).toContain("progress/history.md");
    expect(direction).toContain(".navori/presets/");
  });

  // Covers: R7, R10, R11
  it("explains legacy handoffs, stamps, re-arming, and rollback without cleanup", () => {
    const extending = readDoc("EXTENDING.md");
    expect(extending).toContain(".claude/progress/");
    expect(extending).toContain(".codex/progress/");
    expect(extending).toContain(".navori/state/handoffs/");
    expect(extending).toContain("<git-common-dir>/navori/");
    expect(extending).toContain("--dir");
    expect(extending).toMatch(/una versi[oó]n/i);
    expect(extending).toMatch(/rearm/i);
    expect(extending).toMatch(/rollback/i);
    expect(extending).toMatch(/sin (copiar|mover|borrar)/i);
  });

  // Covers: R6
  it("states the trusted-local-writer boundary and concurrent redirect risk", () => {
    const extending = readDoc("EXTENDING.md");
    expect(extending).toMatch(/escrit(or|ura) local confiable/i);
    expect(extending).toMatch(/cambios concurrentes/i);
    expect(extending).toMatch(/fuera del checkout/i);
    expect(extending).toMatch(/no garantiza/i);
    expect(extending).toMatch(/carrera|race/i);
  });
});
