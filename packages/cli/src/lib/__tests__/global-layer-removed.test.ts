import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const REMOVED_MODULES = [
  "commands/global.ts",
  "commands/global-prompts.ts",
  "lib/config/global-config.ts",
  "engines/claude/global-render.ts",
  "engines/claude/global-plugin.ts",
  "lib/workspace/global-scope.ts",
  "lib/audit/launchd.ts",
] as const;

describe("global layer retirement (spec 0046)", () => {
  // Covers: R2
  it("los módulos de la capa global no existen", () => {
    for (const rel of REMOVED_MODULES) {
      expect(existsSync(join(SRC, rel)), `${rel} must stay deleted`).toBe(false);
    }
  });
});
