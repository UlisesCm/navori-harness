import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACTIVATION_ALIASES_PATH,
  serializeActivationAliases,
} from "../../../../scripts/gen-schemas.mjs";
import {
  type AliasDecision,
  requireDecisions,
  roleAliasDecisions,
  roleAliases,
  skillAliasDecisions,
  skillAliases,
} from "../activation-aliases.ts";
import { RETIRED_AGENTS, RETIRED_SKILLS, type Retired } from "../../../engines/shared/roster.ts";

/**
 * #869 — `mine-activation.py` used to hand-copy its continuity-alias
 * dictionaries instead of deriving them from the R38 registries
 * (`RETIRED_AGENTS`/`RETIRED_SKILLS`), so the next rename could desync the
 * two in silence. This suite pins two invariants at once: the JSON the
 * Python script reads never falls behind `activation-aliases.ts`, AND a
 * renamed retiree with no explicit include/exclude decision fails loudly
 * instead of silently joining or silently missing the alias map.
 */

describe("role/skill alias decisions cover every renamed retiree", () => {
  it("every RETIRED_AGENTS entry with a successor has exactly one role decision", () => {
    const renamed = RETIRED_AGENTS.filter((r) => r.successor !== null)
      .map((r) => r.id)
      .sort();
    const decided = roleAliasDecisions()
      .map((d) => d.id)
      .sort();
    expect(decided).toEqual(renamed);
  });

  it("every RETIRED_SKILLS entry with a successor has exactly one skill decision", () => {
    const renamed = RETIRED_SKILLS.filter((r) => r.successor !== null)
      .map((r) => r.id)
      .sort();
    const decided = skillAliasDecisions()
      .map((d) => d.id)
      .sort();
    expect(decided).toEqual(renamed);
  });

  it("requireDecisions throws when a renamed retiree has no decision", () => {
    const fixtureRetired: ReadonlyArray<Retired> = [
      { id: "ghost", successor: "new-ghost", markerIdByAdapter: {} },
    ];
    expect(() => requireDecisions("fixture-catalog", fixtureRetired, [])).toThrow(
      /gained a renamed retiree with no activation-alias decision.*ghost/,
    );
  });

  it("requireDecisions throws when a decision references an id no longer retired-with-a-successor", () => {
    const fixtureDecisions: ReadonlyArray<AliasDecision> = [
      { id: "ghost", successor: "new-ghost", include: true, reason: "stale fixture entry" },
    ];
    expect(() => requireDecisions("fixture-catalog", [], fixtureDecisions)).toThrow(
      /reference ids no longer retired-with-a-successor.*ghost/,
    );
  });

  it("requireDecisions accepts an exact match, order-independent", () => {
    const fixtureRetired: ReadonlyArray<Retired> = [
      { id: "a", successor: "a2", markerIdByAdapter: {} },
      { id: "b", successor: "b2", markerIdByAdapter: {} },
    ];
    const fixtureDecisions: ReadonlyArray<AliasDecision> = [
      { id: "b", successor: "b2", include: false, reason: "fixture reason for b" },
      { id: "a", successor: "a2", include: true, reason: "fixture reason for a" },
    ];
    expect(requireDecisions("fixture-catalog", fixtureRetired, fixtureDecisions)).toBe(
      fixtureDecisions,
    );
  });

  it("commit-pr-pilot is the only included role alias — the four other retired agents are excluded on purpose", () => {
    expect(roleAliases()).toEqual({ "commit-pr-pilot": "publisher" });
    const excludedIds = roleAliasDecisions()
      .filter((d) => !d.include)
      .map((d) => d.id)
      .sort();
    expect(excludedIds).toEqual(["explorer", "leader", "researcher", "ticket-audit"]);
    for (const d of roleAliasDecisions()) {
      expect(d.reason.length, d.id).toBeGreaterThan(10);
    }
  });

  it("all six renamed skills are included — no exclusion needed today", () => {
    expect(Object.keys(skillAliases()).sort()).toEqual(
      [
        "babysit-prs",
        "debug-error",
        "loop-back-debug",
        "security-guidance",
        "structural-search",
        "ticket-intake",
      ].sort(),
    );
    expect(skillAliasDecisions().every((d) => d.include)).toBe(true);
  });
});

describe("the JSON that mine-activation.py reads can't fall behind the module", () => {
  it("scripts/py/activation-aliases.json matches activation-aliases.ts", () => {
    // Same pattern as source-classify.rules.json: regenerate in memory and
    // compare byte-for-byte with the checked-in file.
    const onDisk = readFileSync(resolve(ACTIVATION_ALIASES_PATH), "utf-8");
    expect(onDisk, "the JSON fell behind the module — run 'pnpm gen:schemas'").toBe(
      serializeActivationAliases(),
    );
  });
});
