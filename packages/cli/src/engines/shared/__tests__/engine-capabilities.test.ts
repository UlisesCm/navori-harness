import { describe, it, expect } from "vitest";
import { ENGINES } from "../../../lib/config/schema.ts";
import {
  ENGINE_CAPABILITIES,
  validateEngineCapabilities,
  CONTROL_DEFINITIONS,
  type ControlDeclaration,
  type EngineCapabilities,
} from "../engine-capabilities.ts";

const FAKE_ENGINE_CAPABILITIES: EngineCapabilities = {
  id: "claude",
  label: "Fake",
  ownsAgentsMd: false,
  unsupportedSurfaces: [],
  controls: {
    "plan-gate": { state: "unsupported", reason: "fake" },
    "markdown-ownership": { state: "unsupported", reason: "fake" },
    "handoff-shape": { state: "unsupported", reason: "fake" },
    "handoff-consumer": { state: "unsupported", reason: "fake" },
    "analytic-write-tools": { state: "unsupported", reason: "fake" },
    "local-skill-discovery": { state: "unsupported", reason: "fake" },
  },
  analyticWriteTools: { auditor: [], scout: [], reviewer: [], architect: [] },
};

/**
 * Bidirectional anchor between the frozen capability registry and `ENGINES`
 * (`lib/schema.ts`) — the same guarantee `validateEngineCapabilities` enforces
 * at module load, exercised here as an assertion instead of an import-time
 * throw so a future divergence fails a readable test, not a cryptic startup
 * crash (#821).
 */
describe("ENGINE_CAPABILITIES ↔ ENGINES", () => {
  it("has a registry entry for every engine in ENGINES", () => {
    for (const engine of ENGINES) {
      expect(ENGINE_CAPABILITIES[engine]).toBeDefined();
    }
  });

  it("has no registry entry for an id ENGINES doesn't recognize", () => {
    const registryIds = Object.keys(ENGINE_CAPABILITIES);
    for (const id of registryIds) {
      expect(ENGINES).toContain(id);
    }
  });

  it("requires a non-empty reason on every unsupportedSurfaces entry", () => {
    for (const capability of Object.values(ENGINE_CAPABILITIES)) {
      for (const surface of capability.unsupportedSurfaces) {
        expect(surface.reason.length).toBeGreaterThan(0);
      }
    }
  });

  it("declares full parity engines with an explicit empty list, not a missing field", () => {
    expect(ENGINE_CAPABILITIES.claude.unsupportedSurfaces).toEqual([]);
  });
});

describe("validateEngineCapabilities", () => {
  it("does not throw when the registry matches ENGINES exactly", () => {
    expect(() => validateEngineCapabilities(ENGINE_CAPABILITIES, ENGINES)).not.toThrow();
  });

  it("throws when ENGINES has an engine missing from the registry", () => {
    const { codex: _codex, ...withoutCodex } = ENGINE_CAPABILITIES;
    expect(() =>
      validateEngineCapabilities(
        withoutCodex as Readonly<Record<string, EngineCapabilities>>,
        ENGINES,
      ),
    ).toThrow(/no registry entry/);
  });

  it("throws when the registry has an entry ENGINES doesn't recognize", () => {
    const withExtra: Readonly<Record<string, EngineCapabilities>> = {
      ...ENGINE_CAPABILITIES,
      "not-a-real-engine": FAKE_ENGINE_CAPABILITIES,
    };
    expect(() => validateEngineCapabilities(withExtra, ENGINES)).toThrow(
      /engine ENGINES doesn't recognize/,
    );
  });
});

/** Covers: R20, R23 */
describe("controls (spec 0033 D5, R20)", () => {
  it("declares every ControlId, with a non-empty reason, for every engine", () => {
    const controlIds = Object.keys(CONTROL_DEFINITIONS);
    for (const capability of Object.values(ENGINE_CAPABILITIES)) {
      for (const id of controlIds) {
        const declaration = capability.controls[id as keyof typeof capability.controls];
        expect(declaration, `${capability.id}.controls.${id}`).toBeDefined();
        expect(declaration.reason.length).toBeGreaterThan(0);
      }
    }
  });

  it("requires evidence on every `enforced` declaration", () => {
    for (const capability of Object.values(ENGINE_CAPABILITIES)) {
      for (const declaration of Object.values(capability.controls)) {
        if (declaration.state === "enforced") {
          expect(declaration.evidence).toBeDefined();
        }
      }
    }
  });

  it("rejects an `enforced` object literal with no `evidence` at compile time", () => {
    // @ts-expect-error — `state: "enforced"` requires `evidence` by the type.
    const invalid: ControlDeclaration = { state: "enforced", reason: "missing evidence" };
    expect(invalid).toBeDefined();
  });
});

/** Covers: R23 */
describe("analyticWriteTools (spec 0033 D5, R23)", () => {
  const roles = ["auditor", "scout", "reviewer", "architect"] as const;

  it("declares all four analytic roles for every engine", () => {
    for (const capability of Object.values(ENGINE_CAPABILITIES)) {
      for (const role of roles) {
        expect(capability.analyticWriteTools[role], `${capability.id}.${role}`).toBeDefined();
      }
    }
  });

  it("declares no write-capable tools for the prose engines", () => {
    for (const id of ["agents-md", "cursor", "copilot"] as const) {
      for (const role of roles) {
        expect(ENGINE_CAPABILITIES[id].analyticWriteTools[role]).toEqual([]);
      }
    }
  });
});
