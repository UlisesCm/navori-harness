import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted((): { invalid: "source" | "agent" | null; missingParser: boolean } => ({
  invalid: null,
  missingParser: false,
}));

vi.mock("node:module", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:module")>();
  return {
    ...actual,
    get stripTypeScriptTypes() {
      return state.missingParser ? undefined : actual.stripTypeScriptTypes;
    },
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

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
import { ownsPiSource, serializePiSource } from "../owned-file.ts";

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
  state.missingParser = false;
  vi.mocked(spawnSync).mockRestore();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Pi generated syntax validation", () => {
  it("validates through Node when the host lacks the TypeScript parser without executing source", () => {
    state.missingParser = true;
    expect(ownsPiSource(serializePiSource('throw new Error("must not execute");'))).toBe(true);
    expect(ownsPiSource(serializePiSource("export const broken = ;"))).toBe(false);
    expect(spawnSync).toHaveBeenCalledWith("node", expect.any(Array), {
      input: expect.any(String),
      timeout: 5_000,
      maxBuffer: 1_048_576,
      windowsHide: true,
    });
  });

  it("fails closed when the fallback cannot start and bounds its input", () => {
    state.missingParser = true;
    vi.mocked(spawnSync).mockImplementationOnce(() => {
      throw new Error("Node unavailable");
    });
    expect(ownsPiSource(serializePiSource("export const valid = 1;"))).toBe(false);
    expect(ownsPiSource(serializePiSource("//" + "x".repeat(1_048_576)))).toBe(false);
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });

  it("validates actual generated Pi resources under Bun", () => {
    const script = `
      import { ownsPiSource, serializePiSource } from "./src/engines/pi/owned-file.ts";
      import { PI_EXTENSION_SOURCE } from "./src/engines/pi/extension-source.ts";
      if (!ownsPiSource(serializePiSource(PI_EXTENSION_SOURCE))) process.exit(1);
      if (ownsPiSource(serializePiSource("export const broken = ;"))) process.exit(2);
    `;
    expect(() => execFileSync("bun", ["--eval", script], { timeout: 15_000 })).not.toThrow();
  });
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
