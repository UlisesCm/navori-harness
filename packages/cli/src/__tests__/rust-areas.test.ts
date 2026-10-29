import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { main } from "../cli.ts";

interface Manifest {
  schema: number;
  commands: Array<{ path: string[]; flags?: string[] }>;
  hooks: Record<string, unknown>;
}
interface Missing {
  commands: string[];
  flags: string[];
  hooks: string[];
}
type Area = "E1" | "E2" | "E3" | "prior";
interface Areas {
  AREAS: Record<Area, { commands: string[]; hooks: string[] }>;
  areaOf: (item: { command?: string[]; hook?: string }) => Area;
  commandInventory: (root: unknown) => Promise<Array<{ path: string[]; flags: string[] }>>;
  hookInventory: () => string[];
  withoutAreas: (manifest: Manifest, areas: Area[]) => Manifest;
  areaInventoryCheck: (
    area: Area,
    manifest: Manifest,
    commands: Array<{ path: string[]; flags: string[] }>,
    hooks: string[],
  ) => Missing;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const areas = (await import(
  pathToFileURL(join(root, "scripts", "js", "rust-areas.mjs")).href
)) as Areas;
const manifest = JSON.parse(readFileSync(join(root, "crates", "ported.json"), "utf8")) as Manifest;
const commands = await areas.commandInventory(main);
const hooks = areas.hookInventory();

describe("rust-areas (spec 0060 D40/D41)", () => {
  // Covers: R77, R78
  it("todo subcomando, flag y hook tiene un área", () => {
    expect(commands.length).toBeGreaterThan(29);
    for (const entry of commands) expect(() => areas.areaOf({ command: entry.path })).not.toThrow();
    expect(hooks).toHaveLength(22);
    for (const id of hooks) expect(() => areas.areaOf({ hook: id })).not.toThrow();
    const roots = new Set(commands.map((entry) => entry.path[0]));
    const owned = Object.values(areas.AREAS).flatMap((area) => area.commands);
    expect([...roots].sort()).toEqual([...owned].sort());
    expect(() => areas.areaOf({ command: ["nuevo"] })).toThrow(/no area/);
    expect(() => areas.areaOf({ hook: "nuevo-hook" })).toThrow(/no area/);
  });

  // Covers: R77, R78
  it("el slice de referencia de hooks queda en el manifiesto y en pie sin E2 ni E3", () => {
    const standalone = areas.withoutAreas(manifest, ["E2", "E3"]);
    const missing = areas.areaInventoryCheck("E1", standalone, commands, hooks);
    expect(missing.hooks).not.toContain("general-purpose-confirm");
    expect(areas.areaOf({ hook: "general-purpose-confirm" })).toBe("E1");
    const withoutE1 = areas.withoutAreas(manifest, ["E1"]);
    expect(Object.keys(withoutE1.hooks)).not.toContain("general-purpose-confirm");
    expect(Object.keys(withoutE1.hooks)).toContain("guard-destructive");
  });

  // Covers: R77
  it("spec no tiene subcomandos ni flags pendientes", () => {
    const spec = commands.filter((entry) => entry.path[0] === "spec");
    expect(spec.map((entry) => entry.path.join(" "))).toEqual([
      "spec",
      "spec check",
      "spec classify",
    ]);
    // A positional is not a flag: `feature` never reaches the manifest.
    expect(spec.find((entry) => entry.path.join(" ") === "spec check")?.flags).toEqual([
      "cwd",
      "json",
    ]);
    const missing = areas.areaInventoryCheck(
      "E1",
      areas.withoutAreas(manifest, ["E2", "E3"]),
      spec,
      [],
    );
    expect(missing).toEqual({ commands: [], flags: [], hooks: [] });
  });

  // Covers: R77
  it("reporta comandos, flags y hooks pendientes de un área", () => {
    const partial: Manifest = {
      schema: 1,
      commands: [{ path: ["spec", "check"], flags: [] }],
      hooks: {},
    };
    const missing = areas.areaInventoryCheck(
      "E1",
      partial,
      [
        { path: ["spec"], flags: [] },
        { path: ["spec", "check"], flags: ["json"] },
      ],
      ["general-purpose-confirm", "guard-destructive"],
    );
    expect(missing).toEqual({
      commands: ["spec"],
      flags: ["spec check --json"],
      hooks: ["general-purpose-confirm"],
    });
  });
});
