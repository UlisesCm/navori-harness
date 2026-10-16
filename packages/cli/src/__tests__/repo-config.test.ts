import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readConfig } from "../lib/config/config.ts";
import { fastCoveredByFull } from "../lib/gate/cache.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

describe("this repo's gate chains (spec 0054 T19)", () => {
  const gate = readConfig(resolve(REPO_ROOT, "navori.config.json")).qualityGate;
  const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };

  // Covers: R13
  it("cada paso de fast aparece literal en full", () => {
    expect(gate?.fast).toBeTruthy();
    // `fast` is `bun run check:fast`; its root-script steps are the literal steps of `full`.
    expect(fastCoveredByFull(gate?.fast ?? "", gate?.full ?? "", pkg.scripts)).toBe(true);
    expect(fastCoveredByFull(pkg.scripts["check:fast"] ?? "", gate?.full ?? "")).toBe(true);
  });
});
