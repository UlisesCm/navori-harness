import { describe, it, expect } from "vitest";
import { writeFileSync, readFileSync, rmSync, mkdtempSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeConfig, readConfig, ConfigError } from "../config.ts";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "navori-test-"));
}

describe("writeConfig", () => {
  it("writes a valid config with defaults applied", () => {
    const dir = makeTmpDir();
    const path = join(dir, "navori.config.json");
    try {
      writeConfig(path, {
        name: "test-project",
        engines: ["claude"],
        preset: "custom",
      });
      const parsed = JSON.parse(readFileSync(path, "utf-8"));
      expect(parsed.name).toBe("test-project");
      expect(parsed.engines).toEqual(["claude"]);
      expect(parsed.version).toBe("1.0.0");
      expect(parsed.commits).toBe("conventional-es");
      expect(parsed.branchBase).toBe("main");
      expect(parsed.$schema).toContain("navori.config.v1.json");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("rejects invalid name (must be kebab-case)", () => {
    const dir = makeTmpDir();
    const path = join(dir, "navori.config.json");
    try {
      expect(() =>
        writeConfig(path, {
          name: "Invalid Name With Spaces",
          engines: ["claude"],
          preset: "custom",
        }),
      ).toThrow();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("writes atomically: no .tmp file remains in the directory", () => {
    const dir = makeTmpDir();
    const path = join(dir, "navori.config.json");
    try {
      writeConfig(path, {
        name: "atomic-test",
        engines: ["claude"],
        preset: "custom",
      });
      const remaining = readdirSync(dir);
      const tmps = remaining.filter((e) => e.includes(".navori.tmp."));
      expect(tmps).toHaveLength(0);
      expect(remaining).toContain("navori.config.json");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("preserves unknown fields through a read/write roundtrip (forward compat)", () => {
    const dir = makeTmpDir();
    const path = join(dir, "navori.config.json");
    try {
      // Simulate a config written by a future version of navori
      writeFileSync(
        path,
        JSON.stringify({
          $schema: "https://navori.dev/schema/navori.config.v1.json",
          name: "future-app",
          engines: ["claude"],
          preset: "custom",
          // Fields unknown to v0.1
          futureFeature: { enabled: true, settings: { x: 1 } },
          customTeamField: "internal",
        }),
        "utf-8",
      );
      const config = readConfig(path);
      // The known fields validate
      expect(config.name).toBe("future-app");
      // Unknown fields survive in the parsed object
      expect((config as unknown as { futureFeature: unknown }).futureFeature).toEqual({
        enabled: true,
        settings: { x: 1 },
      });
      // Round-trip: writing preserves them
      writeConfig(path, config);
      const reread = JSON.parse(readFileSync(path, "utf-8"));
      expect(reread.futureFeature).toEqual({ enabled: true, settings: { x: 1 } });
      expect(reread.customTeamField).toBe("internal");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("rejects unknown engine", () => {
    const dir = makeTmpDir();
    const path = join(dir, "navori.config.json");
    try {
      expect(() =>
        writeConfig(path, {
          name: "test",
          // @ts-expect-error: testing runtime validation
          engines: ["unknown-engine"],
          preset: "custom",
        }),
      ).toThrow();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("accepts every MonorepoTool that detect.ts can return", () => {
    const dir = makeTmpDir();
    const path = join(dir, "navori.config.json");
    try {
      for (const tool of ["pnpm", "turbo", "nx", "rush", "lerna", "npm"] as const) {
        writeConfig(path, {
          name: `mono-${tool}`,
          engines: ["claude"],
          preset: "custom",
          monorepo: { enabled: true, tool, workspaces: [] },
        });
        const cfg = readConfig(path);
        expect(cfg.monorepo?.tool).toBe(tool);
        rmSync(path);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts a `project` block with defaults and preserves custom keys (passthrough)", () => {
    const dir = makeTmpDir();
    const path = join(dir, "navori.config.json");
    try {
      writeConfig(path, {
        name: "test",
        engines: ["claude"],
        preset: "custom",
        project: {
          legacyPaths: ["src/legacy"],
          criticalAreas: ["src/auth"],
          testRunner: "vitest",
          // Custom key contributed by a plugin prompt — must survive
          customRule: "no-default-export",
        } as never,
      });
      const cfg = readConfig(path);
      expect(cfg.project?.legacyPaths).toEqual(["src/legacy"]);
      expect(cfg.project?.testRunner).toBe("vitest");
      expect((cfg.project as unknown as { customRule: string }).customRule).toBe(
        "no-default-export",
      );
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("project field is optional", () => {
    const dir = makeTmpDir();
    const path = join(dir, "navori.config.json");
    try {
      writeConfig(path, {
        name: "no-project",
        engines: ["claude"],
        preset: "custom",
      });
      const cfg = readConfig(path);
      expect(cfg.project).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("rejects unknown model in models override", () => {
    const dir = makeTmpDir();
    const path = join(dir, "navori.config.json");
    try {
      expect(() =>
        writeConfig(path, {
          name: "test",
          engines: ["claude"],
          preset: "custom",
          // @ts-expect-error: testing runtime validation
          models: { reviewer: "gpt4" },
        }),
      ).toThrow();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("readConfig", () => {
  it("reads and validates a written config", () => {
    const dir = makeTmpDir();
    const path = join(dir, "navori.config.json");
    try {
      writeConfig(path, {
        name: "valid",
        engines: ["claude", "agents-md"],
        preset: "custom",
      });
      const config = readConfig(path);
      expect(config.name).toBe("valid");
      expect(config.engines).toContain("agents-md");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("throws ConfigError on missing file", () => {
    const dir = makeTmpDir();
    const path = join(dir, "missing.json");
    try {
      expect(() => readConfig(path)).toThrow(ConfigError);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("throws ConfigError on invalid JSON", () => {
    const dir = makeTmpDir();
    const path = join(dir, "navori.config.json");
    try {
      writeFileSync(path, "not valid json{", "utf-8");
      expect(() => readConfig(path)).toThrow(ConfigError);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("throws ConfigError on schema mismatch with issues list", () => {
    const dir = makeTmpDir();
    const path = join(dir, "navori.config.json");
    try {
      writeFileSync(path, JSON.stringify({ name: 42, engines: ["claude"] }), "utf-8");
      try {
        readConfig(path);
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as ConfigError).issues).toBeDefined();
        expect((err as ConfigError).issues!.length).toBeGreaterThan(0);
      }
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
