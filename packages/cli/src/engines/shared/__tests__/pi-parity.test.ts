import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getCoreRoot, listBundledPluginIds } from "../../../lib/render/bundled-assets.ts";
import { loadPlugin } from "../../../lib/config/plugins.ts";
import { PI_EXTENSION_SOURCE } from "../../pi/extension-source.ts";
import { ENGINE_CAPABILITIES, type ControlId } from "../engine-capabilities.ts";
import { OVERLAP_ROWS } from "../native-overlap.ts";
import {
  PI_PARITY,
  PI_SEATBELT_BYPASSES,
  isControlRow,
  missingPiParityUnits,
  piParityIssues,
  piParityKey,
  piParityState,
  pluginParityUnits,
  type PiDirectParity,
  type PiParity,
  type PiParityState,
  type PiParityManifest,
} from "../pi-parity.ts";

const coreAssets = resolve(getCoreRoot(), "core-assets");
const resolveControl = (id: ControlId): PiParityState => ENGINE_CAPABILITIES.pi.controls[id].state;

/** Every hook asset the core ships, by script basename. */
const coreHookIds = (): string[] =>
  readdirSync(join(coreAssets, "hooks"))
    .filter((f) => f.endsWith(".sh"))
    .map((f) => f.slice(0, -3));

const overlapIds = (kind: string): string[] =>
  OVERLAP_ROWS.filter((row) => row.unit.kind === kind).map((row) => row.unit.id);

const bundledManifests = () => listBundledPluginIds().map((id) => loadPlugin(id).manifest);

/** The units Navori emits for another engine, as `PI_PARITY` keys. */
const realInventory = (): string[] => [
  ...coreHookIds().map((id) => piParityKey("hook", id)),
  ...overlapIds("permission-rule").map((id) => piParityKey("permission-rule", id)),
  ...bundledManifests().flatMap((manifest) => pluginParityUnits(manifest)),
];

describe("PI_PARITY inventory", () => {
  // Covers: R1
  it("has a row for every core hook, permission rule and plugin unit", () => {
    expect(missingPiParityUnits(realInventory())).toEqual([]);
  });

  // Covers: R1
  it("has no row left behind for a unit that no longer exists", () => {
    const inventory = new Set(realInventory());
    expect(Object.keys(PI_PARITY).filter((key) => !inventory.has(key))).toEqual([]);
  });

  // Covers: R1
  it("covers the same hooks the overlap matrix lists", () => {
    expect([...coreHookIds()].sort()).toEqual(overlapIds("hook").sort());
  });

  // Covers: R1
  it("undeclared unit fails by name", () => {
    const synthetic = [
      piParityKey("hook", "brand-new-hook"),
      piParityKey("permission-rule", "narrowed:Bash(newcmd*)"),
      piParityKey("plugin-settings", "newplugin"),
      piParityKey("plugin-prompt", "newplugin/project.newKey"),
    ];
    expect(missingPiParityUnits([...synthetic, piParityKey("hook", "guard-destructive")])).toEqual(
      synthetic,
    );
  });

  // Covers: R1
  it("a synthetic manifest unit of every kind without a row is reported by id", () => {
    const manifest: PiParityManifest = {
      id: "newplugin",
      skills: [{ id: "s1" }],
      hooks: [{}, {}],
      scripts: [{ dest: "run.sh" }],
      hookExtensions: [{ id: "ext" }],
      managed: [{ id: "blk" }],
      mcpServer: { command: "x" },
      settingsFragment: { permissions: { deny: ["Bash(x*)"] } },
      prompts: [{ key: "project.newKey" }],
    };
    const units = pluginParityUnits(manifest);
    expect(units).toEqual([
      "plugin-skill:newplugin/s1",
      "plugin-hook:newplugin/0",
      "plugin-hook:newplugin/1",
      "plugin-script:newplugin/run.sh",
      "plugin-hook-extension:newplugin/ext",
      "plugin-managed:newplugin/blk",
      "plugin-mcp-server:newplugin",
      "plugin-settings:newplugin",
      "plugin-prompt:newplugin/project.newKey",
    ]);
    expect(missingPiParityUnits(units)).toEqual(units);
  });
});

