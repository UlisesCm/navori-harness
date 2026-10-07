import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findUnknownConfigKeys, readConfig, writeConfig } from "../config.ts";
import { DEFAULT_DELIVERIES, NavoriConfigSchema, resolveDeliveryThresholds } from "../schema.ts";

const base = { name: "demo", engines: ["claude"], preset: "custom" };

function withTmpConfig(run: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "navori-deliveries-"));
  try {
    run(join(dir, "navori.config.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Covers: R2, R3
describe("sdd.deliveries", () => {
  it("resolves the defaults 12/1500/4 when the block is absent or partial", () => {
    expect(resolveDeliveryThresholds(NavoriConfigSchema.parse(base))).toEqual({
      splitMinTasks: 12,
      splitMinLoc: 1500,
      maxPrsPerSpec: 4,
    });
    const partial = NavoriConfigSchema.parse({
      ...base,
      sdd: { deliveries: { splitMinLoc: 900 } },
    });
    expect(resolveDeliveryThresholds(partial)).toEqual({ ...DEFAULT_DELIVERIES, splitMinLoc: 900 });
  });

  it("does not materialize defaults when writing the config", () => {
    withTmpConfig((path) => {
      writeConfig(path, { ...base, sdd: { specsDir: "specs" } });
      const onDisk = JSON.parse(readFileSync(path, "utf-8")) as { sdd: Record<string, unknown> };
      expect("deliveries" in onDisk.sdd).toBe(false);
    });
  });

  it.each([
    ["splitMinTasks", 0],
    ["splitMinTasks", 1.5],
    ["splitMinLoc", -3],
    ["splitMinLoc", "many"],
    ["maxPrsPerSpec", 1],
    ["maxPrsPerSpec", 2.5],
  ])("rejects %s=%j with a message naming the field", (field, value) => {
    const result = NavoriConfigSchema.safeParse({
      ...base,
      sdd: { deliveries: { [field]: value } },
    });
    expect(result.success).toBe(false);
    const messages = result.success ? [] : result.error.issues.map((i) => i.message);
    expect(messages.join(" ")).toContain(`sdd.deliveries.${field}`);
  });

  it("accepts maxPrsPerSpec=2 and the block is a known config key", () => {
    withTmpConfig((path) => {
      const raw = { ...base, sdd: { deliveries: { maxPrsPerSpec: 2 } } };
      writeFileSync(path, JSON.stringify(raw));
      expect(resolveDeliveryThresholds(readConfig(path)).maxPrsPerSpec).toBe(2);
      expect(findUnknownConfigKeys(raw)).toEqual([]);
    });
  });
});
