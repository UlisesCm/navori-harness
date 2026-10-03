import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NavoriConfigSchema } from "../../../lib/config/schema.ts";
import { renderCodexEngine } from "../../codex/index.ts";
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
    "master-plan": { state: "unsupported", reason: "fake" },
    "plan-gate": { state: "unsupported", reason: "fake" },
    "markdown-ownership": { state: "unsupported", reason: "fake" },
    "handoff-shape": { state: "unsupported", reason: "fake" },
    "handoff-consumer": { state: "unsupported", reason: "fake" },
    "analytic-write-tools": { state: "unsupported", reason: "fake" },
    "local-skill-discovery": { state: "unsupported", reason: "fake" },
    "acceptance-evidence": { state: "unsupported", reason: "fake" },
    "repeat-failure-advice": { state: "unsupported", reason: "fake" },
    "compact-advice": { state: "unsupported", reason: "fake" },
    "general-purpose-confirm": { state: "unsupported", reason: "fake" },
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

// Covers: R40, R70
describe("general-purpose-confirm control", () => {
  it("is enforced on Claude by the PreToolUse(Agent) hook and unsupported elsewhere", () => {
    const claude = ENGINE_CAPABILITIES.claude.controls["general-purpose-confirm"];
    expect(claude.state).toBe("enforced");
    expect(claude.state === "enforced" && claude.evidence).toEqual({
      kind: "hook",
      script: "general-purpose-confirm.sh",
      event: "PreToolUse",
      matcher: "Agent",
    });
    for (const engine of ENGINES.filter((e) => e !== "claude")) {
      expect(ENGINE_CAPABILITIES[engine].controls["general-purpose-confirm"].state).toBe(
        "unsupported",
      );
    }
  });
});

/** Covers: R41 */
describe("master-plan control", () => {
  it.each(ENGINES)("declares master-plan for %s", (engine) => {
    const declaration = ENGINE_CAPABILITIES[engine].controls["master-plan"];
    expect(declaration).toBeDefined();
    if (engine === "claude") {
      expect(declaration).toEqual({
        state: "enforced",
        reason: expect.any(String),
        evidence: {
          kind: "hook",
          script: "master-plan-context.sh",
          event: "SessionStart",
          matcher: "startup|resume|clear|compact|fork",
        },
      });
    } else if (engine === "pi") {
      expect(declaration).toMatchObject({
        state: "advisory",
        reason: expect.stringContaining("before_agent_start"),
      });
    } else if (engine === "codex") {
      // Spec 0041 T15: skills and SessionStart hook reach Codex; advisory until T20's smoke.
      expect(declaration).toMatchObject({
        state: "advisory",
        reason: expect.stringContaining("SessionStart"),
      });
    } else {
      expect(declaration).toEqual({
        state: "unsupported",
        reason: "fase 2 de la spec 0034: la skill no se renderiza y no hay hook de arranque",
      });
    }
  });

  it("is conditioned on harness.masterPlan", () => {
    expect(CONTROL_DEFINITIONS["master-plan"]).toMatchObject({
      condition: "masterPlan",
      hookScripts: ["master-plan-context.sh"],
    });
  });
});

/** Covers: R3 */
describe("Pi control boundaries", () => {
  it("names an extension-tool boundary for enforced dispatch controls", () => {
    for (const id of ["plan-gate", "handoff-consumer"] as const) {
      expect(ENGINE_CAPABILITIES.pi.controls[id]).toMatchObject({
        state: "enforced",
        reason: expect.stringContaining("bypass"),
        evidence: {
          kind: "extension-tool",
          path: ".pi/extensions/navori.ts",
          tool: "navori_subagent",
        },
      });
    }
    expect(ENGINE_CAPABILITIES.pi.controls["handoff-shape"].state).toBe("unsupported");
    expect(ENGINE_CAPABILITIES.pi.controls["local-skill-discovery"].state).toBe("unsupported");
  });

  it("does not claim acceptance evidence without a Pi child Bash recorder", () => {
    expect(ENGINE_CAPABILITIES.pi.controls["acceptance-evidence"]).toMatchObject({
      state: "unsupported",
      reason: expect.stringContaining("does not record verifiable child Bash results"),
    });
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

// Covers: R30
describe("unsupportedSurfaces.renderedPaths", () => {
  /** Glob match where `*` stands for any run of characters inside ONE path segment. */
  const matchesGlob = (glob: string, path: string): boolean => {
    const want = glob.split("/");
    const got = path.split("/");
    return (
      want.length === got.length &&
      want.every((segment, i) => {
        const [first = "", ...rest] = segment.split("*");
        const actual = got[i] ?? "";
        if (rest.length === 0) return actual === segment;
        const last = rest.pop() ?? "";
        return (
          actual.length >= first.length + last.length &&
          actual.startsWith(first) &&
          actual.endsWith(last) &&
          rest.every((mid) => actual.includes(mid))
        );
      })
    );
  };

  function walk(root: string, rel = ""): string[] {
    const abs = join(root, rel);
    if (!existsSync(abs)) return [];
    return readdirSync(abs, { withFileTypes: true }).flatMap((entry) => {
      const next = rel === "" ? entry.name : `${rel}/${entry.name}`;
      return entry.isDirectory() ? walk(root, next) : [next];
    });
  }

  it("fails if a Codex surface declared unsupported has rendered files", () => {
    const cwd = mkdtempSync(join(tmpdir(), "navori-caps-"));
    const cfg = NavoriConfigSchema.parse({
      name: "caps",
      engines: ["codex"],
      preset: "custom",
      branchBase: "main",
      qualityGate: { fast: "pnpm test", full: "pnpm test" },
      harness: { planTiers: true, scribeOwnsMarkdown: true, masterPlan: true },
      hooks: { verifyOnStop: true },
      plugins: {
        engram: { enabled: true },
        jscpd: { enabled: true },
        semgrep: { enabled: true },
        tgrep: { enabled: true },
      },
    });
    renderCodexEngine(cwd, cfg);
    const files = walk(cwd);
    for (const surface of ENGINE_CAPABILITIES.codex.unsupportedSurfaces) {
      for (const glob of surface.renderedPaths ?? []) {
        const hits = files.filter((f) => matchesGlob(glob, f));
        expect(hits, `surface '${surface.surface}' is unsupported but rendered ${hits}`).toEqual(
          [],
        );
      }
    }
  });

  it("no longer lists engine-scripts: Codex installs registered plugin scripts", () => {
    expect(
      ENGINE_CAPABILITIES.codex.unsupportedSurfaces.some((s) => s.surface === "engine-scripts"),
    ).toBe(false);
  });
});