describe("PI_PARITY rows", () => {
  // Covers: R7
  it("inherits enforced Markdown ownership without claiming a Bash sandbox", (): void => {
    const row = PI_PARITY[piParityKey("hook", "implementer-no-markdown")]!;
    expect(row).toMatchObject({ control: "markdown-ownership" });
    expect(piParityState(row, resolveControl)).toBe("enforced");
    expect(row.boundary).toContain("not a sandbox");
    expect(row.boundary).toContain("dynamic destinations");
  });

  const direct = Object.entries(PI_PARITY).filter(
    (entry): entry is [string, PiDirectParity] => !isControlRow(entry[1]),
  );

  // Covers: R1
  it("every row is well formed, naming the unit when not", () => {
    const issues = Object.entries(PI_PARITY).flatMap(([key, row]) =>
      piParityIssues(row).map((issue) => `${key}: ${issue}`),
    );
    expect(issues).toEqual([]);
  });

  // Covers: R1
  it("every seatbelt row carries its bypass list", () => {
    for (const [key, row] of direct) {
      if (row.seatbelt === true) {
        expect(row.bypass?.length, key).toBeGreaterThan(0);
      }
    }
    expect(PI_SEATBELT_BYPASSES.length).toBeGreaterThan(0);
  });

  // Covers: R1
  it("rejects a seatbelt row without bypass list and a proof-less enforced row", () => {
    const base = { mechanism: "m", boundary: "b" };
    expect(piParityIssues({ ...base, state: "enforced", seatbelt: true, evidence: "e" })).toContain(
      "a seatbelt row needs its bypass list",
    );
    expect(piParityIssues({ ...base, state: "enforced" })).toContain(
      "a enforced row needs evidence",
    );
    expect(piParityIssues({ ...base, state: "unsupported", evidence: "e" })).toContain(
      "a unsupported row must not carry evidence",
    );
    expect(
      piParityIssues({ ...base, state: "enforced", seatbelt: true, evidence: "e", bypass: ["x"] }),
    ).toEqual([]);
  });

  // Covers: R1
  it("a row is non-unsupported exactly when its evidence exists (direct rows)", () => {
    for (const [key, row] of direct) {
      const proven = row.state === "enforced" || row.state === "advisory";
      expect(row.evidence !== undefined, key).toBe(proven);
      if (row.evidence?.startsWith("pi-extension:")) {
        const event = row.evidence.slice("pi-extension:".length);
        expect(PI_EXTENSION_SOURCE, `${key} evidence ${row.evidence}`).toContain(
          `pi.on("${event}"`,
        );
      }
    }
  });

  // Covers: R1
  it("a control row is non-unsupported exactly when the control declares evidence or advisory", () => {
    for (const [key, row] of Object.entries(PI_PARITY)) {
      if (!isControlRow(row)) continue;
      const declaration = ENGINE_CAPABILITIES.pi.controls[row.control];
      if (declaration.state === "enforced") {
        expect(declaration.evidence, key).toBeDefined();
      }
      expect(piParityState(row, resolveControl), key).toBe(declaration.state);
    }
  });

  // Covers: R1
  it("derives engines.pi of hook, permission-rule and plugin-script overlap rows from the table", () => {
    const derived = OVERLAP_ROWS.filter((row) =>
      ["hook", "permission-rule", "plugin-script"].includes(row.unit.kind),
    );
    expect(derived.length).toBeGreaterThan(0);
    for (const row of derived) {
      const parity = PI_PARITY[piParityKey(row.unit.kind, row.unit.id)] as PiParity;
      const state = piParityState(parity, resolveControl);
      const expected = state === "n/a" ? "n/a" : state === "unsupported" ? "unsupported" : "emit";
      expect(row.engines.pi, `${row.unit.kind}:${row.unit.id}`).toBe(expected);
    }
  });

  // Covers: R1
  it("keeps routing-watch declared with its evaluation and model-advisor unsupported", () => {
    const routing = PI_PARITY["hook:routing-watch"] as PiDirectParity;
    expect(routing.state).toBe("unsupported");
    expect(routing.mechanism).toContain("Probe");
    expect((PI_PARITY["hook:model-advisor"] as PiDirectParity).state).toBe("unsupported");
  });

  // Covers: R1
  it("never declares an allow-only settingsFragment as anything but n/a, and an ask/deny one as such", () => {
    for (const manifest of bundledManifests()) {
      if (manifest.settingsFragment === undefined) continue;
      const permissions = (manifest.settingsFragment as { permissions?: Record<string, string[]> })
        .permissions;
      const restrictive = (permissions?.ask?.length ?? 0) + (permissions?.deny?.length ?? 0) > 0;
      const row = PI_PARITY[piParityKey("plugin-settings", manifest.id)] as PiDirectParity;
      expect(row.state === "n/a", manifest.id).toBe(!restrictive);
    }
  });

  // Covers: R1
  it("points claude-hook-parity at the table", () => {
    const surface = ENGINE_CAPABILITIES.pi.unsupportedSurfaces.find(
      (s) => s.surface === "claude-hook-parity",
    );
    expect(surface?.reason).toContain("PI_PARITY");
  });
});
