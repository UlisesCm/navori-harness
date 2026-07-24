import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { getCoreRoot } from "../bundled-assets.ts";

/**
 * Shape contracts for the three template assets D3 ships:
 *   - core-assets/settings/settings-base.json
 *   - core-assets/hooks/quality-gate-pre-commit.sh
 *   - core-assets/prompts.json
 *
 * The Claude engine adapter (E1) will consume these as-is. These tests
 * catch breaking changes to the contract: missing $navori marker, hook
 * missing the interpolation or the user-section sentinel, prompts.json
 * that doesn't validate against the PromptEntrySchema we shipped in C1.
 */

function readCoreAsset(relPath: string): string {
  const abs = resolve(getCoreRoot(), "core-assets", relPath);
  expect(existsSync(abs), `core asset missing: ${abs}`).toBe(true);
  return readFileSync(abs, "utf-8");
}

describe("settings-base.json", () => {
  const raw = readCoreAsset("settings/settings-base.json");
  let parsed: Record<string, unknown>;
  it("is valid JSON", () => {
    expect(() => {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    }).not.toThrow();
  });

  it("declares $navori.managed === true (detection marker for DT-2)", () => {
    parsed = JSON.parse(raw) as Record<string, unknown>;
    const navori = parsed.$navori as { managed?: boolean; version?: string } | undefined;
    expect(navori).toBeDefined();
    expect(navori?.managed).toBe(true);
    expect(navori?.version).toBe("{{coreVersion}}");
  });

  it("has hooks and permissions skeleton ready for plugin merge", () => {
    parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.hooks).toBeDefined();
    expect(parsed.permissions).toBeDefined();
    const permissions = parsed.permissions as { allow?: string[] };
    expect(Array.isArray(permissions.allow)).toBe(true);
    expect(permissions.allow!.length).toBeGreaterThan(0);
  });
});

describe("quality-gate-pre-commit.sh", () => {
  const raw = readCoreAsset("hooks/quality-gate-pre-commit.sh");

  it("starts with a bash shebang", () => {
    expect(raw.startsWith("#!/usr/bin/env bash\n")).toBe(true);
  });

  it("references {{qualityGate.fast}} for interpolation", () => {
    expect(raw).toContain("{{qualityGate.fast}}");
  });

  it("contains the shell-style user-section sentinel exactly once", () => {
    const matches = raw.match(/^# navori:user-section$/gm);
    expect(matches?.length).toBe(1);
  });

  it("has non-empty managed body before the sentinel", () => {
    const idx = raw.indexOf("\n# navori:user-section");
    expect(idx).toBeGreaterThan(0);
    const managed = raw.slice(0, idx).trim();
    expect(managed.length).toBeGreaterThan(150);
    // Must include the core behavior (match git commit/push)
    expect(managed).toMatch(/git (commit|push)/);
  });

  it("has user-section template after the sentinel", () => {
    const idx = raw.indexOf("\n# navori:user-section");
    const userTpl = raw.slice(idx + 1).trim();
    expect(userTpl.length).toBeGreaterThan(40);
    // Must include guidance about $cmd being available
    expect(userTpl).toMatch(/\$cmd/);
  });
});

describe("prompts.json", () => {
  const raw = readCoreAsset("prompts.json");
  const PromptEntrySchema = z.object({
    key: z.string().regex(/^[a-z][a-zA-Z0-9_.]*$/),
    phase: z.enum(["general", "specific"]).optional(),
    question: z.object({ es: z.string().min(1), en: z.string().min(1) }),
    type: z.enum(["string", "string-list", "boolean", "number", "select"]),
    options: z
      .array(
        z.object({
          value: z.string().min(1),
          label: z.object({ es: z.string().min(1), en: z.string().min(1) }),
        }),
      )
      .optional(),
    placeholder: z.string().optional(),
    optional: z.boolean().default(false),
  });
  const FileSchema = z.object({
    $schema: z.string().optional(),
    description: z.string().optional(),
    prompts: z.array(PromptEntrySchema),
  });

  it("is valid JSON", () => {
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("validates against the FileSchema (mirrors plugins.PromptEntrySchema)", () => {
    const parsed = JSON.parse(raw);
    const result = FileSchema.safeParse(parsed);
    if (!result.success) {
      console.error(result.error.issues);
    }
    expect(result.success).toBe(true);
  });

  it("declares the core project.* prompt keys (2 general + 3 specific)", () => {
    const parsed = JSON.parse(raw) as { prompts: Array<{ key: string; phase?: string }> };
    const keys = parsed.prompts.map((p) => p.key);
    expect(keys).toContain("project.posture");
    expect(keys).toContain("project.reviewRigor");
    expect(keys).toContain("project.architectureRule");
    expect(keys).toContain("project.criticalAreas");
    expect(keys).toContain("project.testsForNewCode");
    // Two-phase split
    const general = parsed.prompts.filter((p) => p.phase === "general").map((p) => p.key);
    expect(general).toEqual(["project.posture", "project.reviewRigor"]);
  });

  it("every prompt has both es and en translations", () => {
    const parsed = JSON.parse(raw) as {
      prompts: Array<{ question: { es?: string; en?: string } }>;
    };
    for (const p of parsed.prompts) {
      expect(p.question.es?.length ?? 0).toBeGreaterThan(0);
      expect(p.question.en?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

describe("managed/cierre-sesion.md", () => {
  const raw = readCoreAsset("managed/cierre-sesion.md");

  it("references the qualityGate.full placeholder", () => {
    expect(raw).toContain("{{qualityGate.full}}");
  });

  it("does not wrap the qualityGate placeholder in backticks", () => {
    // When qualityGate is unset, {{qualityGate.full}} resolves to fallback
    // prose. Inside a code span that prose reads as a runnable command — keep
    // the placeholder out of backticks so the 'no gate' case stays readable.
    expect(raw).not.toContain("`{{qualityGate.full}}`");
  });
});
