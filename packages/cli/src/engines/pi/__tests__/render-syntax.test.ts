import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted((): { invalid: "source" | "agent" | null } => ({ invalid: null }));

vi.mock("../owned-file.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../owned-file.ts")>();
  return {
    ...actual,
    serializePiSource: (source: string): string =>
      actual.serializePiSource(state.invalid === "source" ? "export const broken = ;" : source),
    serializePiAgent: (input: Parameters<typeof actual.serializePiAgent>[0]): string => {
      const valid = actual.serializePiAgent(input);
      if (state.invalid !== "agent") return valid;
      const malformed = valid.replace(/^tools: .+$/m, "tools: [broken");
      const marker = /^---\n# navori:managed-file id="pi-agent-[a-z-]+" hash="[a-f0-9]{64}"\n/.exec(
        malformed,
      );
      if (!marker) throw new Error("Test fixture lacks Pi ownership marker");
      const hash = createHash("sha256").update(malformed.slice(marker[0].length)).digest("hex");
      return malformed.replace(/hash="[a-f0-9]{64}"/, `hash="${hash}"`);
    },
  };
});

import { NavoriConfigSchema } from "../../../lib/config/schema.ts";
import { renderPiEngine } from "../index.ts";

const dirs: string[] = [];
const config = NavoriConfigSchema.parse({
  name: "pi-syntax-test",
  preset: "custom",
  engines: ["pi"],
  branchBase: "main",
  qualityGate: { fast: "bun test", full: "bun test" },
});

afterEach(() => {
  state.invalid = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Pi generated syntax validation", () => {
  // Covers: R6
  it.each(["source", "agent"] as const)(
    "rejects correctly hashed invalid %s before any write",
    (kind) => {
      const dir = mkdtempSync(join(tmpdir(), "navori-pi-syntax-"));
      dirs.push(dir);
      state.invalid = kind;
      expect(() => renderPiEngine(dir, config)).toThrow(/Generated Pi resource failed validation/);
      expect(existsSync(join(dir, ".pi"))).toBe(false);
    },
  );
});
