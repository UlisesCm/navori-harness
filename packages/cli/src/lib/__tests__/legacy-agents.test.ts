import { describe, it, expect } from "vitest";
import { detectLegacyAgents, LEGACY_AGENT_ALIASES } from "../legacy-agents.ts";
import type { NavoriConfig } from "../config.ts";

const cfg = (harness?: Record<string, boolean>) =>
  ({ name: "demo", engines: ["claude"], harness }) as unknown as NavoriConfig;

describe("detectLegacyAgents", () => {
  it("maps a known legacy file to its canonical agent", () => {
    expect(detectLegacyAgents(["sdd-leader.md"], cfg())).toEqual([
      { legacyName: "sdd-leader", canonical: "leader" },
    ]);
    expect(detectLegacyAgents(["deep-auditor.md"], cfg())).toEqual([
      { legacyName: "deep-auditor", canonical: "auditor" },
    ]);
  });

  it("detects several legacy files, order-stable by input", () => {
    const found = detectLegacyAgents(
      [
        "sdd-leader.md",
        "sdd-implementer.md",
        "sdd-reviewer.md",
        "sdd-explorer.md",
        "deep-auditor.md",
      ],
      cfg(),
    );
    expect(found.map((l) => l.canonical)).toEqual([
      "leader",
      "implementer",
      "reviewer",
      "explorer",
      "auditor",
    ]);
  });

  it("ignores canonical/unknown agent files (not legacy)", () => {
    expect(detectLegacyAgents(["leader.md", "auditor.md", "my-custom-agent.md"], cfg())).toEqual(
      [],
    );
  });

  it("accepts filenames with or without the .md extension", () => {
    expect(detectLegacyAgents(["sdd-reviewer"], cfg())).toEqual([
      { legacyName: "sdd-reviewer", canonical: "reviewer" },
    ]);
  });

  it("does NOT flag a legacy file when its canonical is disabled in harness", () => {
    // Canonical `auditor` off → deep-auditor is not a redundant duplicate.
    expect(detectLegacyAgents(["deep-auditor.md"], cfg({ auditor: false }))).toEqual([]);
    // ticket-audit uses a camelCase harness key.
    expect(detectLegacyAgents(["sdd-ticket-audit.md"], cfg({ ticketAudit: false }))).toEqual([]);
  });

  it("flags when harness is present but the canonical flag is undefined (defaults on)", () => {
    expect(detectLegacyAgents(["sdd-leader.md"], cfg({ implementer: true }))).toEqual([
      { legacyName: "sdd-leader", canonical: "leader" },
    ]);
  });

  it("every alias target is a real canonical agent id", () => {
    const canonicals = new Set([
      "leader",
      "implementer",
      "reviewer",
      "researcher",
      "ticket-audit",
      "commit-pr-pilot",
      "explorer",
      "auditor",
    ]);
    for (const target of Object.values(LEGACY_AGENT_ALIASES)) {
      expect(canonicals.has(target), `alias target '${target}' is not a canonical agent`).toBe(
        true,
      );
    }
  });
});
