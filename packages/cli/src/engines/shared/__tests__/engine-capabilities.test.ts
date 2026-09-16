import { describe, it, expect } from "vitest";
import { ENGINES } from "../../../lib/schema.ts";
import {
  ENGINE_CAPABILITIES,
  validateEngineCapabilities,
  type EngineCapabilities,
} from "../engine-capabilities.ts";

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
      "not-a-real-engine": {
        id: "claude",
        label: "Fake",
        ownsAgentsMd: false,
        unsupportedSurfaces: [],
      },
    };
    expect(() => validateEngineCapabilities(withExtra, ENGINES)).toThrow(
      /engine ENGINES doesn't recognize/,
    );
  });
});
