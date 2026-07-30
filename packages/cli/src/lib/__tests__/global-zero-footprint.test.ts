import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

/**
 * Spec 0010 §2.4 — the global harness must be INVISIBLE without an explicit
 * `navori global init`. The load-bearing structural guarantee: the repo-scoped
 * render path never imports the `global-*` modules, so a repo command
 * physically cannot read or write global state. If someone wires a global
 * import into one of these files, this test fails and forces the review.
 *
 * (Behavioural byte-identity is covered transitively: F1 did not touch
 * render-plan / execute-plan / the engine adapters, so every existing render
 * snapshot in the suite still passes unchanged.)
 */
const SRC = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");

const REPO_PATH_FILES = [
  "lib/render-plan.ts",
  "lib/health.ts",
  "engines/shared/execute-plan.ts",
  "engines/shared/harness-plan.ts",
  "engines/claude/adapter.ts",
  "engines/claude/index.ts",
  "engines/claude/build-settings.ts",
  "commands/render.ts",
  "commands/doctor.ts",
  "commands/sync.ts",
  "commands/status.ts",
  "commands/init.ts",
];

describe("Spec 0010 §2.4 — zero footprint without opt-in", () => {
  for (const rel of REPO_PATH_FILES) {
    it(`${rel} does not import the global harness modules`, () => {
      const src = readFileSync(resolve(SRC, rel), "utf-8");
      expect(src).not.toContain("global-config");
      expect(src).not.toContain("global-render");
    });
  }
});
