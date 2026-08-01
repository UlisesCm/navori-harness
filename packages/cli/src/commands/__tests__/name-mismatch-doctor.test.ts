import { describe, it, expect } from "vitest";
import type { NavoriConfig } from "../../lib/config.ts";
import { scanNameMismatch } from "../doctor.ts";

/**
 * #315: doctor warns when config.name doesn't match the repo directory (a
 * harness copied from another repo whose name was never updated). Twin of the
 * placeholder-name check; informational, never flips `ok`. The scan takes the
 * cwd whose basename is compared, so a synthetic path exercises both branches
 * without touching disk.
 */

function config(name: string): NavoriConfig {
  return { name } as NavoriConfig;
}

describe("scanNameMismatch", () => {
  it("returns null when the directory basename matches config.name", () => {
    expect(scanNameMismatch("/Users/dev/webapp", config("webapp"))).toBeNull();
  });

  it("flags a mismatch, reporting both the config name and the directory", () => {
    expect(scanNameMismatch("/Users/dev/my-real-repo", config("webapp"))).toEqual({
      configName: "webapp",
      dirName: "my-real-repo",
    });
  });

  it("stays silent for a placeholder name (warned separately)", () => {
    // 'temp-app' is a known placeholder — the placeholder check owns that hint.
    expect(scanNameMismatch("/Users/dev/my-real-repo", config("temp-app"))).toBeNull();
  });
});
