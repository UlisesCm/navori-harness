import { describe, it, expect } from "vitest";
import {
  ROSTER_AGENTS,
  ROSTER_INDEXED_AGENT_IDS,
  ROSTER_CORE_SKILLS,
  ROSTER_WORKFLOW_SKILLS,
  assertRosterIds,
} from "../roster.ts";
import { CORE_AGENTS, CORE_SKILLS, WORKFLOW_SKILLS } from "../harness-assets.ts";
import { AGENT_ROLE_KEYS } from "../../../lib/config.ts";
import { AGENT_ROLES } from "../../../lib/plugins.ts";
import { CANONICAL_HARNESS_KEY, LEGACY_AGENT_ALIASES } from "../../../lib/legacy-agents.ts";
import { RECOMMENDED_MODELS, RECOMMENDED_EFFORT } from "../../../lib/recommended.ts";
import { tc } from "../../../lib/i18n.ts";

/**
 * `engines/shared/roster.ts` is the canonical roster (spec 0026 T8, R42): every
 * other id list the codebase hand-copies from it must match, and a test SHALL
 * fail the moment one drifts. This suite is that test.
 *
 * // Covers: R38, R42
 */
describe("roster-parity", () => {
  const rosterIds = ROSTER_AGENTS.map((a) => a.id);
  const rosterHarnessKeys = ROSTER_AGENTS.map((a) => a.harnessKey);

  it("assertRosterIds rejects a seeded divergent list (the checker itself is exercised)", () => {
    expect(() =>
      assertRosterIds("seeded-fixture", rosterIds, [...rosterIds, "ghost-agent"]),
    ).toThrow(/diverges from the canonical roster/);
    expect(() =>
      assertRosterIds(
        "seeded-fixture",
        rosterIds,
        rosterIds.filter((id) => id !== rosterIds[0]),
      ),
    ).toThrow(/diverges from the canonical roster/);
    // Order-independent: a permutation of the same members must NOT throw.
    expect(() =>
      assertRosterIds("seeded-fixture", rosterIds, [...rosterIds].reverse()),
    ).not.toThrow();
  });

  // Covers: R29
  it("core skills are exactly the catalog", () => {
    // R29 names ONE flat list of 10 ids — it doesn't distinguish core vs.
    // workflow, that split is an internal marker-shape detail (`<id>-base` vs.
    // bare id, see roster.ts's `Retired` JSDoc). The union of the two roster
    // lists must equal it exactly.
    assertRosterIds(
      "R29 core skill catalog",
      [
        "spec-bootstrap",
        "resolve-ticket",
        "solution-design",
        "dominio",
        "follow-up-prs",
        "locate-code",
        "verify-before-done",
        "debug-failure",
        "review-diff",
        "security-invariants",
      ],
      [...ROSTER_CORE_SKILLS, ...ROSTER_WORKFLOW_SKILLS],
    );
  });

  // Covers: R19, R20, R47
  it("core roster is exactly the seven agents — every active id list matches its canonical catalog", () => {
    assertRosterIds(
      "harness-assets.CORE_AGENTS",
      rosterIds,
      CORE_AGENTS.map((a) => a.id),
    );
    assertRosterIds("harness-assets.CORE_SKILLS", ROSTER_CORE_SKILLS, CORE_SKILLS);
    assertRosterIds("harness-assets.WORKFLOW_SKILLS", ROSTER_WORKFLOW_SKILLS, WORKFLOW_SKILLS);
    assertRosterIds("config.AGENT_ROLE_KEYS", rosterHarnessKeys, [...AGENT_ROLE_KEYS]);
    assertRosterIds("plugins.AGENT_ROLES", rosterIds, [...AGENT_ROLES]);
    assertRosterIds(
      "legacy-agents.CANONICAL_HARNESS_KEY keys",
      rosterIds,
      Object.keys(CANONICAL_HARNESS_KEY),
    );
    assertRosterIds(
      "legacy-agents.CANONICAL_HARNESS_KEY values",
      rosterHarnessKeys,
      Object.values(CANONICAL_HARNESS_KEY),
    );
    // LEGACY_AGENT_ALIASES is a PARTIAL map (only agent ids some known legacy
    // harness actually used) — a subset check, not `assertRosterIds`'s full
    // equality: `commit-pr-pilot` has no legacy alias today and that's fine.
    // `legacy-agents.test.ts` owns this invariant with its own fixture-level
    // coverage; here it's enough that no target NAMES an id outside the roster.
    for (const target of Object.values(LEGACY_AGENT_ALIASES)) {
      expect(rosterIds, `LEGACY_AGENT_ALIASES target '${target}' is not on the roster`).toContain(
        target,
      );
    }
    assertRosterIds(
      "recommended.RECOMMENDED_MODELS",
      rosterHarnessKeys,
      Object.keys(RECOMMENDED_MODELS),
    );
    assertRosterIds(
      "recommended.RECOMMENDED_EFFORT",
      rosterHarnessKeys,
      Object.keys(RECOMMENDED_EFFORT),
    );
    assertRosterIds(
      "i18n.blocks.agentsIndex.when (es)",
      ROSTER_INDEXED_AGENT_IDS,
      Object.keys(tc("es").blocks.agentsIndex.when),
    );
    assertRosterIds(
      "i18n.blocks.agentsIndex.when (en)",
      ROSTER_INDEXED_AGENT_IDS,
      Object.keys(tc("en").blocks.agentsIndex.when),
    );
  });
});
